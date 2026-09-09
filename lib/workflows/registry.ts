import type { WorkflowSleepDuration } from "cloudflare:workers"

import type { AssetSource } from "../db/assets"
import type { ArtifactKind, ModelCapability } from "../model-catalog"

/**
 * #24's application-owned workflow/execution-plan layer, above the
 * atomic model catalog (#2/#17) and below the composer (#5).
 *
 * A workflow definition and its plans are fixed, code-reviewed
 * TypeScript data compiled into the bundle — never a user-programmable
 * or runtime-editable DAG. `PlanExecutionWorkflow`
 * (workflow-worker/src/plan-execution-workflow.ts) is the small, bounded
 * dispatcher that turns a plan's steps into deterministic Cloudflare
 * Workflow `step.do()`/`step.waitForEvent()` calls (#25) — it is not a
 * generic interpreter; the set of step kinds is closed and reviewed in
 * code, matching #24's explicit non-goal.
 */

export type WorkflowExecutionClass = "inline" | "durable"
export type WorkflowLifecycle = "launch" | "experimental"

export type PlanStepKind =
  | "asset.resolve"
  | "asset.persist"
  | "service.toMarkdown"
  | "service.svgPreview"
  | "model.execute"
  | "external.await"
  | "result.normalize"

interface PlanStepBase {
  /** Stable, deterministic key — becomes the Cloudflare Workflow step name. Never a timestamp or random value. */
  key: string
}

export interface AssetResolveStep extends PlanStepBase {
  kind: "asset.resolve"
  /** Where the asset reference comes from: the workflow's own trigger input. */
  from: "input"
}

export interface ServiceToMarkdownStep extends PlanStepBase {
  kind: "service.toMarkdown"
  inputRef: string
}

export interface ServiceSvgPreviewStep extends PlanStepBase {
  kind: "service.svgPreview"
  inputRef: string
}

export interface ModelExecuteStep extends PlanStepBase {
  kind: "model.execute"
  requiredCapability: ModelCapability
  /** Restricts compatible models beyond the capability match, when needed. */
  compatibleModelKeys?: readonly string[]
  /** Whether a user-supplied model key may replace the server's default pick for this step. */
  overridable?: boolean
  inputRef?: string
}

export interface ExternalAwaitStep extends PlanStepBase {
  kind: "external.await"
  eventType: string
  timeout?: WorkflowSleepDuration
}

export interface AssetPersistStep extends PlanStepBase {
  kind: "asset.persist"
  inputRef: string
  artifactKind: ArtifactKind
  representation: string
  source: AssetSource
}

export interface ResultNormalizeStep extends PlanStepBase {
  kind: "result.normalize"
  inputRef: string
}

export type PlanStep =
  | AssetResolveStep
  | ServiceToMarkdownStep
  | ServiceSvgPreviewStep
  | ModelExecuteStep
  | ExternalAwaitStep
  | AssetPersistStep
  | ResultNormalizeStep

export interface ExecutionPlan {
  id: string
  version: string
  steps: readonly PlanStep[]
}

export interface WorkflowDefinition {
  /** Stable workflow id, e.g. "ask-document". */
  id: string
  name: string
  description: string
  executionClass: WorkflowExecutionClass
  inputArtifactKinds: readonly ArtifactKind[]
  outputArtifactKind: ArtifactKind | "text"
  requiredCapabilities: readonly ModelCapability[]
  plans: readonly ExecutionPlan[]
  lifecycle: WorkflowLifecycle
  /** Eligible as a contextual action on an existing asset/result, not only from the composer. */
  contextualAction: boolean
}

/**
 * Ordinary text/tool chat. Execution stays inline through #3's atomic
 * executor (see app/api/chat/route.ts) — it never runs through
 * PlanExecutionWorkflow — but the plan/step shape here is still the
 * single source of truth for which capability a model override must
 * satisfy, so the composer (#5) and any future validation share one
 * definition instead of two.
 */
const CHAT: WorkflowDefinition = {
  id: "chat",
  name: "Chat",
  description: "Ordinary streaming text/reasoning/tool conversation.",
  executionClass: "inline",
  inputArtifactKinds: ["text"],
  outputArtifactKind: "text",
  requiredCapabilities: ["chat"],
  lifecycle: "launch",
  contextualAction: false,
  plans: [
    {
      id: "default",
      version: "1",
      steps: [{ key: "respond", kind: "model.execute", requiredCapability: "chat", overridable: true }],
    },
  ],
}

/**
 * "Ask about this PDF": convert to Markdown when supported, fall back
 * to OCR when conversion is insufficient, then answer with a reasoning
 * model. Durable because it has multiple meaningful steps and persists
 * extracted content (#6's document_extractions, via the executor).
 */
