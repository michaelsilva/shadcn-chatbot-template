import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { getOrCreateOwner } from "../../lib/db/owners"
import {
  createReusableIdentity,
  deleteReusableIdentity,
  getReusableIdentity,
  listReusableIdentities,
} from "../../lib/db/reusable-identities"

describe("reusable_identities", () => {
  it("is owner-scoped: one owner cannot read or list another owner's identity", async () => {
    const ownerA = await getOrCreateOwner(env, { authProvider: "test", authSubject: "identity-owner-a" })
    const ownerB = await getOrCreateOwner(env, { authProvider: "test", authSubject: "identity-owner-b" })

    const identity = await createReusableIdentity(env, {
      ownerId: ownerA.id,
      kind: "cloned-voice",
      provider: "elevenlabs",
      providerReference: "voice_raw_provider_id_should_never_leak",
      displayName: "Narration voice",
    })

    const ownedRead = await getReusableIdentity(env, { ownerId: ownerA.id, identityId: identity.id })
    expect(ownedRead?.id).toBe(identity.id)

    const crossOwnerRead = await getReusableIdentity(env, {
      ownerId: ownerB.id,
      identityId: identity.id,
    })
    expect(crossOwnerRead).toBeNull()

    const ownerAList = await listReusableIdentities(env, { ownerId: ownerA.id })
    expect(ownerAList.map((i) => i.id)).toContain(identity.id)

    const ownerBList = await listReusableIdentities(env, { ownerId: ownerB.id })
    expect(ownerBList.map((i) => i.id)).not.toContain(identity.id)
  })

  it("soft-deletes an identity out of active listings without losing the row", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "identity-delete" })
    const identity = await createReusableIdentity(env, {
      ownerId: owner.id,
      kind: "reference-voice",
      provider: "elevenlabs",
      providerReference: "voice_2",
    })

    await deleteReusableIdentity(env, { ownerId: owner.id, identityId: identity.id })

    const active = await listReusableIdentities(env, { ownerId: owner.id })
    expect(active.map((i) => i.id)).not.toContain(identity.id)

    const row = await env.DB.prepare(`SELECT status, deleted_at FROM reusable_identities WHERE id = ?1`)
      .bind(identity.id)
      .first<{ status: string; deleted_at: string | null }>()
    expect(row?.status).toBe("deleted")
    expect(row?.deleted_at).not.toBeNull()
  })
})
