import { z } from "zod"

/**
 * The provider-webhook -> sendEvent() -> waiting Workflow pattern from
 * #25, proven with a controllable stand-in instead of a live paid
 * provider callback. #10 will apply the same shape (D1 idempotency
 * claim, then `instance.sendEvent()`) to real provider webhooks.
 */

export const RuntimeProbeWebhookPayloadSchema = z.object({
  eventId: z.string().min(1),
  runtimeProbeExecutionId: z.string().min(1),
  cfWorkflowInstanceId: z.string().min(1),
  approved: z.boolean(),
  note: z.string().min(1).optional(),
})
export type RuntimeProbeWebhookPayload = z.infer<
  typeof RuntimeProbeWebhookPayloadSchema
>

export interface RuntimeProbeWebhookEnv {
  DB: D1Database
  RUNTIME_PROBE_WORKFLOW: Workflow
}

export type RuntimeProbeWebhookResult =
  | { outcome: "duplicate" }
  | { outcome: "delivered" }

export async function processRuntimeProbeWebhook(
  env: RuntimeProbeWebhookEnv,
  payload: RuntimeProbeWebhookPayload
): Promise<RuntimeProbeWebhookResult> {
  const receivedAt = new Date().toISOString()

  const claim = await env.DB.prepare(
    `INSERT INTO runtime_probe_webhook_events
       (event_id, runtime_probe_execution_id, received_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT (event_id) DO NOTHING`
  )
    .bind(payload.eventId, payload.runtimeProbeExecutionId, receivedAt)
    .run()

  // `meta.changes === 0` means the unique constraint on `event_id` already
  // held this row: this delivery is a provider retry, not a new event.
  // Duplicate deliveries must not call sendEvent() a second time.
  if (claim.meta.changes === 0) {
    return { outcome: "duplicate" }
  }

  const instance = await env.RUNTIME_PROBE_WORKFLOW.get(
    payload.cfWorkflowInstanceId
  )
  await instance.sendEvent({
    type: "runtime-probe.confirm",
    payload: { approved: payload.approved, note: payload.note },
  })

  return { outcome: "delivered" }
}
