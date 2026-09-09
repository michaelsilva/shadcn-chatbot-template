/**
 * Application ids are generated server-side and never reuse a provider
 * job id as a primary key (#6). A short kind prefix keeps ids
 * self-describing in logs/D1 queries without needing a join.
 */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

export function isoNow(): string {
  return new Date().toISOString()
}
