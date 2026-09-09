import type { LedgerEnv } from "../db/env"
import { createWorkflowExecution, updateWorkflowExecutionState } from "../db/workflow-executions"

/**
 * #24: "Inline streaming chat can use #3 directly while still writing
 * canonical D1 workflow/provenance state" — `inline` does not mean
 * untracked. This is deliberately thin: no plan/step machinery, no
 * Cloudflare Workflow instance. Full conversation/message persistence
 * for chat is #28's job; this only records that the request happened.
 */
export async function recordInlineChatExecution(
  env: LedgerEnv,
  input: { ownerId: string; requestedModelKey: string }
) {
  return createWorkflowExecution(env, {
    ownerId: input.ownerId,
    workflowId: "chat",
    workflowVersion: "1",
    executionClass: "inline",
    requestedModelKey: input.requestedModelKey,
    state: "running",
  })
}

export async function finalizeInlineChatExecution(
  env: LedgerEnv,
  input: { executionId: string; state: "succeeded" | "failed" }
) {
  return updateWorkflowExecutionState(env, { executionId: input.executionId, state: input.state })
}
