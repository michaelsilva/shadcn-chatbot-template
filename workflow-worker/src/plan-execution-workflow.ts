import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"

import { executeAtomic, submitAtomic, type AtomicExecutorEnv } from "../../lib/atomic-executor"
import type { ConversationPart } from "../../lib/conversation"
import { addAssetRelation, createAsset, getAsset, markAssetUploadState, type AssetRow } from "../../lib/db/assets"
import { newId } from "../../lib/db/ids"
import {
  createExternalJob,
  finalizeWorkflowExecution,
  mapCloudflareWorkflowInstance,
  recordStepAttempt,
} from "../../lib/db/workflow-executions"
import { findEnabledCatalogModel } from "../../lib/model-catalog"
import { MODEL_CATALOG } from "../../lib/model-catalog-data"
import type { AssetBucketEnv } from "../../lib/storage/env"
import { PLAN_EXECUTION_WORKFLOW_NAME } from "../../lib/workflows/constants"
import { findExecutionPlan, findWorkflowDefinition, type PlanStep } from "../../lib/workflows/registry"
import { sanitizeSvgForPreview } from "../../lib/workflows/svg-sanitize"

export { PLAN_EXECUTION_WORKFLOW_NAME }

export interface PlanExecutionParams {
  workflowExecutionId: string
  workflowId: string
  planId: string
  ownerId: string
  input: {
    /** Text prompt, e.g. for generate-svg/generate-video-clip/chat-shaped steps. */
    text?: string
    /** Source asset id, for workflows whose first step resolves an existing asset (ask-document, remove-background). */
    assetId?: string
  }
  /**
   * Every `model.execute` step's key mapped to the catalog key it must
   * use, resolved once by `lib/workflows/plan-selection.ts` *before*
   * this durable instance was created. Plan/model selection is
   * server-owned policy (#24) — the durable execution only carries out
   * an already-resolved decision, it never re-derives or re-validates
   * a model override.
   */
  resolvedModelKeys: Record<string, string>
}

interface Env extends AssetBucketEnv, AtomicExecutorEnv {}

interface StepContext {
  workflowExecutionId: string
  ownerId: string
  input: PlanExecutionParams["input"]
  resolvedModelKeys: Record<string, string>
  results: Map<string, unknown>
}

interface MarkdownResult {
  content?: string
  format: string
}

interface AssetPersistResult {
  asset: AssetRow
}

/**
 * `step.do()` results are durably persisted by the Workflows engine and
 * must satisfy Cloudflare's `Serializable<T>` constraint at the type
 * level — `AtomicImmediateResult`/`AtomicSubmissionHandle` (#3) embed a
 * full `ModelDefinition` and `unknown`-typed JSON payloads, neither of
 * which type-checks as serializable. This is the normalized, genuinely
 * serializable shape every `model.execute` step returns instead; a JSON
 * payload is carried as a `JSON.stringify`'d string rather than
 * `unknown`.
 */
interface SerializableModelResult {
  outcome: "immediate" | "submitted"
  payloadKind?: "json" | "text" | "binary"
  payloadJson?: string
  payloadText?: string
  payloadBinary?: ArrayBuffer
  contentType?: string
  providerJobId?: string
}

/** A scanned/unsupported document produces empty or error output — that's the OCR-fallback trigger. */
function isMarkdownConversionInsufficient(markdown: MarkdownResult): boolean {
  return markdown.format === "error" || !markdown.content || markdown.content.trim().length < 40
}

/**
 * #24's small, bounded plan dispatcher: a fixed, code-reviewed switch
 * over the closed `PlanStepKind` set, driving Cloudflare Workflow
 * `step.do()`/`step.waitForEvent()` calls with deterministic,
 * plan-defined step keys. This is not a generic DAG interpreter — the
 * plan itself is fixed TypeScript data compiled into this bundle (see
 * lib/workflows/registry.ts); adding a new step kind is a code change
 * here, not a runtime capability, and the one piece of real branching
 * (ask-document's OCR fallback) is ordinary Workflow control flow, not
 * part of the generic dispatch.
 */
