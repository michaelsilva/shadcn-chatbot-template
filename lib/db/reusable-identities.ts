import type { LedgerEnv } from "./env"
import { isoNow, newId } from "./ids"

export interface ReusableIdentityRow {
  id: string
  owner_id: string
  kind: string
  provider: string
  display_name: string | null
  provider_reference: string
  status: string
  created_at: string
  deleted_at: string | null
}

/**
 * Owner-scoped model-adjacent identities such as cloned voices (#6).
 * `provider_reference` (the raw provider-side id) is only ever readable
 * through an owner-scoped query — every function here requires
 * `ownerId`, so there is no code path that lists or resolves an
 * identity without it.
 */
export async function createReusableIdentity(
  env: LedgerEnv,
  input: {
    ownerId: string
    kind: string
    provider: string
    providerReference: string
    displayName?: string
    status?: string
    id?: string
  }
): Promise<ReusableIdentityRow> {
  const now = isoNow()
  const row: ReusableIdentityRow = {
    id: input.id ?? newId("identity"),
    owner_id: input.ownerId,
    kind: input.kind,
    provider: input.provider,
    display_name: input.displayName ?? null,
    provider_reference: input.providerReference,
    status: input.status ?? "active",
    created_at: now,
    deleted_at: null,
  }
  await env.DB.prepare(
    `INSERT INTO reusable_identities (id, owner_id, kind, provider, display_name, provider_reference, status, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
  )
    .bind(
      row.id,
      row.owner_id,
      row.kind,
      row.provider,
      row.display_name,
      row.provider_reference,
      row.status,
      row.created_at
    )
    .run()
  return row
}

export async function listReusableIdentities(
  env: LedgerEnv,
  input: { ownerId: string; kind?: string }
): Promise<ReusableIdentityRow[]> {
  const rows = input.kind
    ? await env.DB.prepare(
        `SELECT * FROM reusable_identities WHERE owner_id = ?1 AND kind = ?2 AND deleted_at IS NULL ORDER BY created_at DESC`
      )
        .bind(input.ownerId, input.kind)
        .all<ReusableIdentityRow>()
    : await env.DB.prepare(
        `SELECT * FROM reusable_identities WHERE owner_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC`
      )
        .bind(input.ownerId)
        .all<ReusableIdentityRow>()
  return rows.results
}

export async function getReusableIdentity(
  env: LedgerEnv,
  input: { ownerId: string; identityId: string }
): Promise<ReusableIdentityRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM reusable_identities WHERE id = ?1 AND owner_id = ?2`
  )
    .bind(input.identityId, input.ownerId)
    .first<ReusableIdentityRow>()
  return row ?? null
}

export async function deleteReusableIdentity(
  env: LedgerEnv,
  input: { ownerId: string; identityId: string }
): Promise<void> {
  await env.DB.prepare(
    `UPDATE reusable_identities SET deleted_at = ?1, status = 'deleted' WHERE id = ?2 AND owner_id = ?3`
  )
    .bind(isoNow(), input.identityId, input.ownerId)
    .run()
}
