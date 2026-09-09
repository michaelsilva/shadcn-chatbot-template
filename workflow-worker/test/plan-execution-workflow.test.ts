import { env } from "cloudflare:workers"
import { introspectWorkflowInstance } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import { createAsset } from "../../lib/db/assets"
import { createConversation } from "../../lib/db/conversations"
import { getOrCreateOwner } from "../../lib/db/owners"
import { createWorkflowExecution, getWorkflowExecution } from "../../lib/db/workflow-executions"
import { claimWebhookDelivery } from "../../lib/db/webhooks"
import { PLAN_EXECUTION_WORKFLOW_NAME } from "../../lib/workflows/constants"

/**
 * These tests never let a `model.execute` or `service.toMarkdown` step
 * touch the real `env.AI` binding — Cloudflare's own tooling warns "AI
 * bindings always access remote resources", and there is no safe,
 * deterministic way to exercise a live Workers AI/Gateway call from CI.
 * Every AI-touching step is intercepted with `mockStepResult`;
 * everything else (D1 writes, R2 reads/writes, asset lineage,
 * conditional branching, `waitForEvent`/`sendEvent`) runs for real
 * against Miniflare's simulated D1/R2.
 */

async function ownerId(subject: string) {
  const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: subject })
  return owner.id
}

/** `conversationId` is only needed when a test checks the projected result message. */
async function createExecution(input: {
  ownerId: string
  workflowId: string
  planId: string
  conversationId?: string
}) {
  return createWorkflowExecution(env, {
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    workflowId: input.workflowId,
    workflowVersion: "1",
    planId: input.planId,
    planVersion: "1",
    executionClass: "durable",
  })
}

describe("PlanExecutionWorkflow: ask-document", () => {
  it("answers directly when Markdown conversion is sufficient, skipping OCR", async () => {
    const owner = await ownerId("plan-ask-document-sufficient")
    const sourceKey = `owners/${owner}/assets/asset_doc_1/original.pdf`
    const source = await createAsset(env, {
      id: "asset_doc_1",
      ownerId: owner,
      r2ObjectKey: sourceKey,
      artifactKind: "file",
      source: "upload",
      mimeType: "application/pdf",
      uploadState: "finalized",
    })
    await env.ASSETS_BUCKET.put(sourceKey, "fake pdf bytes")

    const conversation = await createConversation(env, { ownerId: owner })
    const execution = await createExecution({
      ownerId: owner,
      workflowId: "ask-document",
      planId: "default",
      conversationId: conversation.id,
    })

    await using instance = await introspectWorkflowInstance(
      env.PLAN_EXECUTION_WORKFLOW,
      `wf-${execution.id}`
    )
    await instance.modify(async (m) => {
      await m.disableSleeps()
      await m.mockStepResult(
        { name: "convert-to-markdown" },
        { content: "# Real content\n\nThis document converted cleanly and has plenty of text.", format: "markdown" }
      )
      await m.mockStepResult(
        { name: "answer" },
        { outcome: "immediate", payloadKind: "text", payloadText: "The document says hello." }
      )
    })

    await env.PLAN_EXECUTION_WORKFLOW.create({
      id: `wf-${execution.id}`,
      params: {
        workflowExecutionId: execution.id,
        workflowId: "ask-document",
        planId: "default",
        ownerId: owner,
        input: { assetId: source.id },
        resolvedModelKeys: { "ocr-fallback": "fal-ai/got-ocr/v2", answer: "google/gemini-3.7-flash" },
      },
    })

    await expect(instance.waitForStatus("complete")).resolves.not.toThrow()

    const finalExecution = await getWorkflowExecution(env, execution.id)
    expect(finalExecution?.state).toBe("succeeded")
    expect(finalExecution?.cf_workflow_name).toBe(PLAN_EXECUTION_WORKFLOW_NAME)
    expect(finalExecution?.cf_workflow_instance_id).toBe(`wf-${execution.id}`)

    const resultMessage = await env.DB.prepare(
      `SELECT data_json FROM message_parts WHERE message_id = ?1`
    )
      .bind(finalExecution?.result_message_id)
      .first<{ data_json: string }>()
    const part = JSON.parse(resultMessage!.data_json)
    expect(part.type).toBe("text")
    expect(part.text).toContain("hello")
  })

  it("falls back to OCR when Markdown conversion is insufficient", async () => {
    const owner = await ownerId("plan-ask-document-ocr")
    const sourceKey = `owners/${owner}/assets/asset_doc_2/original.pdf`
    await createAsset(env, {
      id: "asset_doc_2",
      ownerId: owner,
      r2ObjectKey: sourceKey,
      artifactKind: "file",
      source: "upload",
      mimeType: "application/pdf",
      uploadState: "finalized",
    })
    await env.ASSETS_BUCKET.put(sourceKey, "scanned image bytes")

    const execution = await createExecution({ ownerId: owner, workflowId: "ask-document", planId: "default" })

    await using instance = await introspectWorkflowInstance(
      env.PLAN_EXECUTION_WORKFLOW,
      `wf-${execution.id}`
    )
    await instance.modify(async (m) => {
      await m.disableSleeps()
      await m.mockStepResult({ name: "convert-to-markdown" }, { content: "", format: "error" })
      await m.mockStepResult(
        { name: "ocr-fallback" },
        { outcome: "immediate", payloadKind: "text", payloadText: "OCR extracted text." }
      )
      await m.mockStepResult(
        { name: "answer" },
        { outcome: "immediate", payloadKind: "text", payloadText: "Answer derived from OCR." }
      )
    })

    await env.PLAN_EXECUTION_WORKFLOW.create({
      id: `wf-${execution.id}`,
      params: {
        workflowExecutionId: execution.id,
        workflowId: "ask-document",
        planId: "default",
        ownerId: owner,
        input: { assetId: "asset_doc_2" },
        resolvedModelKeys: { "ocr-fallback": "fal-ai/got-ocr/v2", answer: "google/gemini-3.7-flash" },
      },
    })

    await expect(instance.waitForStatus("complete")).resolves.not.toThrow()
    const finalExecution = await getWorkflowExecution(env, execution.id)
    expect(finalExecution?.state).toBe("succeeded")
  })
})

