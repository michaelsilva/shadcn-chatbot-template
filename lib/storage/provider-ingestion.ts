import { createAsset, getAsset, markAssetUploadState, type AssetRow, type AssetSource } from "../db/assets"
import { newId } from "../db/ids"
import { buildAssetObjectKey, isAllowedMime, type ArtifactKind } from "./core"
import type { AssetBucketEnv } from "./env"

export type ProviderIngestionResult =
  | { outcome: "ingested"; asset: AssetRow }
  | { outcome: "already-ingested"; asset: AssetRow }
  | { outcome: "rejected"; reason: string }

/**
 * Copies a provider's transient result URL into R2 and finalizes the
 * D1 asset record (#7's "Server/provider ingestion" flow). The
 * provider URL is never the durable reference — once this returns, only
 * the R2 object and the D1 asset id are.
 *
 * Idempotent under Cloudflare Workflow step retry: pass a stable `id`
 * (e.g. derived from the step/attempt) and a retried call finds the
 * existing row via `createAsset`'s `ON CONFLICT (id) DO NOTHING` rather
 * than creating a duplicate logical asset, and re-copying the same
 * bytes to the same R2 key is a safe no-op overwrite.
 */
export async function ingestProviderAsset(
  env: AssetBucketEnv,
  input: {
    ownerId: string
    sourceUrl: string
    artifactKind: ArtifactKind
    representation?: string
    source?: Extract<AssetSource, "generated" | "provider-imported">
    id?: string
    fetchImpl?: typeof fetch
  }
): Promise<ProviderIngestionResult> {
  const doFetch = input.fetchImpl ?? fetch
  const assetId = input.id ?? newId("asset")
  const key = buildAssetObjectKey(input.ownerId, assetId, input.representation ?? "original")

  const existing = await getAsset(env, { ownerId: input.ownerId, assetId })
  if (existing?.upload_state === "finalized") {
    return { outcome: "already-ingested", asset: existing }
  }

  const response = await doFetch(input.sourceUrl)
  if (!response.ok || !response.body) {
    return { outcome: "rejected", reason: `Provider fetch failed with status ${response.status}.` }
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim()
  // The provider's declared content-type is validated here, not just
  // assumed from what the caller expected — an unexpected artifact type
  // fails ingestion rather than being written to R2 and rendered blindly.
  if (!contentType || !isAllowedMime(input.artifactKind, contentType)) {
    return {
      outcome: "rejected",
      reason: `Provider content-type ${contentType ?? "(missing)"} is not allowed for artifact kind ${input.artifactKind}.`,
    }
  }

  const pending =
    existing ??
    (await createAsset(env, {
      id: assetId,
      ownerId: input.ownerId,
      r2ObjectKey: key,
      artifactKind: input.artifactKind,
      source: input.source ?? "generated",
      mimeType: contentType,
      uploadState: "pending",
    }))

  await env.ASSETS_BUCKET.put(key, response.body, {
    httpMetadata: { contentType },
  })

  const object = await env.ASSETS_BUCKET.head(key)
  await markAssetUploadState(env, {
    ownerId: input.ownerId,
    assetId: pending.id,
    uploadState: "finalized",
    byteSize: object?.size,
  })

  const finalized = await getAsset(env, { ownerId: input.ownerId, assetId: pending.id })
  return { outcome: "ingested", asset: finalized! }
}
