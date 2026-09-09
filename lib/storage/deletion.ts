import { getAsset, softDeleteAsset } from "../db/assets"
import type { AssetBucketEnv } from "./env"

export type DeleteAssetResult = "deleted" | "already-deleted" | "not-found"

/**
 * Tombstones the D1 row *before* touching R2 (#7), so a provider
 * callback or retried finalize that arrives mid-delete sees a deleted
 * asset and can reject/no-op rather than racing the delete. R2 delete
 * of an already-missing key is a no-op, so this is safe to retry.
 */
export async function deleteAsset(
  env: AssetBucketEnv,
  input: { ownerId: string; assetId: string }
): Promise<DeleteAssetResult> {
  const asset = await getAsset(env, { ownerId: input.ownerId, assetId: input.assetId })
  if (!asset) return "not-found"
  if (asset.deleted_at !== null) {
    // Still attempt the R2 delete in case a previous attempt tombstoned
    // the row but was interrupted before the object was removed.
    await env.ASSETS_BUCKET.delete(asset.r2_object_key)
    return "already-deleted"
  }

  await softDeleteAsset(env, { ownerId: input.ownerId, assetId: input.assetId })
  await env.ASSETS_BUCKET.delete(asset.r2_object_key)
  return "deleted"
}