export class PlanExecutionWorkflow extends WorkflowEntrypoint<Env, PlanExecutionParams> {
  async run(event: WorkflowEvent<PlanExecutionParams>, step: WorkflowStep) {
    const { workflowExecutionId, workflowId, planId, ownerId, input, resolvedModelKeys } = event.payload

    await step.do("map-instance", () =>
      mapCloudflareWorkflowInstance(this.env, {
        executionId: workflowExecutionId,
        cfWorkflowName: PLAN_EXECUTION_WORKFLOW_NAME,
        cfWorkflowInstanceId: event.instanceId,
      })
    )

    const workflow = findWorkflowDefinition(workflowId)
    if (!workflow) throw new Error(`Unknown workflow "${workflowId}".`)
    const plan = findExecutionPlan(workflow, planId)
    if (!plan) throw new Error(`Unknown plan "${planId}" for workflow "${workflowId}".`)

    const ctx: StepContext = { workflowExecutionId, ownerId, input, resolvedModelKeys, results: new Map() }

    try {
      for (const planStep of plan.steps) {
        if (planStep.key === "ocr-fallback") {
          const markdown = ctx.results.get("convert-to-markdown") as MarkdownResult | undefined
          if (markdown && !isMarkdownConversionInsufficient(markdown)) {
            ctx.results.set(planStep.key, { skipped: true, reason: "markdown-conversion-sufficient" })
            continue
          }
        }

        const result = await this.executeStep(step, planStep, ctx)
        ctx.results.set(planStep.key, result)
      }

      const resultParts = this.collectResultParts(plan.steps, ctx)

      // finalizeWorkflowExecution()'s return type (a full canonical
      // ConversationMessage, #4) is too deep a discriminated union for
      // TS to check against Serializable<T> without hitting its
      // instantiation-depth limit — and step.do() results are meant to
      // stay small (#25) anyway, so the callback discards it.
      await step.do("finalize", async (): Promise<void> => {
        await finalizeWorkflowExecution(this.env, {
          executionId: workflowExecutionId,
          state: "succeeded",
          resultParts,
        })
      })

      return { state: "succeeded" as const }
    } catch (error) {
      await step.do("finalize-failed", async (): Promise<void> => {
        await finalizeWorkflowExecution(this.env, { executionId: workflowExecutionId, state: "failed" })
      })
      throw error
    }
  }

  /**
   * Resolves the plan's actual final output, not just its last step:
   * a `result.normalize` step is a pure alias (see `executeStep`), so
   * its own key never holds a value — the real result lives under
   * whatever step key it references, which can be either an
   * `asset.persist` step (generate-svg, remove-background,
   * generate-video-clip) or a `model.execute` step (ask-document's
   * text answer). Both shapes are handled here rather than assumed
   * from the last step's own kind.
   */
  private collectResultParts(steps: readonly PlanStep[], ctx: StepContext): ConversationPart[] | undefined {
    const lastStep = steps[steps.length - 1]
    if (!lastStep) return undefined

    const [producingStep, result] =
      lastStep.kind === "result.normalize"
        ? [steps.find((s) => s.key === lastStep.inputRef), ctx.results.get(lastStep.inputRef)]
        : [lastStep, ctx.results.get(lastStep.key)]
    if (!producingStep || !result || typeof result !== "object") return undefined

    if (producingStep.kind === "asset.persist") {
      const { asset } = result as AssetPersistResult
      const part: ConversationPart =
        producingStep.artifactKind === "video"
          ? {
              id: `part_${asset.id}`,
              type: "video",
              role: "output",
              asset: { assetId: asset.id, kind: "video", mimeType: asset.mime_type ?? undefined },
            }
          : {
              id: `part_${asset.id}`,
              type: "image",
              role: "output",
              representation: producingStep.representation.endsWith(".svg") ? "svg" : "raster",
              asset: { assetId: asset.id, kind: "image", mimeType: asset.mime_type ?? undefined },
            }
      return [part]
    }

    if (producingStep.kind === "model.execute") {
      const answer = result as SerializableModelResult
      if (answer.outcome === "immediate" && answer.payloadKind === "text" && answer.payloadText !== undefined) {
        return [
          { id: `part_${ctx.workflowExecutionId}_answer`, type: "text", text: answer.payloadText, state: "complete" },
        ]
      }
      if (answer.outcome === "immediate" && answer.payloadKind === "json" && answer.payloadJson !== undefined) {
        return [
          { id: `part_${ctx.workflowExecutionId}_answer`, type: "text", text: answer.payloadJson, state: "complete" },
        ]
      }
    }

    return undefined
  }