const ASK_DOCUMENT: WorkflowDefinition = {
  id: "ask-document",
  name: "Ask about a document",
  description: "Convert/OCR a document and answer a question about it.",
  executionClass: "durable",
  inputArtifactKinds: ["file"],
  outputArtifactKind: "text",
  requiredCapabilities: ["ocr", "reasoning"],
  lifecycle: "launch",
  contextualAction: false,
  plans: [
    {
      id: "default",
      version: "1",
      steps: [
        { key: "resolve-source", kind: "asset.resolve", from: "input" },
        { key: "convert-to-markdown", kind: "service.toMarkdown", inputRef: "resolve-source" },
        {
          key: "ocr-fallback",
          kind: "model.execute",
          requiredCapability: "ocr",
          inputRef: "resolve-source",
        },
        {
          key: "answer",
          kind: "model.execute",
          requiredCapability: "reasoning",
          overridable: true,
          inputRef: "convert-to-markdown",
        },
        { key: "normalize-answer", kind: "result.normalize", inputRef: "answer" },
      ],
    },
  ],
}

/**
 * Vector generation, durable original persisted first, then a
 * sanitized/safe preview. If the preview step fails it can retry
 * without repeating the paid generation step (#6's per-step attempt
 * ledger keeps `generate`'s result durable once it succeeds).
 */
const GENERATE_SVG: WorkflowDefinition = {
  id: "generate-svg",
  name: "Generate SVG",
  description: "Generate a vector image, persist the original, and produce a safe preview.",
  executionClass: "durable",
  inputArtifactKinds: ["text"],
  outputArtifactKind: "image",
  requiredCapabilities: ["svg-generation"],
  lifecycle: "launch",
  contextualAction: false,
  plans: [
    {
      id: "default",
      version: "1",
      steps: [
        {
          key: "generate",
          kind: "model.execute",
          requiredCapability: "svg-generation",
          overridable: true,
        },
        {
          key: "persist-original",
          kind: "asset.persist",
          inputRef: "generate",
          artifactKind: "image",
          representation: "original.svg",
          source: "generated",
        },
        { key: "sanitize-preview", kind: "service.svgPreview", inputRef: "persist-original" },
        {
          key: "persist-preview",
          kind: "asset.persist",
          inputRef: "sanitize-preview",
          artifactKind: "image",
          representation: "preview.svg",
          source: "preview",
        },
        { key: "normalize-result", kind: "result.normalize", inputRef: "persist-preview" },
      ],
    },
  ],
}

/** A contextual raster utility transform — the same mechanism as any other durable workflow. */
const REMOVE_BACKGROUND: WorkflowDefinition = {
  id: "remove-background",
  name: "Remove background",
  description: "Remove the background from an existing raster image asset.",
  executionClass: "durable",
  inputArtifactKinds: ["image"],
  outputArtifactKind: "image",
  requiredCapabilities: ["background-removal"],
  lifecycle: "launch",
  contextualAction: true,
  plans: [
    {
      id: "default",
      version: "1",
      steps: [
        { key: "resolve-source", kind: "asset.resolve", from: "input" },
        {
          key: "remove-background",
          kind: "model.execute",
          requiredCapability: "background-removal",
          inputRef: "resolve-source",
        },
        {
          key: "persist-output",
          kind: "asset.persist",
          inputRef: "remove-background",
          artifactKind: "image",
          representation: "background-removed.png",
          source: "derived",
        },
        { key: "normalize-result", kind: "result.normalize", inputRef: "persist-output" },
      ],
    },
  ],
}

/**
 * The queued-provider-job example: `model.execute` submits to a
 * provider-native queue (#3's `submitAtomic`), `external.await` blocks
 * on `step.waitForEvent()` until the validated webhook resolves it via
 * `sendEvent()` (#25's pattern, #10's eventual home for provider
 * mechanics), and only then is the result ingested into R2 (#7).
 */
const GENERATE_VIDEO_CLIP: WorkflowDefinition = {
  id: "generate-video-clip",
  name: "Generate video clip",
  description: "Submit a queued video generation job and ingest the result once it completes.",
  executionClass: "durable",
  inputArtifactKinds: ["text"],
  outputArtifactKind: "video",
  requiredCapabilities: ["video-generation"],
  lifecycle: "launch",
  contextualAction: false,
  plans: [
    {
      id: "default",
      version: "1",
      steps: [
        {
          key: "submit",
          kind: "model.execute",
          requiredCapability: "video-generation",
          overridable: true,
        },
        { key: "await-completion", kind: "external.await", eventType: "provider-job.complete", timeout: "1 hour" },
        {
          key: "persist-output",
          kind: "asset.persist",
          inputRef: "await-completion",
          artifactKind: "video",
          representation: "output.mp4",
          source: "generated",
        },
        { key: "normalize-result", kind: "result.normalize", inputRef: "persist-output" },
      ],
    },
  ],
}

export const WORKFLOW_REGISTRY: readonly WorkflowDefinition[] = [
  CHAT,
  ASK_DOCUMENT,
  GENERATE_SVG,
  REMOVE_BACKGROUND,
  GENERATE_VIDEO_CLIP,
]

export function findWorkflowDefinition(workflowId: string): WorkflowDefinition | undefined {
  return WORKFLOW_REGISTRY.find((workflow) => workflow.id === workflowId)
}

export function findExecutionPlan(
  workflow: WorkflowDefinition,
  planId: string
): ExecutionPlan | undefined {
  return workflow.plans.find((plan) => plan.id === planId)
}
