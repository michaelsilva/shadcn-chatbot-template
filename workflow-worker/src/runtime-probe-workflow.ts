import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"

import {
  upsertRuntimeProbeExecution,
  writeRuntimeProbeMarker,
  type RuntimeProbeEnv,
  type RuntimeProbeParams,
} from "../../lib/runtime-probe"

interface RuntimeProbeConfirmation {
  approved: boolean
  note?: string
}

/**
 * #25 representative durable Workflow.
 *
 * This is not a product workflow (#24 owns those). It exists to prove,
 * in CI and locally, that this repository's Cloudflare Workflows setup
 * actually supports the primitives the real media/document workflows
 * will depend on:
 *
 *  - `step.do()` with idempotent D1 side effects safe under retry
 *  - `step.sleep()` durably suspending/resuming the instance
 *  - `step.waitForEvent()` blocking on an external (webhook-delivered)
 *    confirmation, resolved via `instance.sendEvent()`
 *  - R2 as the binary output store for a step's result
 */
export class RuntimeProbeWorkflow extends WorkflowEntrypoint<
  RuntimeProbeEnv,
  RuntimeProbeParams
> {
  async run(event: WorkflowEvent<RuntimeProbeParams>, step: WorkflowStep) {
    await step.do("record-start", async () => {
      await upsertRuntimeProbeExecution(this.env, {
        id: event.instanceId,
        cfWorkflowInstanceId: event.instanceId,
        status: "running",
      })
    })

    await step.sleep("settle", "2 seconds")

    await step.do("await-confirmation-setup", async () => {
      await upsertRuntimeProbeExecution(this.env, {
        id: event.instanceId,
        cfWorkflowInstanceId: event.instanceId,
        status: "awaiting-confirmation",
      })
    })

    const confirmation = await step.waitForEvent<RuntimeProbeConfirmation>(
      "external-confirmation",
      { type: "runtime-probe.confirm", timeout: "1 hour" }
    )

    return step.do("finalize", async () => {
      await upsertRuntimeProbeExecution(this.env, {
        id: event.instanceId,
        cfWorkflowInstanceId: event.instanceId,
        status: "succeeded",
        confirmationPayload: confirmation.payload,
      })
      await writeRuntimeProbeMarker(this.env, event.instanceId, confirmation.payload)
      return { approved: confirmation.payload.approved }
    })
  }
}