describe("PlanExecutionWorkflow: generate-svg", () => {
  it("persists the original and a sanitized preview as distinct, linked assets", async () => {
    const owner = await ownerId("plan-generate-svg")
    const execution = await createExecution({ ownerId: owner, workflowId: "generate-svg", planId: "default" })

    await using instance = await introspectWorkflowInstance(
      env.PLAN_EXECUTION_WORKFLOW,
      `wf-${execution.id}`
    )
    await instance.modify(async (m) => {
      await m.disableSleeps()
      await m.mockStepResult(
        { name: "generate" },
        {
          outcome: "immediate",
          payloadKind: "text",
          payloadText: '<svg><script>alert(1)</script><circle r="1"/></svg>',
          contentType: "image/svg+xml",
        }
      )
    })

    await env.PLAN_EXECUTION_WORKFLOW.create({
      id: `wf-${execution.id}`,
      params: {
        workflowExecutionId: execution.id,
        workflowId: "generate-svg",
        planId: "default",
        ownerId: owner,
        input: { text: "a red circle" },
        resolvedModelKeys: { generate: "recraft/recraftv4-1-vector" },
      },
    })

    await expect(instance.waitForStatus("complete")).resolves.not.toThrow()

    const finalExecution = await getWorkflowExecution(env, execution.id)
    expect(finalExecution?.state).toBe("succeeded")

    const assets = await env.DB.prepare(
      `SELECT id, representation, mime_type FROM assets WHERE owner_id = ?1 ORDER BY created_at ASC`
    )
      .bind(owner)
      .all<{ id: string; representation: string; mime_type: string }>()
    expect(assets.results).toHaveLength(2)
    const [original, preview] = assets.results
    expect(original!.representation).toBe("original.svg")
    expect(preview!.representation).toBe("preview.svg")
    expect(original!.id).not.toBe(preview!.id)

    const previewObject = await env.ASSETS_BUCKET.get(
      `owners/${owner}/assets/${preview!.id}/preview.svg`
    )
    const previewSvg = await previewObject!.text()
    expect(previewSvg).not.toContain("<script")
    expect(previewSvg).toContain("<circle")

    const relation = await env.DB.prepare(
      `SELECT relation_kind FROM asset_relations WHERE source_asset_id = ?1 AND target_asset_id = ?2`
    )
      .bind(original!.id, preview!.id)
      .first<{ relation_kind: string }>()
    expect(relation?.relation_kind).toBe("preview-of")
  })

  it("produces exactly-once asset state when a persist step is retried", async () => {
    const owner = await ownerId("plan-generate-svg-retry")
    const execution = await createExecution({ ownerId: owner, workflowId: "generate-svg", planId: "default" })

    await using instance = await introspectWorkflowInstance(
      env.PLAN_EXECUTION_WORKFLOW,
      `wf-${execution.id}`
    )
    await instance.modify(async (m) => {
      await m.disableSleeps()
      await m.disableRetryDelays()
      await m.mockStepResult(
        { name: "generate" },
        { outcome: "immediate", payloadKind: "text", payloadText: "<svg><circle r=\"2\"/></svg>", contentType: "image/svg+xml" }
      )
      await m.mockStepError({ name: "persist-original" }, new Error("simulated transient R2 failure"), 1)
    })

    await env.PLAN_EXECUTION_WORKFLOW.create({
      id: `wf-${execution.id}`,
      params: {
        workflowExecutionId: execution.id,
        workflowId: "generate-svg",
        planId: "default",
        ownerId: owner,
        input: { text: "a circle" },
        resolvedModelKeys: { generate: "recraft/recraftv4-1-vector" },
      },
    })

    await expect(instance.waitForStatus("complete")).resolves.not.toThrow()

    const originals = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM assets WHERE owner_id = ?1 AND representation = 'original.svg'`
    )
      .bind(owner)
      .first<{ count: number }>()
    expect(originals?.count).toBe(1)
  })
})

describe("PlanExecutionWorkflow: remove-background (contextual raster transform)", () => {
  it("uses the same plan-execution mechanism as any other durable workflow", async () => {
    const owner = await ownerId("plan-remove-background")
    const sourceKey = `owners/${owner}/assets/asset_img_1/original.png`
    await createAsset(env, {
      id: "asset_img_1",
      ownerId: owner,
      r2ObjectKey: sourceKey,
      artifactKind: "image",
      source: "upload",
      mimeType: "image/png",
      uploadState: "finalized",
    })
    await env.ASSETS_BUCKET.put(sourceKey, "fake png bytes")

    const execution = await createExecution({ ownerId: owner, workflowId: "remove-background", planId: "default" })

    await using instance = await introspectWorkflowInstance(
      env.PLAN_EXECUTION_WORKFLOW,
      `wf-${execution.id}`
    )
    await instance.modify(async (m) => {
      await m.disableSleeps()
      await m.mockStepResult(
        { name: "remove-background" },
        { outcome: "immediate", payloadKind: "text", payloadText: "fake-transparent-png", contentType: "image/png" }
      )
    })

    await env.PLAN_EXECUTION_WORKFLOW.create({
      id: `wf-${execution.id}`,
      params: {
        workflowExecutionId: execution.id,
        workflowId: "remove-background",
        planId: "default",
        ownerId: owner,
        input: { assetId: "asset_img_1" },
        resolvedModelKeys: { "remove-background": "fal-ai/imageutils/rembg" },
      },
    })

    await expect(instance.waitForStatus("complete")).resolves.not.toThrow()

    const relation = await env.DB.prepare(
      `SELECT relation_kind FROM asset_relations WHERE source_asset_id = ?1`
    )
      .bind("asset_img_1")
      .first<{ relation_kind: string }>()
    expect(relation?.relation_kind).toBe("derived-from")
  })
})

describe("PlanExecutionWorkflow: generate-video-clip (queued job + external event)", () => {
  it("submits, waits on the external event, and ingests the result once it resolves", async () => {
    const owner = await ownerId("plan-video-clip")
    const conversation = await createConversation(env, { ownerId: owner })
    const execution = await createExecution({
      ownerId: owner,
      workflowId: "generate-video-clip",
      planId: "default",
      conversationId: conversation.id,
    })
    const cfInstanceId = `wf-${execution.id}`

    // Same waitForEvent/sendEvent mechanism #25's RuntimeProbeWorkflow
    // test already proves end to end (including a real webhook route
    // calling instance.sendEvent() after a D1 idempotency claim — see
    // that test and test/db/webhooks.test.ts for the mechanism itself).
    // This test's job is to prove *this* plan wires external.await
    // correctly: submits, blocks, and ingests the resolved payload.
    await using instance = await introspectWorkflowInstance(env.PLAN_EXECUTION_WORKFLOW, cfInstanceId)
    await instance.modify(async (m) => {
      await m.disableSleeps()
      // The real "submit" step also writes external_jobs/step_attempts
      // rows (already covered in isolation by
      // test/db/workflow-executions.test.ts's own recordStepAttempt/
      // createExternalJob tests) — mocking its *result* here keeps this
      // test focused on the plan's external-event wiring without a
      // live provider call.
      await m.mockStepResult({ name: "submit" }, { outcome: "submitted", providerJobId: "provider-job-1" })
      await m.mockEvent({
        type: "provider-job.complete",
        payload: { resultUrl: "https://provider.example/video/output.mp4" },
      })
      // "persist-output" would otherwise fetch() the mocked event's
      // resultUrl for real — a non-existent host that would hang the
      // sandbox rather than fail fast. The fetch-and-ingest path itself
      // (content-type validation, idempotent R2 write) is already
      // covered with an injectable fetch in
      // test/storage/provider-ingestion.test.ts; this test's job is the
      // external.await wiring, not re-proving ingestion.
      await m.mockStepResult(
        { name: "persist-output" },
        {
          asset: {
            id: "asset_video_result",
            owner_id: owner,
            r2_object_key: `owners/${owner}/assets/asset_video_result/output.mp4`,
            artifact_kind: "video",
            mime_type: "video/mp4",
            representation: null,
            byte_size: null,
            checksum: null,
            source: "generated",
            upload_state: "finalized",
            metadata_json: null,
            created_at: new Date().toISOString(),
            deleted_at: null,
          },
        }
      )
    })

    await env.PLAN_EXECUTION_WORKFLOW.create({
      id: cfInstanceId,
      params: {
        workflowExecutionId: execution.id,
        workflowId: "generate-video-clip",
        planId: "default",
        ownerId: owner,
        input: { text: "a dog running" },
        resolvedModelKeys: { submit: "google/veo-3.1" },
      },
    })

    await expect(instance.waitForStatus("complete")).resolves.not.toThrow()

    const finalExecution = await getWorkflowExecution(env, execution.id)
    expect(finalExecution?.state).toBe("succeeded")
    expect(finalExecution?.result_message_id).not.toBeNull()

    const resultPart = await env.DB.prepare(
      `SELECT data_json FROM message_parts WHERE message_id = ?1`
    )
      .bind(finalExecution?.result_message_id)
      .first<{ data_json: string }>()
    const part = JSON.parse(resultPart!.data_json)
    expect(part).toMatchObject({ type: "video", asset: { assetId: "asset_video_result" } })
  })

  it("claims a webhook delivery exactly once, matching the route's idempotency guard", async () => {
    // The actual sendEvent()-to-a-running-instance mechanics are proven
    // above (via mockEvent) and in #25's runtime-probe test; this
    // isolates the D1 idempotency claim app/api/workflows/plan-execution/
    // webhook/route.ts performs before ever calling sendEvent().
    const first = await claimWebhookDelivery(env, { provider: "google", eventKey: "provider-job-2" })
    expect(first.claimed).toBe(true)

    const duplicate = await claimWebhookDelivery(env, { provider: "google", eventKey: "provider-job-2" })
    expect(duplicate.claimed).toBe(false)
  })
})
