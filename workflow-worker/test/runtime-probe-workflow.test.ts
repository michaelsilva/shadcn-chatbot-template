import { env } from "cloudflare:workers"
import { introspectWorkflowInstance } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import { getRuntimeProbeExecution } from "../../lib/runtime-probe"
import { processRuntimeProbeWebhook } from "../../lib/runtime-probe-webhook"

/**
 * Proves the #25 acceptance criteria that only exist at the Workers
 * runtime layer: durable step/sleep/waitForEvent semantics, idempotent
 * D1 writes under step retry, and the webhook -> sendEvent() -> waiting
 * Workflow path. None of this is reachable from a plain tsc+node
 * contract test (no `cloudflare:workers`/D1/R2 runtime there), which is
 * why this package adds @cloudflare/vitest-plugin instead of hand-rolling
 * a Workflow simulator.
 */
describe("RuntimeProbeWorkflow", () => {
  it("runs record-start -> sleep -> waitForEvent -> finalize and persists the result", async () => {
    const instanceId = "runtime-probe-happy-path"

    await using instance = await introspectWorkflowInstance(
      env.RUNTIME_PROBE_WORKFLOW,
      instanceId
    )
    await instance.modify(async (m) => {
      await m.disableSleeps()
      await m.mockEvent({
        type: "runtime-probe.confirm",
        payload: { approved: true, note: "looks good" },
      })
    })

    await env.RUNTIME_PROBE_WORKFLOW.create({ id: instanceId })

    await expect(instance.waitForStatus("complete")).resolves.not.toThrow()
    expect(await instance.getOutput()).toEqual({ approved: true })

    const row = await getRuntimeProbeExecution(env, instanceId)
    expect(row?.status).toBe("succeeded")
    expect(row?.confirmation_payload).toContain("looks good")

    const marker = await env.ASSETS_BUCKET.get(`runtime-probe/${instanceId}.json`)
    expect(marker).not.toBeNull()
    expect(await marker?.json()).toEqual({ approved: true, note: "looks good" })
  })

  it("produces exactly-once D1 state when a step is retried", async () => {
    const instanceId = "runtime-probe-retry"

    await using instance = await introspectWorkflowInstance(
      env.RUNTIME_PROBE_WORKFLOW,
      instanceId
    )
    await instance.modify(async (m) => {
      await m.disableSleeps()
      await m.disableRetryDelays()
      // Force the first step to fail once; the Workflow engine retries
      // it, and the idempotent upsert must not leave duplicate/partial
      // state behind.
      await m.mockStepError(
        { name: "record-start" },
        new Error("simulated transient failure"),
        1
      )
      await m.mockEvent({
        type: "runtime-probe.confirm",
        payload: { approved: false },
      })
    })

    await env.RUNTIME_PROBE_WORKFLOW.create({ id: instanceId })
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow()

    const count = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM runtime_probe_executions WHERE id = ?1"
    )
      .bind(instanceId)
      .first<{ count: number }>()
    expect(count?.count).toBe(1)

    const row = await getRuntimeProbeExecution(env, instanceId)
    expect(row?.status).toBe("succeeded")
  })

  it("delivers a webhook confirmation to a running instance and dedupes retried deliveries", async () => {
    const instanceId = "runtime-probe-webhook"

    await using instance = await introspectWorkflowInstance(
      env.RUNTIME_PROBE_WORKFLOW,
      instanceId
    )
    await instance.modify(async (m) => {
      await m.disableSleeps()
    })

    await env.RUNTIME_PROBE_WORKFLOW.create({ id: instanceId })

    const payload = {
      eventId: "evt_1",
      runtimeProbeExecutionId: instanceId,
      cfWorkflowInstanceId: instanceId,
      approved: true,
    }

    const first = await processRuntimeProbeWebhook(env, payload)
    expect(first).toEqual({ outcome: "delivered" })

    const second = await processRuntimeProbeWebhook(env, payload)
    expect(second).toEqual({ outcome: "duplicate" })

    await expect(instance.waitForStatus("complete")).resolves.not.toThrow()
    expect(await instance.getOutput()).toEqual({ approved: true })
  })
})