  private async executeStep(step: WorkflowStep, planStep: PlanStep, ctx: StepContext): Promise<unknown> {
    switch (planStep.kind) {
      case "asset.resolve":
        return step.do(planStep.key, async () => {
          if (!ctx.input.assetId) throw new Error("Workflow input did not include assetId to resolve.")
          const asset = await getAsset(this.env, { ownerId: ctx.ownerId, assetId: ctx.input.assetId })
          if (!asset) throw new Error(`Asset ${ctx.input.assetId} not found.`)
          return asset
        })

      case "service.toMarkdown":
        return step.do(planStep.key, async (): Promise<MarkdownResult> => {
          const asset = ctx.results.get(planStep.inputRef) as AssetRow
          const object = await this.env.ASSETS_BUCKET.get(asset.r2_object_key)
          if (!object) throw new Error(`R2 object missing for asset ${asset.id}.`)
          const blob = new Blob([await object.arrayBuffer()], {
            type: asset.mime_type ?? "application/octet-stream",
          })
          const converted = await this.env.AI.toMarkdown({
            name: asset.r2_object_key.split("/").pop() ?? asset.id,
            blob,
          })
          const single = Array.isArray(converted) ? converted[0] : converted
          return { content: single?.data, format: single?.format ?? "error" }
        })

      case "model.execute":
        return this.executeModelStep(step, planStep, ctx)

      case "external.await": {
        // waitForEvent() resolves to { type, payload, timestamp } — the
        // event's payload is what downstream steps (asset.persist) care
        // about, not the wrapper.
        const resolved = await step.waitForEvent<{ resultUrl?: string }>(planStep.key, {
          type: planStep.eventType,
          timeout: planStep.timeout ?? "24 hours",
        })
        return resolved.payload
      }

      case "service.svgPreview":
        return step.do(planStep.key, async () => {
          // "persist-original"'s result is an AssetPersistResult
          // ({ asset }), not a bare AssetRow.
          const { asset } = ctx.results.get(planStep.inputRef) as AssetPersistResult
          const object = await this.env.ASSETS_BUCKET.get(asset.r2_object_key)
          if (!object) throw new Error(`R2 object missing for asset ${asset.id}.`)
          return sanitizeSvgForPreview(await object.text())
        })

      case "asset.persist":
        return this.persistAssetStep(step, planStep, ctx)

      case "result.normalize":
        // Pure in-memory aliasing to whatever the referenced step
        // produced — no external side effect to protect with a durable
        // step.do(); collectResultParts() reads straight through it.
        return Promise.resolve(ctx.results.get(planStep.inputRef))
    }
  }

