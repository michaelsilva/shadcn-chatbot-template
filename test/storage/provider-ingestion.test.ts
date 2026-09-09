import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { getOrCreateOwner } from "../../lib/db/owners"
import { ingestProviderAsset } from "../../lib/storage/provider-ingestion"

function fakeFetch(status: number, contentType: string, body: string): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "content-type": contentType } })) as typeof fetch
}

describe("provider ingestion", () => {
  it("copies a provider result into R2 and finalizes the D1 asset, never keeping the provider URL as the durable reference", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "ingestion" })

    const result = await ingestProviderAsset(env, {
      ownerId: owner.id,
      sourceUrl: "https://provider.example/generated/output.png",
      artifactKind: "image",
      fetchImpl: fakeFetch(200, "image/png", "fake-png-bytes"),
    })
    expect(result.outcome).toBe("ingested")
    expect(result.outcome === "ingested" && result.asset.upload_state).toBe("finalized")
    expect(result.outcome === "ingested" && result.asset.source).toBe("generated")

    const key = result.outcome === "ingested" ? result.asset.r2_object_key : ""
    const object = await env.ASSETS_BUCKET.get(key)
    expect(await object?.text()).toBe("fake-png-bytes")
  })

  it("rejects ingestion when the provider returns an unexpected artifact type", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "ingestion-mime" })

    const result = await ingestProviderAsset(env, {
      ownerId: owner.id,
      sourceUrl: "https://provider.example/generated/output.exe",
      artifactKind: "image",
      fetchImpl: fakeFetch(200, "application/x-msdownload", "not an image"),
    })
    expect(result.outcome).toBe("rejected")
  })

  it("is idempotent under Cloudflare Workflow step retry: a repeated call with the same id does not duplicate the asset", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "ingestion-retry" })
    const id = "asset_ingest_retry_1"

    const first = await ingestProviderAsset(env, {
      id,
      ownerId: owner.id,
      sourceUrl: "https://provider.example/generated/output.png",
      artifactKind: "image",
      fetchImpl: fakeFetch(200, "image/png", "bytes-v1"),
    })
    expect(first.outcome).toBe("ingested")

    const retried = await ingestProviderAsset(env, {
      id,
      ownerId: owner.id,
      sourceUrl: "https://provider.example/generated/output.png",
      artifactKind: "image",
      fetchImpl: fakeFetch(200, "image/png", "bytes-v1"),
    })
    expect(retried.outcome).toBe("already-ingested")
    expect(retried.outcome === "already-ingested" && retried.asset.id).toBe(
      first.outcome === "ingested" ? first.asset.id : ""
    )

    const count = await env.DB.prepare(`SELECT COUNT(*) as count FROM assets WHERE id = ?1`)
      .bind(id)
      .first<{ count: number }>()
    expect(count?.count).toBe(1)
  })
})
