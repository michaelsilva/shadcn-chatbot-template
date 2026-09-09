# R2 asset storage

Issue #7 makes Cloudflare R2 the canonical binary/object store. D1 (#6) owns asset metadata, ownership, and lineage; R2 owns bytes; the D1 asset id — never a filename, provider URL, or R2 key — is what the rest of the app refers to.

## Provisioned Cloudflare configuration

- One private bucket, `shadcn-chatbot-assets` (#25). No `r2.dev` public access is configured — it was never enabled.
- CORS (`config/r2-cors.json`, applied via `wrangler r2 bucket cors set shadcn-chatbot-assets --file ./config/r2-cors.json`): `AllowedOrigins` is `http://localhost:3000`/`http://127.0.0.1:3000` only (no `*`), `AllowedMethods` is `PUT, GET, HEAD` only — **not** `DELETE`, because deletion always goes through an authorized server route using the R2 binding, never a browser-direct presigned DELETE — and `AllowedHeaders` is `content-type` only. Add the real production origin to `config/r2-cors.json` and re-run the `cors set` command once a deployment domain exists.
- R2 API token (Access Key ID/Secret Access Key) for S3-compatible presigning is **not** provisioned by this change — see "Required secrets" below. Provisioning a credential is a deploy-time decision, not something to script blindly ahead of an actual deployment.

## Why presigned URLs need a separate credential from the R2 Workers binding

The `env.ASSETS_BUCKET` binding (`R2Bucket`) lets a Worker read/write/delete objects directly, but it cannot mint a presigned URL — that's an S3-compatible-API operation requiring an R2 API token (Access Key ID/Secret Access Key) and AWS SigV4 signing, done via [`aws4fetch`](https://github.com/mhart/aws4fetch) (Cloudflare's own documented approach; a ~2 KB, zero-dependency library purpose-built for this). Signing is a **pure, local, offline computation** — it never calls R2 — which is why `lib/storage/core.ts` (key construction, MIME allowlisting, presigning) is covered by `pnpm storage:contract`, the same dependency-light `tsc`+`node` pattern used elsewhere in this repo, with no live credentials or network access required.

Everything that touches the R2 *binding* directly (`head`/`put`/`delete`/multipart) is covered instead by `pnpm db:test`'s Miniflare-simulated R2 bucket (`test/wrangler.jsonc`), the same `@cloudflare/vitest-plugin` harness #6 established for D1.

## Required secrets

Set these via `wrangler secret put` once you're ready to deploy — never commit them:

