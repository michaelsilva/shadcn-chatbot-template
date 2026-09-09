import { createAsset, getAsset, markAssetUploadState, type AssetRow } from "../db/assets"
import { newId } from "../db/ids"
import {
  SINGLE_PUT_MAX_BYTES,
  assertAllowedMime,
  buildAssetObjectKey,
  createPresignedUrl,
  type ArtifactKind,
} from "./core"
import { signingConfig, type AssetBucketEnv, type StorageEnv } from "./env"

const UPLOAD_URL_EXPIRY_SECONDS = 15 * 60

export interface UploadIntent {
  asset: AssetRow
  uploadUrl: string
  expiresInSeconds: number
}

/**
 * The authenticated short-lived presigned-PUT flow (#7): validates
 * owner/type/size, creates a *pending* D1 asset row at a server-owned
 * key, and returns a presigned PUT restricted to that exact key. The
 * browser uploads directly to R2 — the Worker never proxies the bytes.
 */
export async function createUploadIntent(
  env: StorageEnv,
  input: {
    ownerId: string
    bucketName: string
    artifactKind: ArtifactKind
    mimeType: string
    byteSize: number
    representation?: string
  }
): Promise<UploadIntent> {
  assertAllowedMime(input.artifactKind, input.mimeType)

  if (input.byteSize > SINGLE_PUT_MAX_BYTES) {
    throw new Error(
      `Upload of ${input.byteSize} bytes exceeds the ${SINGLE_PUT_MAX_BYTES}-byte single-PUT ceiling; use the multipart upload flow instead.`
    )
  }
  if (input.byteSize <= 0) {
    throw new Error("Upload byteSize must be positive.")
  }

  // The asset id is generated up front (rather than left to createAsset)
  // so the R2 key — and therefore the unique `r2_object_key` column —
  // is known before the row is ever inserted. No placeholder value ever
  // touches the unique index.
  const assetId = newId("asset")
  const key = buildAssetObjectKey(input.ownerId, assetId, input.representation ?? "original")

  const asset = await createAsset(env, {
    id: assetId,
    ownerId: input.ownerId,
    r2ObjectKey: key,
    artifactKind: input.artifactKind,
    source: "upload",
    mimeType: input.mimeType,
    uploadState: "pending",
  })

  const uploadUrl = await createPresignedUrl(signingConfig(env, input.bucketName), {
    method: "PUT",
    key,
    expiresInSeconds: UPLOAD_URL_EXPIRY_SECONDS,
    contentType: input.mimeType,
  })

  return { asset, uploadUrl, expiresInSeconds: UPLOAD_URL_EXPIRY_SECONDS }
}

export type FinalizeUploadResult =
  | { outcome: "finalized"; asset: AssetRow }
  | { outcome: "not-found-in-r2" }
  | { outcome: "already-finalized"; asset: AssetRow }

/**
 * Verifies the R2 object actually exists before the asset becomes
 * usable (#7) — the browser's claim that it finished uploading is
 * never trusted on its own.
 */
export async function finalizeUpload(
  env: AssetBucketEnv,
  input: { ownerId: string; assetId: string }
): Promise<FinalizeUploadResult> {
  const asset = await getAsset(env, { ownerId: input.ownerId, assetId: input.assetId })
  if (!asset) {
    throw new Error(`Cannot finalize unknown asset ${input.assetId}.`)
  }
  if (asset.upload_state === "finalized") {
    return { outcome: "already-finalized", asset }
  }

  const object = await env.ASSETS_BUCKET.head(asset.r2_object_key)
  if (!object) {
    return { outcome: "not-found-in-r2" }
  }

  // R2's ETag is not a universal content hash (multipart vs single-PUT
  // ETags differ) — it's transport metadata only, never written to the
  // `checksum` column. See #7's checksum/ETag doctrine.
  await markAssetUploadState(env, {
    ownerId: input.ownerId,
    assetId: input.assetId,
    uploadState: "finalized",
    byteSize: object.size,
  })

  const finalized = await getAsset(env, { ownerId: input.ownerId, assetId: input.assetId })
  return { outcome: "finalized", asset: finalized! }
}
