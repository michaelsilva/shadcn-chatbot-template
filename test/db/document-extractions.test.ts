import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { createAsset } from "../../lib/db/assets"
import {
  INLINE_EXTRACTION_CONTENT_LIMIT,
  createDocumentExtraction,
} from "../../lib/db/document-extractions"
import { getOrCreateOwner } from "../../lib/db/owners"

describe("document_extractions large-body boundary", () => {
  it("stores small extracted text inline", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "extractions" })
    const source = await createAsset(env, {
      ownerId: owner.id,
      r2ObjectKey: `owners/${owner.id}/uploads/brief.pdf`,
      artifactKind: "file",
      source: "upload",
      mimeType: "application/pdf",
    })

    const extraction = await createDocumentExtraction(env, {
      sourceAssetId: source.id,
      extractionMethod: "toMarkdown",
      content: "# Brief\n\nShort extracted content.",
    })
    expect(extraction.content).toContain("Short extracted content")
    expect(extraction.char_count).toBe("# Brief\n\nShort extracted content.".length)
  })

  it("refuses to inline content over the limit, requiring an R2-backed content asset instead", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "extractions-large" })
    const source = await createAsset(env, {
      ownerId: owner.id,
      r2ObjectKey: `owners/${owner.id}/uploads/large.pdf`,
      artifactKind: "file",
      source: "upload",
      mimeType: "application/pdf",
    })

    const oversized = "x".repeat(INLINE_EXTRACTION_CONTENT_LIMIT + 1)
    await expect(
      createDocumentExtraction(env, {
        sourceAssetId: source.id,
        extractionMethod: "toMarkdown",
        content: oversized,
      })
    ).rejects.toThrow(/inline limit/)

    const contentAsset = await createAsset(env, {
      ownerId: owner.id,
      r2ObjectKey: `owners/${owner.id}/extractions/large.md`,
      artifactKind: "file",
      source: "derived",
      mimeType: "text/markdown",
    })
    const extraction = await createDocumentExtraction(env, {
      sourceAssetId: source.id,
      extractionMethod: "toMarkdown",
      contentAssetId: contentAsset.id,
    })
    expect(extraction.content).toBeNull()
    expect(extraction.content_asset_id).toBe(contentAsset.id)
  })

  it("requires either inline content or a content asset", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "extractions-neither" })
    const source = await createAsset(env, {
      ownerId: owner.id,
      r2ObjectKey: `owners/${owner.id}/uploads/empty.pdf`,
      artifactKind: "file",
      source: "upload",
    })

    await expect(
      createDocumentExtraction(env, { sourceAssetId: source.id, extractionMethod: "toMarkdown" })
    ).rejects.toThrow(/either inline content or a content asset/)
  })
})
