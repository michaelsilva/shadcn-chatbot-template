import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { getOrCreateOwner } from "../../lib/db/owners"
import { createUploadIntent, finalizeUpload } from "../../lib/storage/uploads"

const BUCKET = "shadcn-chatbot-assets"

describe("upload intents", () => {
  it("creates a pending asset with a presigned PUT restricted to its own key, then finalizes only after the object exists in R2", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "uploads" })

    const intent = await createUploadIntent(env, {
      ownerId: owner.id,
      bucketName: BUCKET,
      artifactKind: "image",
      mimeType: "image/png",
      byteSize: 1024,
    })
    expect(intent.asset.upload_state).toBe("pending")
    expect(intent.uploadUrl).toContain(`/${BUCKET}/${intent.asset.r2_object_key}`)

    // The browser hasn't actually uploaded anything yet — finalize must refuse.
    const tooEarly = await finalizeUpload(env, { ownerId: owner.id, assetId: intent.asset.id })
    expect(tooEarly.outcome).toBe("not-found-in-r2")

    // Simulate the browser's direct PUT to R2 (Miniflare simulates the bucket; the
    // presigned URL itself is verified separately, offline, in core.contract.ts).
    await env.ASSETS_BUCKET.put(intent.asset.r2_object_key, new Uint8Array(1024), {
      httpMetadata: { contentType: "image/png" },
    })

    const finalized = await finalizeUpload(env, { ownerId: owner.id, assetId: intent.asset.id })
    expect(finalized.outcome).toBe("finalized")
    expect(finalized.outcome === "finalized" && finalized.asset.upload_state).toBe("finalized")
    expect(finalized.outcome === "finalized" && finalized.asset.byte_size).toBe(1024)

    // Finalizing an already-finalized asset is a safe no-op, not an error.
    const again = await finalizeUpload(env, { ownerId: owner.id, assetId: intent.asset.id })
    expect(again.outcome).toBe("already-finalized")
  })

  it("rejects a disallowed MIME type before ever creating a D1 row or R2 key", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "uploads-mime" })
    await expect(
      createUploadIntent(env, {
        ownerId: owner.id,
        bucketName: BUCKET,
        artifactKind: "image",
        mimeType: "application/x-msdownload",
        byteSize: 1024,
      })
    ).rejects.toThrow(/not allowed/)
  })

  it("rejects an oversized single-PUT request, directing callers to multipart", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "uploads-oversized" })
    await expect(
      createUploadIntent(env, {
        ownerId: owner.id,
        bucketName: BUCKET,
        artifactKind: "video",
        mimeType: "video/mp4",
        byteSize: 200 * 1024 * 1024,
      })
    ).rejects.toThrow(/multipart/)
  })
})
