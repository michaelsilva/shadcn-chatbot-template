import {
  ConversationEventSchema,
  ConversationMessageSchema,
  ConversationPartSchema,
  applyConversationEvent,
  canTransitionGeneration,
  parseConversationEvent,
  parseConversationMessage,
  serializeConversationEvent,
  serializeConversationMessage,
  type ConversationMessage,
  type ConversationPart,
} from "./conversation"

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

const provenance = {
  executionId: "exec_1",
  workflowExecutionId: "wf_1",
  stepExecutionId: "step_1",
  modelKey: "openai/gpt-5.6-terra",
  provider: "openai",
  transport: "unified-run" as const,
  protocol: "responses" as const,
  upstreamRequestId: "req_1",
  usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, costUsd: 0.01 },
}

const parts: ConversationPart[] = [
  {
    id: "part_text",
    type: "text",
    text: "Hello",
    state: "complete",
  },
  {
    id: "part_image_raster",
    type: "image",
    role: "output",
    representation: "raster",
    asset: {
      assetId: "asset_image_raster",
      kind: "image",
      mimeType: "image/png",
      format: "png",
      width: 1024,
      height: 1024,
      byteSize: 2048,
    },
    alt: "Generated observatory",
    provenance,
  },
  {
    id: "part_image_svg",
    type: "image",
    role: "output",
    representation: "svg",
    asset: {
      assetId: "asset_svg",
      kind: "image",
      mimeType: "image/svg+xml",
      format: "svg",
    },
    provenance,
  },
  {
    id: "part_audio_input",
    type: "audio",
    role: "input",
    asset: {
      assetId: "asset_audio_input",
      kind: "audio",
      mimeType: "audio/wav",
      format: "wav",
      durationMs: 2400,
    },
  },
  {
    id: "part_audio_speech",
    type: "audio",
    role: "speech",
    asset: {
      assetId: "asset_audio_speech",
      kind: "audio",
      mimeType: "audio/mpeg",
      format: "mp3",
      durationMs: 1800,
    },
    voiceIdentity: {
      identityId: "identity_voice_1",
      kind: "cloned-voice",
    },
    provenance,
  },
  {
    id: "part_transcript",
    type: "transcript",
    sourceAssetId: "asset_audio_input",
    text: "Hello there.",
    language: "en",
    speakers: [{ speakerId: "speaker_1", label: "Speaker 1" }],
    segments: [
      {
        id: "segment_1",
        text: "Hello there.",
        speakerId: "speaker_1",
        startMs: 0,
        endMs: 900,
        words: [
          { text: "Hello", startMs: 0, endMs: 400, confidence: 0.99 },
          { text: "there.", startMs: 450, endMs: 900, confidence: 0.98 },
        ],
      },
    ],
    events: [{ type: "laughter", startMs: 1000, endMs: 1200 }],
    provenance,
  },
  {
    id: "part_video",
    type: "video",
    role: "output",
    asset: {
      assetId: "asset_video",
      kind: "video",
      mimeType: "video/mp4",
      format: "mp4",
      width: 1920,
      height: 1080,
      durationMs: 8000,
    },
    posterAssetId: "asset_video_poster",
    hasAudio: true,
    provenance,
  },
  {
    id: "part_model3d",
    type: "model3d",
    role: "output",
    asset: {
      assetId: "asset_model3d",
      kind: "model3d",
      mimeType: "model/gltf-binary",
      format: "glb",
      previewAssetId: "asset_model3d_preview",
    },
    previewAssetId: "asset_model3d_preview",
    geometry: { faceCount: 12000, polygonCount: 6000, vertexCount: 6200 },
    materials: { mode: "pbr", textured: true },
    relatedAssetIds: ["asset_rig"],
    provenance,
  },
  {
    id: "part_derived",
    type: "derived-media",
    operation: "dubbing",
    sourceAssetIds: ["asset_video"],
    outputAssetIds: ["asset_video_es"],
    settings: { sourceLanguage: "en", targetLanguage: "es", speakers: 2 },
    provenance,
  },
  {
    id: "part_file",
    type: "file",
    purpose: "document",
    asset: {
      assetId: "asset_document",
      kind: "file",
      mimeType: "application/pdf",
      fileName: "brief.pdf",
      byteSize: 120000,
    },
  },
  {
    id: "part_source",
    type: "source",
    sourceId: "source_1",
    url: "https://developers.cloudflare.com/ai/",
    title: "Cloudflare AI",
  },
  {
    id: "part_tool",
    type: "tool",
    toolName: "github_repo",
    toolCallId: "tool_call_1",
    state: "succeeded",
    input: { repo: "cloudflare/workers-sdk" },
    output: { stars: 1 },
  },
  {
    id: "part_generation",
    type: "generation",
    jobId: "job_1",
    state: "queued",
    operation: "video.generate",
    modelKey: "google/veo-3.1-fast",
    progress: 0,
    generatedBy: { jobId: "job_1", workflowExecutionId: "wf_1" },
  },
  {
    id: "part_provenance",
    type: "provenance",
    value: provenance,
  },
  {
    id: "part_identity",
    type: "identity",
    identity: {
      identityId: "identity_voice_1",
      kind: "cloned-voice",
    },
    label: "Narration voice",
  },
  {
    id: "part_error",
    type: "error",
    code: "UPSTREAM_RATE_LIMIT",
    message: "Try again later.",
    retryable: true,
    relatedPartId: "part_generation",
    jobId: "job_1",
  },
]

