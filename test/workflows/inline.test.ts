import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { getOrCreateOwner } from "../../lib/db/owners"
import { finalizeInlineChatExecution, recordInlineChatExecution } from "../../lib/workflows/inline"

describe("inline chat provenance", () => {
  it("records a running inline workflow_execution and finalizes it without ever creating a Cloudflare Workflow instance", async () => {
    const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "inline-chat" })

    const execution = await recordInlineChatExecution(env, {
      ownerId: owner.id,
      requestedModelKey: "@cf/zai-org/glm-5.3-flash",
    })
    expect(execution.execution_class).toBe("inline")
    expect(execution.workflow_id).toBe("chat")
    expect(execution.state).toBe("running")
    expect(execution.cf_workflow_instance_id).toBeNull()

    await finalizeInlineChatExecution(env, { executionId: execution.id, state: "succeeded" })

    const row = await env.DB.prepare(`SELECT state, completed_at FROM workflow_executions WHERE id = ?1`)
      .bind(execution.id)
      .first<{ state: string; completed_at: string | null }>()
    expect(row?.state).toBe("succeeded")
    expect(row?.completed_at).not.toBeNull()
  })
})
