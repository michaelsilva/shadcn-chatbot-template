import { selectDefaultModelForStep, selectPlan } from "./plan-selection"
import { findWorkflowDefinition } from "./registry"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function runPlanSelectionContractChecks() {
  const unknown = selectPlan({ workflowId: "does-not-exist" })
  assert(!unknown.ok, "an unknown workflow id is rejected")

  const plain = selectPlan({ workflowId: "ask-document" })
  assert(plain.ok, "a workflow with no override selects its default plan")
  assert(plain.ok && plain.plan.id === "default", "default plan is selected")

  const compatibleOverride = selectPlan({
    workflowId: "generate-svg",
    modelOverride: "recraft/recraftv4-1-vector",
  })
  assert(
    compatibleOverride.ok && compatibleOverride.resolvedModelKey === "recraft/recraftv4-1-vector",
    "a model override compatible with the overridable step's required capability is accepted"
  )
  assert(
    compatibleOverride.ok && compatibleOverride.overriddenStepKey === "generate",
    "the overridden step key is reported back"
  )

  const incompatibleOverride = selectPlan({
    workflowId: "generate-svg",
    // A background-removal utility model cannot satisfy svg-generation.
    modelOverride: "fal-ai/imageutils/rembg",
  })
  assert(
    !incompatibleOverride.ok,
    "a model override incompatible with the required capability is rejected, not silently ignored"
  )

  const unknownModel = selectPlan({ workflowId: "generate-svg", modelOverride: "not-a-real-model" })
  assert(!unknownModel.ok, "an override naming a model outside the catalog is rejected")

  const noOverridableStep = selectPlan({
    workflowId: "ask-document",
    modelOverride: "google/gemini-3.7-flash",
  })
  // ask-document's only overridable step requires "reasoning"; gemini has it.
  assert(
    noOverridableStep.ok && noOverridableStep.overriddenStepKey === "answer",
    "ask-document's reasoning step accepts a compatible override"
  )

  const ocrOverrideRejected = selectPlan({
    workflowId: "ask-document",
    // got-ocr has "ocr" but not "reasoning" — the *answer* step is the only overridable one.
    modelOverride: "fal-ai/got-ocr/v2",
  })
  assert(
    !ocrOverrideRejected.ok,
    "an OCR-only model cannot override ask-document's reasoning step"
  )

  const svgWorkflow = findWorkflowDefinition("generate-svg")!
  const generateStep = svgWorkflow.plans[0]!.steps.find((s) => s.key === "generate")
  assert(generateStep?.kind === "model.execute", "fixture sanity: generate step is model.execute")
  const defaultModel = selectDefaultModelForStep(generateStep)
  assert(
    Boolean(defaultModel?.capabilities.includes("svg-generation")),
    "the default model chosen for an un-overridden step actually has the required capability"
  )

  return true
}

void runPlanSelectionContractChecks()