export function runConversationContractChecks() {
  const seenTypes = new Set<string>()
  for (const part of parts) {
    const parsed = ConversationPartSchema.parse(part)
    seenTypes.add(parsed.type)
    assert(
      JSON.stringify(parsed) === JSON.stringify(part),
      `${part.type} part round-trips through runtime schema`
    )
  }

  for (const requiredType of [
    "text",
    "image",
    "audio",
    "transcript",
    "video",
    "model3d",
    "derived-media",
    "file",
    "source",
    "tool",
    "generation",
    "provenance",
    "identity",
    "error",
  ]) {
    assert(seenTypes.has(requiredType), `contract covers ${requiredType}`)
  }

  const message: ConversationMessage = {
    id: "message_1",
    role: "assistant",
    createdAt: "2026-09-09T11:00:00-04:00",
    parts,
  }

  const parsedMessage = parseConversationMessage(serializeConversationMessage(message))
  assert(
    JSON.stringify(parsedMessage) === JSON.stringify(ConversationMessageSchema.parse(message)),
    "complete multimodal message serialization round-trips"
  )

  const event = ConversationEventSchema.parse({
    type: "generation.transition",
    messageId: "message_1",
    partId: "part_generation",
    jobId: "job_1",
    to: "running",
    progress: 0.25,
    statusText: "Rendering",
  })
  assert(
    JSON.stringify(parseConversationEvent(serializeConversationEvent(event))) ===
      JSON.stringify(event),
    "generation event serialization round-trips"
  )

  const running = applyConversationEvent(message, event)
  const runningPart = running.parts.find((part) => part.id === "part_generation")
  assert(
    runningPart?.type === "generation" &&
      runningPart.state === "running" &&
      runningPart.progress === 0.25,
    "generation transition updates the same logical part"
  )

  const resolved = applyConversationEvent(running, {
    type: "generation.resolve",
    messageId: "message_1",
    partId: "part_generation",
    jobId: "job_1",
    result: {
      id: "part_generation",
      type: "video",
      role: "output",
      asset: {
        assetId: "asset_generated_video",
        kind: "video",
        mimeType: "video/mp4",
        format: "mp4",
        durationMs: 8000,
      },
      hasAudio: true,
      provenance,
    },
  })
  const resolvedPart = resolved.parts.find((part) => part.id === "part_generation")
  assert(
    resolvedPart?.type === "video" &&
      resolvedPart.generatedBy?.jobId === "job_1" &&
      resolvedPart.generatedBy.workflowExecutionId === "wf_1",
    "successful generation resolves in place and preserves job lineage"
  )

  const textMessage: ConversationMessage = {
    id: "message_text",
    role: "assistant",
    parts: [{ id: "text_stream", type: "text", text: "Hel", state: "streaming" }],
  }
  const textComplete = applyConversationEvent(textMessage, {
    type: "text.delta",
    messageId: "message_text",
    partId: "text_stream",
    delta: "lo",
    final: true,
  })
  const textPart = textComplete.parts[0]
  assert(
    textPart?.type === "text" &&
      textPart.text === "Hello" &&
      textPart.state === "complete",
    "streaming text delta resolves the existing text part"
  )

  assert(canTransitionGeneration("queued", "running"), "queued can run")
  assert(canTransitionGeneration("running", "succeeded"), "running can succeed")
  assert(!canTransitionGeneration("failed", "running"), "failed is terminal")

  assertThrows(
    () =>
      applyConversationEvent(running, {
        type: "generation.transition",
        messageId: "message_1",
        partId: "part_generation",
        jobId: "job_1",
        to: "queued",
      }),
    "invalid generation transition is rejected"
  )

  assertThrows(
    () =>
      ConversationPartSchema.parse({
        id: "bad_asset",
        type: "image",
        role: "output",
        representation: "svg",
        asset: { assetId: "a", kind: "video" },
      }),
    "asset kind mismatch is rejected"
  )

  assertThrows(
    () =>
      ConversationMessageSchema.parse({
        id: "provider_leak",
        role: "assistant",
        parts: [
          {
            id: "identity_bad",
            type: "identity",
            identity: {
              identityId: "app_identity_1",
              kind: "cloned-voice",
              providerVoiceId: "raw_provider_secretish_id",
            },
          },
        ],
      }),
    "owner identity schema rejects provider-specific identifier leakage"
  )

  return true
}

void runConversationContractChecks()
