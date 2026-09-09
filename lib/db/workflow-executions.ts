import {
  ConversationMessageSchema,
  ConversationPartSchema,
  type ConversationMessage,
  type ConversationPart,
} from "../conversation"

import type { LedgerEnv } from "./env"
import { isoNow, newId } from "./ids"

export type ExecutionClass = "inline" | "durable"
export type ParentRelationship = "replay" | "regenerate" | "variant"

export interface WorkflowExecutionRow {
  id: string
  owner_id: string
  conversation_id: string | null
  triggering_message_id: string | null
  target_asset_id: string | null
  workflow_id: string
  workflow_version: string
  plan_id: string | null
  plan_version: string | null
  execution_class: ExecutionClass
  requested_model_key: string | null
  state: string
  result_message_id: string | null
  result_part_id: string | null
  parent_execution_id: string | null
  parent_relationship: ParentRelationship | null
  correlation_id: string | null
  cf_workflow_name: string | null
  cf_workflow_instance_id: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

export async function createWorkflowExecution(
  env: LedgerEnv,
  input: {
    ownerId: string
    conversationId?: string
    triggeringMessageId?: string
    targetAssetId?: string
    workflowId: string
    workflowVersion: string
    planId?: string
    planVersion?: string
    executionClass: ExecutionClass
    requestedModelKey?: string
    parentExecutionId?: string
    parentRelationship?: ParentRelationship
    correlationId?: string
    id?: string
    state?: string
  }
): Promise<WorkflowExecutionRow> {
  const now = isoNow()
  const row: WorkflowExecutionRow = {
    id: input.id ?? newId("wfexec"),
    owner_id: input.ownerId,
    conversation_id: input.conversationId ?? null,
    triggering_message_id: input.triggeringMessageId ?? null,
    target_asset_id: input.targetAssetId ?? null,
    workflow_id: input.workflowId,
    workflow_version: input.workflowVersion,
    plan_id: input.planId ?? null,
    plan_version: input.planVersion ?? null,
    execution_class: input.executionClass,
    requested_model_key: input.requestedModelKey ?? null,
    state: input.state ?? "queued",
    result_message_id: null,
    result_part_id: null,
    parent_execution_id: input.parentExecutionId ?? null,
    parent_relationship: input.parentRelationship ?? null,
    correlation_id: input.correlationId ?? null,
    cf_workflow_name: null,
    cf_workflow_instance_id: null,
    created_at: now,
    started_at: null,
    completed_at: null,
    updated_at: now,
  }

  await env.DB.prepare(
    `INSERT INTO workflow_executions (
       id, owner_id, conversation_id, triggering_message_id, target_asset_id,
       workflow_id, workflow_version, plan_id, plan_version, execution_class,
       requested_model_key, state, parent_execution_id, parent_relationship,
       correlation_id, created_at, updated_at
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`
  )
    .bind(
      row.id,
      row.owner_id,
      row.conversation_id,
      row.triggering_message_id,
      row.target_asset_id,
      row.workflow_id,
      row.workflow_version,
      row.plan_id,
      row.plan_version,
      row.execution_class,
      row.requested_model_key,
      row.state,
      row.parent_execution_id,
      row.parent_relationship,
      row.correlation_id,
      row.created_at,
      row.updated_at
    )
    .run()

  return row
}

/**
 * User-level regenerate/replay is a distinct, linked execution — never
 * a retried attempt of the original. Compare with `recordStepAttempt`,
 * which keeps retries inside the *same* workflow_execution_id.
 */
export async function createReplayExecution(
  env: LedgerEnv,
  input: {
    parentExecutionId: string
    ownerId: string
    relationship: ParentRelationship
    conversationId?: string
    triggeringMessageId?: string
    requestedModelKey?: string
  }
): Promise<WorkflowExecutionRow> {
  const parent = await getWorkflowExecution(env, input.parentExecutionId)
  if (!parent) {
    throw new Error(`Cannot replay unknown workflow execution ${input.parentExecutionId}.`)
  }
  return createWorkflowExecution(env, {
    ownerId: input.ownerId,
    conversationId: input.conversationId ?? parent.conversation_id ?? undefined,
    triggeringMessageId: input.triggeringMessageId ?? parent.triggering_message_id ?? undefined,
    workflowId: parent.workflow_id,
    workflowVersion: parent.workflow_version,
    planId: parent.plan_id ?? undefined,
    planVersion: parent.plan_version ?? undefined,
    executionClass: parent.execution_class,
    requestedModelKey: input.requestedModelKey ?? parent.requested_model_key ?? undefined,
    parentExecutionId: parent.id,
    parentRelationship: input.relationship,
  })
}

export async function getWorkflowExecution(
  env: LedgerEnv,
  executionId: string
): Promise<WorkflowExecutionRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM workflow_executions WHERE id = ?1`)
    .bind(executionId)
    .first<WorkflowExecutionRow>()
  return row ?? null
}

export async function getWorkflowExecutionByCloudflareInstance(
  env: LedgerEnv,
  input: { cfWorkflowName: string; cfWorkflowInstanceId: string }
): Promise<WorkflowExecutionRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM workflow_executions WHERE cf_workflow_name = ?1 AND cf_workflow_instance_id = ?2`
  )
    .bind(input.cfWorkflowName, input.cfWorkflowInstanceId)
    .first<WorkflowExecutionRow>()
  return row ?? null
}