  private async executeModelStep(
    step: WorkflowStep,
    planStep: Extract<PlanStep, { kind: "model.execute" }>,
    ctx: StepContext
  ) {
    const modelKey = ctx.resolvedModelKeys[planStep.key]
    if (!modelKey) {
      throw new Error(`No resolved model for step "${planStep.key}" — plan-selection.ts must resolve every model.execute step before the instance is created.`)
    }
    const catalogModel = findEnabledCatalogModel(MODEL_CATALOG, modelKey)
    if (!catalogModel) throw new Error(`Resolved model "${modelKey}" is not an enabled catalog entry.`)

    const priorResult = planStep.inputRef ? ctx.results.get(planStep.inputRef) : undefined
    const modelInput: Record<string, unknown> = {}
    if (ctx.input.text) modelInput.prompt = ctx.input.text
    if (priorResult && typeof priorResult === "object") {
      if ("content" in priorResult) modelInput.prompt = (priorResult as MarkdownResult).content ?? modelInput.prompt
      if ("r2_object_key" in priorResult) modelInput.assetId = (priorResult as AssetRow).id
    }

    return step.do(planStep.key, async (): Promise<SerializableModelResult> => {
      const attempt = await recordStepAttempt(this.env, {
        workflowExecutionId: ctx.workflowExecutionId,
        stepKey: planStep.key,
        stepKind: "model.execute",
        catalogKey: modelKey,
        resolvedCatalogKey: modelKey,
        stepState: "running",
        attemptState: "running",
      })

      try {
        if (catalogModel.execution.result === "queued") {
          const submission = await submitAtomic(this.env, {
            modelKey,
            input: modelInput,
            ownerId: ctx.ownerId,
            workflowStepId: planStep.key,
          })
          await createExternalJob(this.env, {
            stepAttemptId: attempt.attemptId,
            provider: submission.externalJob.provider,
            catalogKey: modelKey,
            providerJobId: submission.externalJob.requestId,
            state: submission.externalJob.initialState,
          })
          await recordStepAttempt(this.env, {
            workflowExecutionId: ctx.workflowExecutionId,
            stepKey: planStep.key,
            stepKind: "model.execute",
            catalogKey: modelKey,
            stepState: "succeeded",
            attemptState: "succeeded",
          })
          return { outcome: "submitted", providerJobId: submission.externalJob.requestId }
        }

        const result = await executeAtomic(this.env, {
          modelKey,
          input: modelInput,
          ownerId: ctx.ownerId,
          workflowStepId: planStep.key,
        })
        await recordStepAttempt(this.env, {
          workflowExecutionId: ctx.workflowExecutionId,
          stepKey: planStep.key,
          stepKind: "model.execute",
          catalogKey: modelKey,
          stepState: "succeeded",
          attemptState: "succeeded",
        })

        if (result.payload.type === "binary") {
          return {
            outcome: "immediate",
            payloadKind: "binary",
            payloadBinary: result.payload.value,
            contentType: result.payload.contentType,
          }
        }
        if (result.payload.type === "text") {
          return {
            outcome: "immediate",
            payloadKind: "text",
            payloadText: result.payload.value,
            contentType: result.payload.contentType,
          }
        }
        return {
          outcome: "immediate",
          payloadKind: "json",
          payloadJson: JSON.stringify(result.payload.value),
        }
      } catch (error) {
        await recordStepAttempt(this.env, {
          workflowExecutionId: ctx.workflowExecutionId,
          stepKey: planStep.key,
          stepKind: "model.execute",
          catalogKey: modelKey,
          stepState: "failed",
          attemptState: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    })
  }

  private async persistAssetStep(
    step: WorkflowStep,
    planStep: Extract<PlanStep, { kind: "asset.persist" }>,
    ctx: StepContext
  ): Promise<AssetPersistResult> {
    return step.do(planStep.key, async (): Promise<AssetPersistResult> => {
      const upstream = ctx.results.get(planStep.inputRef)

      // The asset id — and therefore the unique r2_object_key — is
      // generated up front, exactly like lib/storage/uploads.ts's
      // createUploadIntent(): no placeholder value ever touches the
      // unique index, which matters here because a plan can have more
      // than one asset.persist step (generate-svg has two).
      const assetId = newId("asset")
      const key = `owners/${ctx.ownerId}/assets/${assetId}/${planStep.representation}`
      const asset = await createAsset(this.env, {
        id: assetId,
        ownerId: ctx.ownerId,
        r2ObjectKey: key,
        artifactKind: planStep.artifactKind,
        source: planStep.source,
        representation: planStep.representation,
        uploadState: "pending",
      })
      const contentType = await this.writeUpstreamToR2(key, upstream)

      await this.env.DB.prepare(`UPDATE assets SET mime_type = ?1 WHERE id = ?2`)
        .bind(contentType, asset.id)
        .run()
      const object = await this.env.ASSETS_BUCKET.head(key)
      await markAssetUploadState(this.env, {
        ownerId: ctx.ownerId,
        assetId: asset.id,
        uploadState: "finalized",
        byteSize: object?.size,
      })

      await this.recordLineage(planStep, asset, ctx)

      return { asset: { ...asset, r2_object_key: key, mime_type: contentType } }
    })
  }

  /** Writes whatever the upstream step produced to R2 and returns the content-type that was actually stored. */
  private async writeUpstreamToR2(key: string, upstream: unknown): Promise<string> {
    if (upstream && typeof upstream === "object" && "sanitizedSvg" in upstream) {
      const contentType = "image/svg+xml"
      await this.env.ASSETS_BUCKET.put(key, (upstream as { sanitizedSvg: string }).sanitizedSvg, {
        httpMetadata: { contentType },
      })
      return contentType
    }

    if (upstream && typeof upstream === "object" && "outcome" in upstream && (upstream as SerializableModelResult).outcome === "immediate") {
      const modelResult = upstream as SerializableModelResult
      if (modelResult.payloadKind === "binary" && modelResult.payloadBinary) {
        const contentType = modelResult.contentType ?? "application/octet-stream"
        await this.env.ASSETS_BUCKET.put(key, modelResult.payloadBinary, { httpMetadata: { contentType } })
        return contentType
      }
      if (modelResult.payloadKind === "text" && modelResult.payloadText !== undefined) {
        const contentType = modelResult.contentType ?? "text/plain"
        await this.env.ASSETS_BUCKET.put(key, modelResult.payloadText, { httpMetadata: { contentType } })
        return contentType
      }
      const contentType = "application/json"
      await this.env.ASSETS_BUCKET.put(key, modelResult.payloadJson ?? "null", { httpMetadata: { contentType } })
      return contentType
    }

    if (upstream && typeof upstream === "object" && "resultUrl" in upstream) {
      const resultUrl = (upstream as { resultUrl?: string }).resultUrl
      if (!resultUrl) throw new Error("External event did not include a resultUrl to ingest.")
      const response = await fetch(resultUrl)
      if (!response.ok || !response.body) {
        throw new Error(`Failed to fetch provider result: HTTP ${response.status}.`)
      }
      const contentType = response.headers.get("content-type") ?? "application/octet-stream"
      await this.env.ASSETS_BUCKET.put(key, response.body, { httpMetadata: { contentType } })
      return contentType
    }

    throw new Error("No persistable upstream result for this asset.persist step.")
  }

  /** Fixed, explicit lineage per known plan shape — never a generic "search for something asset-shaped" heuristic. */
  private async recordLineage(
    planStep: Extract<PlanStep, { kind: "asset.persist" }>,
    asset: AssetRow,
    ctx: StepContext
  ) {
    if (planStep.key === "persist-preview") {
      const original = ctx.results.get("persist-original") as AssetPersistResult | undefined
      if (original) {
        await addAssetRelation(this.env, {
          sourceAssetId: original.asset.id,
          targetAssetId: asset.id,
          relationKind: "preview-of",
          workflowExecutionId: ctx.workflowExecutionId,
        })
      }
      return
    }

    const resolvedSource = ctx.results.get("resolve-source") as AssetRow | undefined
    if (resolvedSource) {
      await addAssetRelation(this.env, {
        sourceAssetId: resolvedSource.id,
        targetAssetId: asset.id,
        relationKind: "derived-from",
        workflowExecutionId: ctx.workflowExecutionId,
      })
    }
  }
}
