import type { LedgerEnv } from "./db/env"
import { getOrCreateOwner, type OwnerRow } from "./db/owners"

/**
 * v0.1 has no auth product yet (#15 owns that later). Every owner-scoped
 * repository/storage call still requires an explicit owner id — see
 * #6/#7's owner-scoping doctrine — so routes resolve a single stable
 * "local" owner rather than skipping scoping altogether. Swapping this
 * for real session-derived identity later does not change any callee's
 * contract.
 */
export async function getCurrentOwner(env: LedgerEnv): Promise<OwnerRow> {
  return getOrCreateOwner(env, { authProvider: "local", authSubject: "default" })
}
