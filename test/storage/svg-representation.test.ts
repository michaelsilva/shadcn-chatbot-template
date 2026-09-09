import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { addAssetRelation, createAsset } from "../../lib/db/assets"
import { getOrCreateOwner } from "../../lib/db/owners"
import { buildAssetObjectKey } from "../../lib/storage/core"

describe("SVG original vs. safe preview representation", () => {
  it("stores the untrusted SVG source and its sanitized raster preview as distinct R2 objects/assets, linked by lineage", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "svg-representation" })

    // The original SVG source is never directly trusted for inline DOM
    // rendering (#7/#18) — it gets its own asset/object.
    const originalKey = buildAssetObjectKey(owner.id, "asset_svg_original", "original.svg")
    const original = await createAsset(env, {
      id: "asset_svg_original",
      ownerId: owner.id,
      r2ObjectKey: originalKey,
      artifactKind: "svg",
      representation: "vector",
      source: "generated",
      mimeType: "image/svg+xml",
      uploadState: "finalized",
    })

    // The sanitized/rendered preview is a *separate*, distinct object —
    // never the same R2 key as the original, never overwriting it.
    const previewKey = buildAssetObjectKey(owner.id, "asset_svg_preview", "preview.png")
    const preview = await createAsset(env, {
      id: "asset_svg_preview",
      ownerId: owner.id,
      r2ObjectKey: previewKey,
      artifactKind: "image",
      representation: "raster",
      source: "preview",
      mimeType: "image/png",
      uploadState: "finalized",
    })

    expect(original.r2_object_key).not.toBe(preview.r2_object_key)
    expect(original.mime_type).toBe("image/svg+xml")
    expect(preview.mime_type).toBe("image/png")

    await addAssetRelation(env, {
      sourceAssetId: original.id,
      targetAssetId: preview.id,
      relationKind: "preview-of",
    })

    const relation = await env.DB.prepare(
      `SELECT relation_kind FROM asset_relations WHERE source_asset_id = ?1 AND target_asset_id = ?2`
    )
      .bind(original.id, preview.id)
      .first<{ relation_kind: string }>()
    expect(relation?.relation_kind).toBe("preview-of")
  })
})
