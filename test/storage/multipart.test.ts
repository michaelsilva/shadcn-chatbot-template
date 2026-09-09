import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { getAsset } from "../../lib/db/assets"
import { getOrCreateOwner } from "../../lib/db/owners"
import {
  abortMultipartUpload,
  completeMultipartUpload,
  initiateMultipartUpload,
  uploadMultipartPart,
} from "../../lib/storage/multipart"

describe("resumable multipart upload", () => {
  it("uploads large media as independently retryable parts instead of one Worker request", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "multipart" })

    const { asset, uploadId, key } = await initiateMultipartUpload(env, {
      ownerId: owner.id,
      artifactKind: "video",
      mimeType: "video/mp4",
    })
    expect(asset.upload_state).toBe("pending")

    const partSize = 5 * 1024 * 1024
    const part1 = await uploadMultipartPart(env, {
      key,
      uploadId,
      partNumber: 1,
      body: new Uint8Array(partSize).fill(1),
    })
    const part2 = await uploadMultipartPart(env, {
      key,
      uploadId,
      partNumber: 2,
      body: new Uint8Array(1024).fill(2), // the final part may be under the 5 MiB minimum
    })

    const finalized = await completeMultipartUpload(env, {
      ownerId: owner.id,
      assetId: asset.id,
      key,
      uploadId,
      parts: [part1, part2],
    })
    expect(finalized.upload_state).toBe("finalized")
    expect(finalized.byte_size).toBe(partSize + 1024)

    const object = await env.ASSETS_BUCKET.head(key)
    expect(object?.size).toBe(partSize + 1024)
  })

  it("marks the asset failed when a multipart upload is aborted", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "multipart-abort" })

    const { asset, uploadId, key } = await initiateMultipartUpload(env, {
      ownerId: owner.id,
      artifactKind: "video",
      mimeType: "video/mp4",
    })

    await abortMultipartUpload(env, { ownerId: owner.id, assetId: asset.id, key, uploadId })

    const row = await getAsset(env, { ownerId: owner.id, assetId: asset.id })
    expect(row?.upload_state).toBe("failed")
  })
})
