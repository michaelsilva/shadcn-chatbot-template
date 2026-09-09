import { isServerEnabledModel } from "../model-catalog"
import { MODEL_CATALOG } from "../model-catalog-data"
import { WORKFLOW_REGISTRY, type PlanStep, type WorkflowDefinition } from "./registry"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertThrows(fn: () => unknown, message: string) {
  try {
    fn()
  } catch {
    return
  }
  throw new Error(`${message}: expected error`)
}

function stepKeys(plan: { steps: readonly PlanStep[] }) {
  return plan.steps.map((step) => step.key)
}

function inputRefOf(step: PlanStep): string | undefined {
  switch (step.kind) {
    case "service.toMarkdown":
    case "service.svgPreview":
    case "asset.persist":
    case "result.normalize":
      return step.inputRef
    case "model.execute":
      return step.inputRef
    case "asset.resolve":
    case "external.await":
      return undefined
  }
}

function assertWorkflowIsWellFormed(workflow: WorkflowDefinition) {
  assert(workflow.plans.length > 0, `${workflow.id} declares at least one plan`)

  const planIds = new Set<string>()
  for (const plan of workflow.plans) {
    assert(!planIds.has(plan.id), `${workflow.id} has no duplicate plan ids (${plan.id})`)
    planIds.add(plan.id)

    const keys = stepKeys(plan)
    assert(
      new Set(keys).size === keys.length,
      `${workflow.id}/${plan.id} has unique step keys`
    )

    const seen = new Set<string>()
    for (const step of plan.steps) {
      const ref = inputRefOf(step)
      if (ref !== undefined) {
        assert(
          seen.has(ref),
          `${workflow.id}/${plan.id} step "${step.key}" references an earlier step ("${ref}"), never a later or unknown one`
        )
      }
      seen.add(step.key)
    }

    // Every model.execute step's declared capability must be satisfiable
    // by at least one real, enabled catalog entry (#2/#17) — a workflow
    // can never require a capability nothing in the catalog provides.
    for (const step of plan.steps) {
      if (step.kind !== "model.execute") continue
      const candidates = MODEL_CATALOG.filter(
        (model) => isServerEnabledModel(model) && model.capabilities.includes(step.requiredCapability)
      )
      assert(
        candidates.length > 0,
        `${workflow.id}/${plan.id} step "${step.key}" requires capability "${step.requiredCapability}", which at least one enabled catalog model must provide`
      )
      if (step.compatibleModelKeys?.length) {
        for (const key of step.compatibleModelKeys) {
          assert(
            candidates.some((model) => model.key === key),
            `${workflow.id}/${plan.id} step "${step.key}"'s compatibleModelKeys entry "${key}" must be a real, capable, enabled catalog model`
          )
        }
      }
    }
  }
}

export function runWorkflowRegistryContractChecks() {
  const ids = new Set<string>()
  for (const workflow of WORKFLOW_REGISTRY) {
    assert(!ids.has(workflow.id), `workflow ids are unique (${workflow.id})`)
    ids.add(workflow.id)
    assertWorkflowIsWellFormed(workflow)
  }

  assert(ids.has("chat"), "registry covers chat")
  assert(ids.has("ask-document"), "registry covers ask-document")
  assert(ids.has("generate-svg"), "registry covers generate-svg")
  assert(ids.has("generate-video-clip"), "registry covers generate-video-clip")

  const contextual = [...WORKFLOW_REGISTRY].filter((w) => w.contextualAction)
  assert(contextual.length > 0, "at least one workflow is eligible as a contextual action")

  const inlineWorkflows = WORKFLOW_REGISTRY.filter((w) => w.executionClass === "inline")
  const durableWorkflows = WORKFLOW_REGISTRY.filter((w) => w.executionClass === "durable")
  assert(inlineWorkflows.length > 0, "at least one workflow declares inline execution class")
  assert(durableWorkflows.length > 0, "at least one workflow declares durable execution class")

  assertThrows(() => {
    const workflow = WORKFLOW_REGISTRY.find((w) => w.id === "ask-document")!
    assertWorkflowIsWellFormed({
      ...workflow,
      plans: [
        {
          id: "broken",
          version: "1",
          steps: [
            { key: "answer", kind: "result.normalize", inputRef: "never-existed" },
          ],
        },
      ],
    })
  }, "a plan referencing an unknown/forward step key is rejected")

  return true
}

void runWorkflowRegistryContractChecks()
