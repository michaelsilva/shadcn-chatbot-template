import { getCloudflareContext } from "@opennextjs/cloudflare"
import { z } from "zod"

import { getCurrentOwner } from "@/lib/current-owner"
import { createWorkflowExecution, getWorkflowExecution } from "@/lib/db/workflow-executions"
import { resolveModelKeysForPlan, selectPlan } from "@/lib/workflows/plan-selection"

const RequestSchema = z.object({
  workflowId: z.string().min(1),
  modelOverride: z.string().min(1).optional(),
  input: z.object({
    text: z.string().min(1).optional(),
    assetId: z.string().min(1).optional(),
  }),
})

/**
 * Triggers a durable #24 plan execution. Plan/model selection happens
 * here, server-side, before the Cloudflare Workflow instance (#25)
 * exists — the durable execution only ever carries out an
 * already-resolved decision.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const parsed = RequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: "Invalid plan-execution request." }, { status: 400 })
  }

  const selection = selectPlan({
    workflowId: parsed.data.workflowId,
    modelOverride: parsed.data.modelOverride,
  })
  if (!selection.ok) {
    return Response.json({ error: selection.reason }, { status: 400 })
  }
  if (selection.workflow.executionClass !== "durable") {
    return Response.json(
      { error: `Workflow "${selection.workflow.id}" is inline, not a durable plan execution.` },
      { status: 400 }
    )
  }

  let resolvedModelKeys: Record<string, string>
  try {
    resolvedModelKeys = resolveModelKeysForPlan(selection.plan, selection)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not resolve models for this plan."
    return Response.json({ error: message }, { status: 400 })
  }

  const { env } = await getCloudflareContext({ async: true })
  const owner = await getCurrentOwner(env)

  const execution = await createWorkflowExecution(env, {
    ownerId: owner.id,
    workflowId: selection.workflow.id,
    workflowVersion: "1",
    planId: selection.plan.id,
    planVersion: selection.plan.version,
    executionClass: "durable",
    requestedModelKey: parsed.data.modelOverride,
  })

  const instance = await env.PLAN_EXECUTION_WORKFLOW.create({
    params: {
      workflowExecutionId: execution.id,
      workflowId: selection.workflow.id,
      planId: selection.plan.id,
      ownerId: owner.id,
      input: parsed.data.input,
      resolvedModelKeys,
    },
  })

  return Response.json({ executionId: execution.id, cfInstanceId: instance.id })
}

export async function GET(req: Request) {
  const executionId = new URL(req.url).searchParams.get("executionId")
  if (!executionId) {
    return Response.json({ error: "executionId is required" }, { status: 400 })
  }

  const { env } = await getCloudflareContext({ async: true })
  const execution = await getWorkflowExecution(env, executionId)
  if (!execution) {
    return Response.json({ error: "Execution not found." }, { status: 404 })
  }

  let cfStatus: unknown
  if (execution.cf_workflow_instance_id) {
    const instance = await env.PLAN_EXECUTION_WORKFLOW.get(execution.cf_workflow_instance_id)
    cfStatus = await instance.status()
  }

  return Response.json({ execution, cfStatus })
}