/** Maps a durable execution to the Cloudflare Workflow instance carrying it out. */
export async function mapCloudflareWorkflowInstance(
  env: LedgerEnv,
  input: { executionId: string; cfWorkflowName: string; cfWorkflowInstanceId: string }
): Promise<void> {
  const now = isoNow()
  await env.DB.prepare(
    `UPDATE workflow_executions
     SET cf_workflow_name = ?1, cf_workflow_instance_id = ?2,
         started_at = COALESCE(started_at, ?3), state = 'running', updated_at = ?3
     WHERE id = ?4`
  )
    .bind(input.cfWorkflowName, input.cfWorkflowInstanceId, now, input.executionId)
    .run()
}

export async function updateWorkflowExecutionState(
  env: LedgerEnv,
  input: { executionId: string; state: string }
): Promise<void> {
  const now = isoNow()
  const terminal = ["succeeded", "failed", "cancelled"].includes(input.state)
  await env.DB.prepare(
    `UPDATE workflow_executions
     SET state = ?1, updated_at = ?2, completed_at = CASE WHEN ?3 THEN ?2 ELSE completed_at END
     WHERE id = ?4`
  )
    .bind(input.state, now, terminal ? 1 : 0, input.executionId)
    .run()
}

export interface WorkflowStepRow {
  id: string
  workflow_execution_id: string
  step_key: string
  step_kind: string
  catalog_key: string | null
  state: string
  attempt_count: number
  input_ref: string | null
  output_ref: string | null
  started_at: string | null
  completed_at: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

/**
 * Records one attempt of a step, creating the step row on first use and
 * always incrementing `attempt_no` within the *same* step (idempotent
 * under Cloudflare Workflow step retry — see #25's step.do() pattern).
 * Never call this to represent a user replay; use
 * `createReplayExecution` for that.
 */
export async function recordStepAttempt(
  env: LedgerEnv,
  input: {
    workflowExecutionId: string
    stepKey: string
    stepKind: string
    catalogKey?: string
    stepState: string
    attemptState: "running" | "succeeded" | "failed"
    requestedCatalogKey?: string
    resolvedCatalogKey?: string
    provider?: string
    transport?: string
    protocol?: string
    requestCorrelationId?: string
    errorCode?: string
    errorMessage?: string
    errorRetryable?: boolean
    inputRef?: string
    outputRef?: string
  }
): Promise<{ stepId: string; attemptId: string; attemptNo: number }> {
  const now = isoNow()

  await env.DB.prepare(
    `INSERT INTO workflow_steps (id, workflow_execution_id, step_key, step_kind, catalog_key, state, attempt_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)
     ON CONFLICT (workflow_execution_id, step_key) DO NOTHING`
  )
    .bind(
      newId("step"),
      input.workflowExecutionId,
      input.stepKey,
      input.stepKind,
      input.catalogKey ?? null,
      input.stepState,
      now
    )
    .run()

  const step = await env.DB.prepare(
    `SELECT id, attempt_count FROM workflow_steps WHERE workflow_execution_id = ?1 AND step_key = ?2`
  )
    .bind(input.workflowExecutionId, input.stepKey)
    .first<{ id: string; attempt_count: number }>()
  if (!step) {
    throw new Error(`Failed to create or find workflow step ${input.stepKey}.`)
  }

  const attemptNo = step.attempt_count + 1
  const attemptId = newId("attempt")
  const terminal = input.attemptState !== "running"

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO step_attempts (
         id, workflow_step_id, attempt_no, state, requested_catalog_key, resolved_catalog_key,
         provider, transport, protocol, request_correlation_id, started_at, completed_at,
         error_code, error_message, error_retryable, created_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`
    ).bind(
      attemptId,
      step.id,
      attemptNo,
      input.attemptState,
      input.requestedCatalogKey ?? null,
      input.resolvedCatalogKey ?? null,
      input.provider ?? null,
      input.transport ?? null,
      input.protocol ?? null,
      input.requestCorrelationId ?? null,
      now,
      terminal ? now : null,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.errorRetryable === undefined ? null : input.errorRetryable ? 1 : 0,
      now
    ),
    env.DB.prepare(
      `UPDATE workflow_steps
       SET state = ?1, attempt_count = ?2,
           input_ref = COALESCE(?3, input_ref), output_ref = COALESCE(?4, output_ref),
           error_code = ?5, error_message = ?6, updated_at = ?7,
           completed_at = CASE WHEN ?8 THEN ?7 ELSE completed_at END
       WHERE id = ?9`
    ).bind(
      input.stepState,
      attemptNo,
      input.inputRef ?? null,
      input.outputRef ?? null,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      now,
      input.stepState === "succeeded" || input.stepState === "failed" ? 1 : 0,
      step.id
    ),
  ])

  return { stepId: step.id, attemptId, attemptNo }
}

export async function createExternalJob(
  env: LedgerEnv,
  input: {
    stepAttemptId: string
    provider: string
    catalogKey?: string
    providerJobId: string
    state: string
    id?: string
  }
): Promise<{ id: string; created: boolean }> {
  const now = isoNow()
  const id = input.id ?? newId("extjob")
  const result = await env.DB.prepare(
    `INSERT INTO external_jobs (id, step_attempt_id, provider, catalog_key, provider_job_id, state, submitted_at, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?7,?7)
     ON CONFLICT (provider, provider_job_id) DO NOTHING`
  )
    .bind(id, input.stepAttemptId, input.provider, input.catalogKey ?? null, input.providerJobId, input.state, now)
    .run()

  if (result.meta.changes === 0) {
    const existing = await env.DB.prepare(
      `SELECT id FROM external_jobs WHERE provider = ?1 AND provider_job_id = ?2`
    )
      .bind(input.provider, input.providerJobId)
      .first<{ id: string }>()
    return { id: existing!.id, created: false }
  }
  return { id, created: true }
}

export async function updateExternalJobState(
  env: LedgerEnv,
  input: { id: string; state: string; completed?: boolean }
): Promise<void> {
  const now = isoNow()
  await env.DB.prepare(
    `UPDATE external_jobs SET state = ?1, updated_at = ?2, completed_at = CASE WHEN ?3 THEN ?2 ELSE completed_at END WHERE id = ?4`
  )
    .bind(input.state, now, input.completed ? 1 : 0, input.id)
    .run()
}

/**
 * Finalizes a workflow execution and appends its result message/parts
 * in one atomic batch (#6: "finalize workflow + result message/parts").
 * Falls back to a plain state update when there is no conversation to
 * project a result into (e.g. a non-conversational background job).
 */
export async function finalizeWorkflowExecution(
  env: LedgerEnv,
  input: {
    executionId: string
    state: "succeeded" | "failed" | "cancelled"
    resultParts?: ConversationPart[]
    resultMessageId?: string
  }
): Promise<ConversationMessage | null> {
  const execution = await getWorkflowExecution(env, input.executionId)
  if (!execution) {
    throw new Error(`Cannot finalize unknown workflow execution ${input.executionId}.`)
  }

  const now = isoNow()

  if (!input.resultParts || input.resultParts.length === 0 || !execution.conversation_id) {
    await updateWorkflowExecutionState(env, { executionId: input.executionId, state: input.state })
    return null
  }

  const validatedParts = input.resultParts.map((part) => ConversationPartSchema.parse(part))
  const messageId = input.resultMessageId ?? newId("msg")

  const nextSeq = await env.DB.prepare(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE conversation_id = ?1`
  )
    .bind(execution.conversation_id)
    .first<{ next: number }>()
  const sequence = nextSeq?.next ?? 1

  const statements = [
    env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, role, sequence, workflow_execution_id, created_at)
       VALUES (?1, ?2, 'assistant', ?3, ?4, ?5)`
    ).bind(messageId, execution.conversation_id, sequence, input.executionId, now),
    ...validatedParts.map((part, index) =>
      env.DB.prepare(
        `INSERT INTO message_parts (id, message_id, ordinal, part_type, data_json, asset_id, identity_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6)`
      ).bind(part.id, messageId, index, part.type, JSON.stringify(part), now)
    ),
    env.DB.prepare(`UPDATE conversations SET updated_at = ?1 WHERE id = ?2`).bind(
      now,
      execution.conversation_id
    ),
    env.DB.prepare(
      `UPDATE workflow_executions
       SET state = ?1, result_message_id = ?2, result_part_id = ?3, completed_at = ?4, updated_at = ?4
       WHERE id = ?5`
    ).bind(input.state, messageId, validatedParts[0]?.id ?? null, now, input.executionId),
  ]

  await env.DB.batch(statements)

  return ConversationMessageSchema.parse({
    id: messageId,
    role: "assistant",
    createdAt: now,
    parts: validatedParts,
  })
}
