import type { LedgerEnv } from "./env"
import { isoNow, newId } from "./ids"

export type WebhookOutcome = "delivered" | "duplicate" | "rejected"

/**
 * Claims a `(provider, eventKey)` idempotency key before applying any
 * webhook side effect (e.g. `instance.sendEvent()` — see #25's
 * runtime-probe demonstrator, which this generalizes into the real
 * ledger table). `meta.changes === 0` means another delivery already
 * claimed this event: the caller must not repeat the side effect.
 */
export async function claimWebhookDelivery(
  env: LedgerEnv,
  input: {
    provider: string
    eventKey: string
    externalJobId?: string
    stepAttemptId?: string
  }
): Promise<{ claimed: boolean; id: string }> {
  const id = newId("webhook")
  const receivedAt = isoNow()
  const result = await env.DB.prepare(
    `INSERT INTO webhook_deliveries (id, provider, event_key, external_job_id, step_attempt_id, outcome, received_at)
     VALUES (?1,?2,?3,?4,?5,'delivered',?6)
     ON CONFLICT (provider, event_key) DO NOTHING`
  )
    .bind(id, input.provider, input.eventKey, input.externalJobId ?? null, input.stepAttemptId ?? null, receivedAt)
    .run()

  if (result.meta.changes === 0) {
    return { claimed: false, id }
  }
  return { claimed: true, id }
}

export async function recordWebhookOutcome(
  env: LedgerEnv,
  input: { id: string; outcome: WebhookOutcome }
): Promise<void> {
  await env.DB.prepare(`UPDATE webhook_deliveries SET outcome = ?1 WHERE id = ?2`)
    .bind(input.outcome, input.id)
    .run()
}
