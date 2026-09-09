import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { addAssetRelation, createAsset, listDerivedAssets, listSourceAssets } from "../../lib/db/assets"
import { getOrCreateOwner } from "../../lib/db/owners"

describe("assets and asset_relations", () => {
  it("records graph-style source -> derived lineage in both directions", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "assets" })

    const original = await createAsset(env, {
      ownerId: owner.id,
      r2ObjectKey: `owners/${owner.id}/uploads/original.png`,
      artifactKind: "image",
      source: "upload",
      mimeType: "image/png",
    })
    const upscaled = await createAsset(env, {
      ownerId: owner.id,
      r2ObjectKey: `owners/${owner.id}/derived/upscaled.png`,
      artifactKind: "image",
      source: "derived",
      mimeType: "image/png",
    })
    const preview = await createAsset(env, {
      ownerId: owner.id,
      r2ObjectKey: `owners/${owner.id}/derived/upscaled-preview.jpg`,
      artifactKind: "image",
      source: "preview",
      mimeType: "image/jpeg",
    })

    await addAssetRelation(env, {
      sourceAssetId: original.id,
      targetAssetId: upscaled.id,
      relationKind: "derived-from",
    })
    await addAssetRelation(env, {
      sourceAssetId: upscaled.id,
      targetAssetId: preview.id,
      relationKind: "preview-of",
    })

    // A duplicate relation (e.g. a retried ingestion step) must not create a second row.
    await addAssetRelation(env, {
      sourceAssetId: original.id,
      targetAssetId: upscaled.id,
      relationKind: "derived-from",
    })

    const derivedFromOriginal = await listDerivedAssets(env, original.id)
    expect(derivedFromOriginal).toHaveLength(1)
    expect(derivedFromOriginal[0]).toMatchObject({
      target_asset_id: upscaled.id,
      relation_kind: "derived-from",
    })

    const sourcesOfPreview = await listSourceAssets(env, preview.id)
    expect(sourcesOfPreview).toHaveLength(1)
    expect(sourcesOfPreview[0]).toMatchObject({
      source_asset_id: upscaled.id,
      relation_kind: "preview-of",
    })
  })
})
