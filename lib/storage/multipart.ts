import { createAsset, getAsset, markAssetUploadState, type AssetRow } from "../db/assets"
import { newId } from "../db/ids"
import { assertAllowedMime, buildAssetObjectKey, type ArtifactKind } from "./core"
import type { AssetBucketEnv } from "./env"

/**
 * Large/resumable uploads (#7) — video and other big media should never
 * be forced through a single Worker request. This uses the R2 binding's
 * native multipart API directly (`createMultipartUpload`/`uploadPart`/
 * `complete`/`abort`) rather than S3-presigned per-part URLs: each part
 * is a small, independently retryable request mediated by a controlled
 * API route instead of one giant body, which is what #7 actually asks
 * for ("issue/mediate part uploads through a controlled API").
 *
 * Each call resumes the upload by `(key, uploadId)` rather than holding
 * a live `R2MultipartUpload` object across requests, since a Worker
 * request doesn't outlive its own invocation.
 */

export async function initiateMultipartUpload(
  env: AssetBucketEnv,
  input: {
    ownerId: string
    artifactKind: ArtifactKind
    mimeType: string
    representation?: string
  }
): Promise<{ asset: AssetRow; uploadId: string; key: string }> {
  assertAllowedMime(input.artifactKind, input.mimeType)

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

  const multipartUpload = await env.ASSETS_BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: input.mimeType },
  })

  return { asset, uploadId: multipartUpload.uploadId, key }
}

export interface UploadedPart {
  partNumber: number
  etag: string
}

/** A failed part can be retried independently (#7) — this call is naturally idempotent per part number. */
export async function uploadMultipartPart(
  env: AssetBucketEnv,
  input: {
    key: string
    uploadId: string
    partNumber: number
    body: ReadableStream | ArrayBuffer | ArrayBufferView
  }
): Promise<UploadedPart> {
  const upload = env.ASSETS_BUCKET.resumeMultipartUpload(input.key, input.uploadId)
  const part = await upload.uploadPart(input.partNumber, input.body)
  return { partNumber: input.partNumber, etag: part.etag }
}

export async function completeMultipartUpload(
  env: AssetBucketEnv,
  input: { ownerId: string; assetId: string; key: string; uploadId: string; parts: UploadedPart[] }
): Promise<AssetRow> {
  const upload = env.ASSETS_BUCKET.resumeMultipartUpload(input.key, input.uploadId)
  await upload.complete(input.parts)

  const object = await env.ASSETS_BUCKET.head(input.key)
  await markAssetUploadState(env, {
    ownerId: input.ownerId,
    assetId: input.assetId,
    uploadState: "finalized",
    byteSize: object?.size,
  })

  const asset = await getAsset(env, { ownerId: input.ownerId, assetId: input.assetId })
  return asset!
}

export async function abortMultipartUpload(
  env: AssetBucketEnv,
  input: { ownerId: string; assetId: string; key: string; uploadId: string }
): Promise<void> {
  const upload = env.ASSETS_BUCKET.resumeMultipartUpload(input.key, input.uploadId)
  await upload.abort()
  await markAssetUploadState(env, {
    ownerId: input.ownerId,
    assetId: input.assetId,
    uploadState: "failed",
  })
}
