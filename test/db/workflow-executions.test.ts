import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import type { ConversationPart } from "../../lib/conversation"
import { createConversation } from "../../lib/db/conversations"
import { getOrCreateOwner } from "../../lib/db/owners"
import {
  createExternalJob,
  createReplayExecution,
  createWorkflowExecution,
  finalizeWorkflowExecution,
  getWorkflowExecution,
  getWorkflowExecutionByCloudflareInstance,
  mapCloudflareWorkflowInstance,
  recordStepAttempt,
  updateExternalJobState,
} from "../../lib/db/workflow-executions"

async function ownerId() {
  const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "workflow-executions" })
  return owner.id
}

describe("workflow_executions", () => {
  it("maps a durable execution to its Cloudflare Workflow instance and can be looked up by it", async () => {
    const owner = await ownerId()
    const execution = await createWorkflowExecution(env, {
      ownerId: owner,
      workflowId: "svg.generate",
      workflowVersion: "1",
      executionClass: "durable",
    })

    await mapCloudflareWorkflowInstance(env, {
      executionId: execution.id,
      cfWorkflowName: "shadcn-chatbot-svg-generate",
      cfWorkflowInstanceId: "cf-instance-1",
    })

    const byInstance = await getWorkflowExecutionByCloudflareInstance(env, {
      cfWorkflowName: "shadcn-chatbot-svg-generate",
      cfWorkflowInstanceId: "cf-instance-1",
    })
    expect(byInstance?.id).toBe(execution.id)
    expect(byInstance?.state).toBe("running")
  })

  it("keeps a retried step inside the same execution, incrementing attempt_no", async () => {
    const owner = await ownerId()
    const execution = await createWorkflowExecution(env, {
      ownerId: owner,
      workflowId: "image.generate",
      workflowVersion: "1",
      executionClass: "durable",
    })

    const first = await recordStepAttempt(env, {
      workflowExecutionId: execution.id,
      stepKey: "submit",
      stepKind: "atomic-execute",
      stepState: "running",
      attemptState: "failed",
      errorCode: "UPSTREAM_TIMEOUT",
      errorMessage: "timed out",
      errorRetryable: true,
    })
    expect(first.attemptNo).toBe(1)

    // Cloudflare Workflow step.do() retries the *same* step_key.
    const second = await recordStepAttempt(env, {
      workflowExecutionId: execution.id,
      stepKey: "submit",
      stepKind: "atomic-execute",
      stepState: "succeeded",
      attemptState: "succeeded",
      outputRef: "asset_generated_1",
    })
    expect(second.attemptNo).toBe(2)
    expect(second.stepId).toBe(first.stepId)

    const step = await env.DB.prepare(
      `SELECT state, attempt_count FROM workflow_steps WHERE id = ?1`
    )
      .bind(first.stepId)
      .first<{ state: string; attempt_count: number }>()
    expect(step).toEqual({ state: "succeeded", attempt_count: 2 })

    const attempts = await env.DB.prepare(
      `SELECT attempt_no, state FROM step_attempts WHERE workflow_step_id = ?1 ORDER BY attempt_no ASC`
    )
      .bind(first.stepId)
      .all<{ attempt_no: number; state: string }>()
    expect(attempts.results).toEqual([
      { attempt_no: 1, state: "failed" },
      { attempt_no: 2, state: "succeeded" },
    ])
  })

  it("correlates an external provider job without using the provider id as a primary key, deduping resubmission", async () => {
    const owner = await ownerId()
    const execution = await createWorkflowExecution(env, {
      ownerId: owner,
      workflowId: "video.generate",
      workflowVersion: "1",
      executionClass: "durable",
    })
    const attempt = await recordStepAttempt(env, {
      workflowExecutionId: execution.id,
      stepKey: "submit-queue",
      stepKind: "atomic-submit",
      stepState: "running",
      attemptState: "running",
      provider: "fal",
    })

    const first = await createExternalJob(env, {
      stepAttemptId: attempt.attemptId,
      provider: "fal",
      providerJobId: "fal-job-123",
      state: "queued",
    })
    expect(first.created).toBe(true)
    expect(first.id).not.toBe("fal-job-123")

    // A retried submit step.do() must not create a second row for the same provider job.
    const duplicate = await createExternalJob(env, {
      stepAttemptId: attempt.attemptId,
      provider: "fal",
      providerJobId: "fal-job-123",
      state: "queued",
    })
    expect(duplicate.created).toBe(false)
    expect(duplicate.id).toBe(first.id)

    await updateExternalJobState(env, { id: first.id, state: "succeeded", completed: true })
    const job = await env.DB.prepare(`SELECT state FROM external_jobs WHERE id = ?1`)
      .bind(first.id)
      .first<{ state: string }>()
    expect(job?.state).toBe("succeeded")
  })

  it("finalizes a durable execution and appends the result message/parts atomically", async () => {
    const owner = await ownerId()
    const conversation = await createConversation(env, { ownerId: owner })
    const execution = await createWorkflowExecution(env, {
      ownerId: owner,
      conversationId: conversation.id,
      workflowId: "svg.generate",
      workflowVersion: "1",
      executionClass: "durable",
    })

    const resultParts: ConversationPart[] = [
      {
        id: "part_result_svg",
        type: "image",
        role: "output",
        representation: "svg",
        asset: {
          assetId: "asset_result_svg",
          kind: "image",
          mimeType: "image/svg+xml",
          format: "svg",
        },
      },
    ]

    const message = await finalizeWorkflowExecution(env, {
      executionId: execution.id,
      state: "succeeded",
      resultParts,
    })
    expect(message?.parts).toHaveLength(1)

    const finalExecution = await getWorkflowExecution(env, execution.id)
    expect(finalExecution?.state).toBe("succeeded")
    expect(finalExecution?.result_message_id).toBe(message?.id)
    expect(finalExecution?.completed_at).not.toBeNull()

    const persistedPart = await env.DB.prepare(
      `SELECT part_type FROM message_parts WHERE message_id = ?1`
    )
      .bind(message?.id)
      .first<{ part_type: string }>()
    expect(persistedPart?.part_type).toBe("image")
  })

  it("creates a user replay as a new, linked execution rather than mutating the original", async () => {
    const owner = await ownerId()
    const original = await createWorkflowExecution(env, {
      ownerId: owner,
      workflowId: "video.generate",
      workflowVersion: "1",
      executionClass: "durable",
      requestedModelKey: "google/veo-3.1-fast",
    })
    await recordStepAttempt(env, {
      workflowExecutionId: original.id,
      stepKey: "generate",
      stepKind: "atomic-submit",
      stepState: "succeeded",
      attemptState: "succeeded",
    })

    const replay = await createReplayExecution(env, {
      parentExecutionId: original.id,
      ownerId: owner,
      relationship: "regenerate",
    })

    expect(replay.id).not.toBe(original.id)
    expect(replay.parent_execution_id).toBe(original.id)
    expect(replay.parent_relationship).toBe("regenerate")
    expect(replay.workflow_id).toBe(original.workflow_id)
    expect(replay.requested_model_key).toBe("google/veo-3.1-fast")

    // The original execution's own step ledger is untouched by the replay.
    const originalSteps = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM workflow_steps WHERE workflow_execution_id = ?1`
    )
      .bind(original.id)
      .first<{ count: number }>()
    expect(originalSteps?.count).toBe(1)

    const replaySteps = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM workflow_steps WHERE workflow_execution_id = ?1`
    )
      .bind(replay.id)
      .first<{ count: number }>()
    expect(replaySteps?.count).toBe(0)
  })
})
