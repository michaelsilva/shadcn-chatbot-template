import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { createAsset } from "../../lib/db/assets"
import { getOrCreateOwner } from "../../lib/db/owners"
import { buildAssetObjectKey } from "../../lib/storage/core"
import { createDownloadUrl } from "../../lib/storage/downloads"

const BUCKET = "shadcn-chatbot-assets"

describe("download authorization", () => {
  it("mints a presigned GET only for a finalized asset owned by the requester", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "downloads" })
    const other = await getOrCreateOwner(env, { authProvider: "test", authSubject: "downloads-other" })

    const key = buildAssetObjectKey(owner.id, "asset_fixture_1", "original.png")
    const asset = await createAsset(env, {
      id: "asset_fixture_1",
      ownerId: owner.id,
      r2ObjectKey: key,
      artifactKind: "image",
      source: "upload",
      mimeType: "image/png",
      uploadState: "finalized",
    })

    const ok = await createDownloadUrl(env, { ownerId: owner.id, assetId: asset.id, bucketName: BUCKET })
    expect(ok.outcome).toBe("ok")
    expect(ok.outcome === "ok" && ok.url).toContain(`/${BUCKET}/${key}`)

    // A different owner id gets no URL at all, not just a "forbidden" URL.
    const wrongOwner = await createDownloadUrl(env, {
      ownerId: other.id,
      assetId: asset.id,
      bucketName: BUCKET,
    })
    expect(wrongOwner.outcome).toBe("not-found")
  })

  it("refuses to authorize a download for a still-pending (unverified) asset", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "downloads-pending" })
    const asset = await createAsset(env, {
      ownerId: owner.id,
      r2ObjectKey: buildAssetObjectKey(owner.id, "asset_fixture_2", "original.png"),
      id: "asset_fixture_2",
      artifactKind: "image",
      source: "upload",
      mimeType: "image/png",
      uploadState: "pending",
    })

    const result = await createDownloadUrl(env, {
      ownerId: owner.id,
      assetId: asset.id,
      bucketName: BUCKET,
    })
    expect(result.outcome).toBe("not-usable")
  })
})
