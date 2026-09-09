import type { LedgerEnv } from "./env"
import { isoNow, newId } from "./ids"

/**
 * For personal deployment this may resolve to one row, but ownership
 * stays explicit (#6/#15) so every downstream query is owner-scoped
 * from day one rather than retrofitted at public multi-user launch.
 */
export interface OwnerRow {
  id: string
  auth_provider: string | null
  auth_subject: string | null
  display_name: string | null
  created_at: string
  updated_at: string
}

export async function getOrCreateOwner(
  env: LedgerEnv,
  identity: { authProvider: string; authSubject: string; displayName?: string }
): Promise<OwnerRow> {
  const existing = await env.DB.prepare(
    `SELECT * FROM owners WHERE auth_provider = ?1 AND auth_subject = ?2`
  )
    .bind(identity.authProvider, identity.authSubject)
    .first<OwnerRow>()
  if (existing) return existing

  const now = isoNow()
  const row: OwnerRow = {
    id: newId("owner"),
    auth_provider: identity.authProvider,
    auth_subject: identity.authSubject,
    display_name: identity.displayName ?? null,
    created_at: now,
    updated_at: now,
  }
  await env.DB.prepare(
    `INSERT INTO owners (id, auth_provider, auth_subject, display_name, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(
      row.id,
      row.auth_provider,
      row.auth_subject,
      row.display_name,
      row.created_at,
      row.updated_at
    )
    .run()
  return row
}

export async function getOwner(
  env: LedgerEnv,
  ownerId: string
): Promise<OwnerRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM owners WHERE id = ?1`)
    .bind(ownerId)
    .first<OwnerRow>()
  return row ?? null
}
