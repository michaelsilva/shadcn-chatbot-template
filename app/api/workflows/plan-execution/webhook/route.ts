import { getCloudflareContext } from "@opennextjs/cloudflare"
import { z } from "zod"

import { getWorkflowExecution } from "@/lib/db/workflow-executions"
import { claimWebhookDelivery } from "@/lib/db/webhooks"
import { PLAN_EXECUTION_WORKFLOW_NAME } from "@/lib/workflows/constants"

const RequestSchema = z.object({
  provider: z.string().min(1),
  eventKey: z.string().min(1),
  workflowExecutionId: z.string().min(1),
  resultUrl: z.string().min(1).optional(),
})

/**
 * The webhook -> D1 idempotency claim -> `instance.sendEvent()` path
 * (#24/#25) for a queued provider job's `external.await` step. #10 will
 * own real per-provider payload validation/signature checks; this is
 * the shared idempotency + resume mechanics every provider webhook
 * will need.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const parsed = RequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: "Invalid webhook payload." }, { status: 400 })
  }

  const { env } = await getCloudflareContext({ async: true })

  const claim = await claimWebhookDelivery(env, {
    provider: parsed.data.provider,
    eventKey: parsed.data.eventKey,
  })
  if (!claim.claimed) {
    return Response.json({ outcome: "duplicate" })
  }

  const execution = await getWorkflowExecution(env, parsed.data.workflowExecutionId)
  if (!execution?.cf_workflow_name || !execution.cf_workflow_instance_id) {
    return Response.json(
      { error: "Execution is not mapped to a running Cloudflare Workflow instance." },
      { status: 409 }
    )
  }
  if (execution.cf_workflow_name !== PLAN_EXECUTION_WORKFLOW_NAME) {
    return Response.json({ error: "Execution does not belong to this workflow class." }, { status: 409 })
  }

  const instance = await env.PLAN_EXECUTION_WORKFLOW.get(execution.cf_workflow_instance_id)
  await instance.sendEvent({
    type: "provider-job.complete",
    payload: { resultUrl: parsed.data.resultUrl },
  })

  return Response.json({ outcome: "delivered" })
}
