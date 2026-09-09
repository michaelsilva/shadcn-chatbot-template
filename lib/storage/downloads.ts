import { getAsset, isAssetUsable } from "../db/assets"
import { createPresignedUrl } from "./core"
import { signingConfig, type StorageEnv } from "./env"

const DOWNLOAD_URL_EXPIRY_SECONDS = 5 * 60

export type DownloadUrlResult =
  | { outcome: "ok"; url: string; expiresInSeconds: number }
  | { outcome: "not-found" }
  | { outcome: "not-usable" }

/**
 * Mints a short-lived presigned GET for a private asset (#7). Never
 * makes the bucket/object public — authorization happens here, against
 * the owner-scoped D1 row, before any URL is generated.
 */
export async function createDownloadUrl(
  env: StorageEnv,
  input: { ownerId: string; assetId: string; bucketName: string }
): Promise<DownloadUrlResult> {
  const asset = await getAsset(env, { ownerId: input.ownerId, assetId: input.assetId })
  if (!asset) return { outcome: "not-found" }
  if (!isAssetUsable(asset)) return { outcome: "not-usable" }

  const url = await createPresignedUrl(signingConfig(env, input.bucketName), {
    method: "GET",
    key: asset.r2_object_key,
    expiresInSeconds: DOWNLOAD_URL_EXPIRY_SECONDS,
  })

  return { outcome: "ok", url, expiresInSeconds: DOWNLOAD_URL_EXPIRY_SECONDS }
}
