import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { createAsset, getAsset } from "../../lib/db/assets"
import { getOrCreateOwner } from "../../lib/db/owners"
import { buildAssetObjectKey } from "../../lib/storage/core"
import { deleteAsset } from "../../lib/storage/deletion"

describe("asset deletion", () => {
  it("tombstones D1 and removes the R2 object, idempotently across retries", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "deletion" })
    const key = buildAssetObjectKey(owner.id, "asset_delete_1", "original.png")
    const asset = await createAsset(env, {
      id: "asset_delete_1",
      ownerId: owner.id,
      r2ObjectKey: key,
      artifactKind: "image",
      source: "upload",
      mimeType: "image/png",
      uploadState: "finalized",
    })
    await env.ASSETS_BUCKET.put(key, new Uint8Array(10))

    const first = await deleteAsset(env, { ownerId: owner.id, assetId: asset.id })
    expect(first).toBe("deleted")

    const row = await getAsset(env, { ownerId: owner.id, assetId: asset.id })
    expect(row?.deleted_at).not.toBeNull()
    expect(await env.ASSETS_BUCKET.head(key)).toBeNull()

    // A retried/duplicate delete call (e.g. a double-clicked delete button) is a safe no-op.
    const second = await deleteAsset(env, { ownerId: owner.id, assetId: asset.id })
    expect(second).toBe("already-deleted")
  })

  it("reports not-found for an asset that doesn't exist or isn't owned by the caller", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "deletion-missing" })
    const result = await deleteAsset(env, { ownerId: owner.id, assetId: "asset_never_existed" })
    expect(result).toBe("not-found")
  })
})
