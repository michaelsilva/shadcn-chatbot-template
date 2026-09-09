import { z } from "zod"

/**
 * #25 infrastructure-proof helpers.
 *
 * These functions demonstrate the durable-execution pattern every real
 * #24 workflow will follow: idempotent D1 writes keyed by a stable id
 * (safe under Cloudflare Workflow step retry), and R2 as the binary
 * store for anything a step produces. They are not part of the
 * canonical product ledger — #6 owns that schema.
 */

export const RuntimeProbeParamsSchema = z.object({
  note: z.string().min(1).optional(),
})
export type RuntimeProbeParams = z.infer<typeof RuntimeProbeParamsSchema>

export type RuntimeProbeStatus = "running" | "awaiting-confirmation" | "succeeded"

export interface RuntimeProbeEnv {
  DB: D1Database
  ASSETS_BUCKET: R2Bucket
}

export interface RuntimeProbeExecutionRow {
  id: string
  cf_workflow_instance_id: string
  status: RuntimeProbeStatus
  confirmation_payload: string | null
  created_at: string
  updated_at: string
}

export async function upsertRuntimeProbeExecution(
  env: RuntimeProbeEnv,
  input: {
    id: string
    cfWorkflowInstanceId: string
    status: RuntimeProbeStatus
    confirmationPayload?: unknown
  }
): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO runtime_probe_executions
       (id, cf_workflow_instance_id, status, confirmation_payload, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT (id) DO UPDATE SET
       status = excluded.status,
       confirmation_payload = COALESCE(excluded.confirmation_payload, runtime_probe_executions.confirmation_payload),
       updated_at = excluded.updated_at`
  )
    .bind(
      input.id,
      input.cfWorkflowInstanceId,
      input.status,
      input.confirmationPayload !== undefined
        ? JSON.stringify(input.confirmationPayload)
        : null,
      now
    )
    .run()
}

export async function getRuntimeProbeExecution(
  env: RuntimeProbeEnv,
  id: string
): Promise<RuntimeProbeExecutionRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, cf_workflow_instance_id, status, confirmation_payload, created_at, updated_at
     FROM runtime_probe_executions WHERE id = ?1`
  )
    .bind(id)
    .first<RuntimeProbeExecutionRow>()
  return row ?? null
}

export async function writeRuntimeProbeMarker(
  env: RuntimeProbeEnv,
  id: string,
  payload: unknown
): Promise<void> {
  await env.ASSETS_BUCKET.put(
    `runtime-probe/${id}.json`,
    JSON.stringify(payload),
    { httpMetadata: { contentType: "application/json" } }
  )
}