```sh
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

Create the token scoped to the `shadcn-chatbot-assets` bucket only (not account-wide R2 access): https://developers.cloudflare.com/r2/api/tokens/. For local `wrangler dev`/`next dev` work, copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill in real values. `CLOUDFLARE_ACCOUNT_ID` and `ASSETS_BUCKET_NAME` are non-secret and already committed as `vars` in `wrangler.jsonc`.

`lib/storage/env.ts`'s `requireStorageEnv()` throws a clear configuration error — matching `lib/atomic-executor.ts`'s `requireEnvString` pattern — rather than letting a missing token surface as an obscure signing failure. Only the two functions that actually presign a URL (`createUploadIntent`, `createDownloadUrl`) need it; everything else (`finalizeUpload`, `deleteAsset`, `ingestProviderAsset`, the multipart functions) only needs the plain `ASSETS_BUCKET` binding.

## Asset identity and key shape

`lib/storage/core.ts`'s `buildAssetObjectKey(ownerId, assetId, representation)` is the **only** place an R2 object key is constructed:

```text
owners/<owner-id>/assets/<asset-id>/<representation>
```

Every id/representation segment is validated against a safe-character allowlist — path traversal (`../`) or a slash anywhere in an id is rejected outright, so a key can never escape its owner's prefix. The browser never supplies a raw key.

## Upload flow (small/medium, presigned PUT)

`lib/storage/uploads.ts`:

1. `createUploadIntent()` validates the declared MIME against `lib/storage/core.ts`'s per-artifact-kind allowlist (raster and SVG are deliberately separate lists — never interchangeable, matching #4's doctrine) and the declared size against `SINGLE_PUT_MAX_BYTES` (100 MB, Cloudflare's documented ordinary-PUT guidance). It generates the asset id *before* creating the D1 row, so the row's `r2_object_key` — which is `UNIQUE` — is always the real key, never a placeholder that could collide.
2. It creates a **pending** asset row (`upload_state: "pending"`, #7's asset-usability tracking added in migration `0003`) and returns a presigned PUT restricted to that exact key, bucket, and content-type, expiring in 15 minutes.
3. The browser PUTs directly to R2. The Worker never sees the bytes.
4. `finalizeUpload()` calls `env.ASSETS_BUCKET.head()` to verify the object is actually there before flipping `upload_state` to `"finalized"` — the browser's claim that it finished is never trusted alone. Finalizing twice is a safe no-op (`{ outcome: "already-finalized" }`), and finalizing before the object exists returns `{ outcome: "not-found-in-r2" }` rather than a false success.

Wired to `POST /api/assets/upload-intent` and `POST /api/assets/:id/finalize`.

## Download flow (private, presigned GET)

`lib/storage/downloads.ts`'s `createDownloadUrl()` looks up the asset through the owner-scoped `getAsset()` (#6) — a wrong owner id gets `{ outcome: "not-found" }`, not a URL — and refuses a still-pending or deleted asset (`{ outcome: "not-usable" }`) before ever generating a URL. The bucket itself is never made public; only a short-lived (5 minute), single-object GET is issued. Wired to `GET /api/assets/:id/download`.

## Deletion

`lib/storage/deletion.ts`'s `deleteAsset()` tombstones the D1 row (`deleted_at`) **before** touching R2, so a provider callback or retried finalize that arrives mid-delete sees a deleted asset and can reject/no-op instead of racing the delete. `env.ASSETS_BUCKET.delete()` of an already-missing key is a no-op, so a retried/duplicate delete call is safe. Wired to `DELETE /api/assets/:id`.

## Provider ingestion

`lib/storage/provider-ingestion.ts`'s `ingestProviderAsset()` is the "server/provider ingestion" flow from #7: fetch a provider's transient result URL, validate its *actual* response `content-type` against the allowlist (never just the caller's assumption — an unexpected artifact type is rejected rather than written to R2 and rendered blindly), copy the bytes to R2, and finalize the D1 asset. It accepts an injectable `fetchImpl` for testing and a stable `id` for idempotency: a retried Cloudflare Workflow `step.do()` (see #25) finds the existing asset via `createAsset`'s `ON CONFLICT (id) DO NOTHING` rather than creating a duplicate logical asset, and re-copying identical bytes to the same key is a safe overwrite. The provider URL itself is never stored as the durable reference — only the R2 key survives past this call.

## Multipart upload (large/resumable media)

`lib/storage/multipart.ts` uses the R2 binding's native multipart API (`createMultipartUpload`/`uploadPart`/`complete`/`abort`) directly rather than S3-presigned per-part URLs: each part is mediated through a controlled server route instead of forcing a multi-gigabyte body through one Worker request, which is what #7 actually asks for. Each call resumes the upload by `(key, uploadId)` rather than holding a live `R2MultipartUpload` handle across requests, since a Worker invocation doesn't outlive itself. `completeMultipartUpload()` finalizes the D1 asset the same way the single-PUT flow does; `abortMultipartUpload()` marks the asset `"failed"`. Not yet wired to HTTP routes — the client-side chunking/retry UI this needs belongs with #8's actual upload experience, not this issue's storage-layer proof.

## SVG original vs. safe preview

An SVG original and its sanitized raster preview are always two distinct assets/R2 objects — never the same key, never an overwrite — linked via #6's `asset_relations` with `relation_kind: "preview-of"`. The SVG source is never treated as trusted-for-inline-rendering HTML; that sanitization/isolation step belongs to #18.

## Checksums and ETags

R2's ETag is deliberately **never** written to the `checksum` column — multipart-upload ETags aren't comparable to single-PUT ETags, so treating either as a universal content hash would be a latent correctness bug. `byte_size` (from a real `head()`/multipart-complete call, not the browser's claim) is what gets recorded; an application-computed content hash can be added later if deduplication needs it.

## What #7 deliberately does not do

- No multipart HTTP API routes (client-side chunking UI is #8's job).
- No document/3D-specific ingestion pipelines (#22/#23 own those workflows; this issue only proves the storage primitives they'll call).
- No real R2 API token was provisioned or committed — that's an explicit deploy-time step (`wrangler secret put`), consistent with #25's "no `wrangler deploy` was run" boundary.
- No lifecycle rules for abandoned multipart uploads — R2's default 7-day automatic abort already covers this; nothing here needed to duplicate it.
