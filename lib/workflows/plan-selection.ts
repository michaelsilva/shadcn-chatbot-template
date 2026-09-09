import { findEnabledCatalogModel, isServerEnabledModel, type ModelDefinition } from "../model-catalog"
import { MODEL_CATALOG } from "../model-catalog-data"
import { findExecutionPlan, findWorkflowDefinition, type ExecutionPlan, type ModelExecuteStep, type WorkflowDefinition } from "./registry"

/**
 * Server-owned plan/model selection (#24: "Plan selection is server-owned
 * and capability/policy-aware... User model overrides are honored only
 * when compatible."). The browser names a workflow (and optionally a
 * preferred model); this always resolves the actual plan and model, and
 * rejects an incompatible override rather than silently ignoring or
 * blindly trusting it.
 */

export type PlanSelectionResult =
  | {
      ok: true
      workflow: WorkflowDefinition
      plan: ExecutionPlan
      /** The step whose model choice `modelOverride` applied to, if any override was requested. */
      overriddenStepKey?: string
      resolvedModelKey?: string
    }
  | { ok: false; reason: string }

function findOverridableStep(plan: ExecutionPlan): ModelExecuteStep | undefined {
  return plan.steps.find(
    (step): step is ModelExecuteStep => step.kind === "model.execute" && Boolean(step.overridable)
  )
}

function isCompatibleModel(model: ModelDefinition, step: ModelExecuteStep): boolean {
  if (!model.capabilities.includes(step.requiredCapability)) return false
  if (step.compatibleModelKeys?.length) {
    return step.compatibleModelKeys.includes(model.key)
  }
  return true
}

export function selectPlan(input: {
  workflowId: string
  planId?: string
  modelOverride?: string
}): PlanSelectionResult {
  const workflow = findWorkflowDefinition(input.workflowId)
  if (!workflow) {
    return { ok: false, reason: `Unknown workflow "${input.workflowId}".` }
  }

  const plan = input.planId
    ? findExecutionPlan(workflow, input.planId)
    : workflow.plans[0]
  if (!plan) {
    return { ok: false, reason: `Workflow "${workflow.id}" has no plan "${input.planId}".` }
  }

  if (!input.modelOverride) {
    return { ok: true, workflow, plan }
  }

  const overridableStep = findOverridableStep(plan)
  if (!overridableStep) {
    return {
      ok: false,
      reason: `Workflow "${workflow.id}"/"${plan.id}" has no step that accepts a model override.`,
    }
  }

  const model = findEnabledCatalogModel(MODEL_CATALOG, input.modelOverride)
  if (!model) {
    return { ok: false, reason: `Model "${input.modelOverride}" is not an enabled catalog entry.` }
  }
  if (!isCompatibleModel(model, overridableStep)) {
    return {
      ok: false,
      reason: `Model "${input.modelOverride}" does not satisfy the "${overridableStep.requiredCapability}" capability required by "${workflow.id}"/"${plan.id}" step "${overridableStep.key}".`,
    }
  }

  return {
    ok: true,
    workflow,
    plan,
    overriddenStepKey: overridableStep.key,
    resolvedModelKey: model.key,
  }
}

/** Picks the default (first enabled, capability-matching) model for a non-overridden `model.execute` step. */
export function selectDefaultModelForStep(step: ModelExecuteStep): ModelDefinition | undefined {
  return MODEL_CATALOG.find(
    (model) => isServerEnabledModel(model) && isCompatibleModel(model, step)
  )
}

/**
 * Resolves every `model.execute` step in a plan to a concrete catalog
 * key up front — the durable `PlanExecutionWorkflow` instance only ever
 * carries out an already-resolved decision (see its `resolvedModelKeys`
 * param); it never re-derives or re-validates a model choice mid-run.
 */
export function resolveModelKeysForPlan(
  plan: ExecutionPlan,
  selection: { overriddenStepKey?: string; resolvedModelKey?: string }
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const planStep of plan.steps) {
    if (planStep.kind !== "model.execute") continue
    if (planStep.key === selection.overriddenStepKey && selection.resolvedModelKey) {
      resolved[planStep.key] = selection.resolvedModelKey
      continue
    }
    const defaultModel = selectDefaultModelForStep(planStep)
    if (!defaultModel) {
      throw new Error(`No enabled catalog model satisfies step "${planStep.key}"'s required capability.`)
    }
    resolved[planStep.key] = defaultModel.key
  }
  return resolved
}
