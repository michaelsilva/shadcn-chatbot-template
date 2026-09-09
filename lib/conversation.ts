import { z } from "zod"

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
)

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema)
export type JsonObject = z.infer<typeof JsonObjectSchema>

export const ArtifactKindSchema = z.enum([
  "text",
  "image",
  "audio",
  "video",
  "file",
  "model3d",
])
export type ConversationArtifactKind = z.infer<typeof ArtifactKindSchema>

export const AssetReferenceSchema = z.object({
  assetId: z.string().min(1),
  kind: z.enum(["image", "audio", "video", "file", "model3d"]),
  mimeType: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  byteSize: z.number().int().nonnegative().optional(),
  format: z.string().min(1).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  previewAssetId: z.string().min(1).optional(),
  checksum: z.string().min(1).optional(),
})
export type AssetReference = z.infer<typeof AssetReferenceSchema>

export const OwnerScopedIdentityLinkSchema = z.object({
  identityId: z.string().min(1),
  kind: z.enum([
    "cloned-voice",
    "designed-voice",
    "reference-voice",
    "speaker-embedding",
    "custom-element",
  ]),
})
export type OwnerScopedIdentityLink = z.infer<
  typeof OwnerScopedIdentityLinkSchema
>

export const UsageSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
})
export type UsageSummary = z.infer<typeof UsageSummarySchema>

export const ProvenanceReferenceSchema = z.object({
  executionId: z.string().min(1),
  workflowExecutionId: z.string().min(1).optional(),
  stepExecutionId: z.string().min(1).optional(),
  modelKey: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  transport: z
    .enum(["workers-binding", "unified-run", "gateway-provider-native"])
    .optional(),
  protocol: z
    .enum([
      "workers-ai",
      "unified-run",
      "chat-completions",
      "responses",
      "messages",
      "provider-native",
    ])
    .optional(),
  upstreamRequestId: z.string().min(1).optional(),
  usage: UsageSummarySchema.optional(),
})
export type ProvenanceReference = z.infer<typeof ProvenanceReferenceSchema>

export const GeneratedBySchema = z.object({
  jobId: z.string().min(1),
  workflowExecutionId: z.string().min(1).optional(),
  stepExecutionId: z.string().min(1).optional(),
})
export type GeneratedBy = z.infer<typeof GeneratedBySchema>

const basePartFields = {
  id: z.string().min(1),
  createdAt: z.string().min(1).optional(),
  provenance: ProvenanceReferenceSchema.optional(),
  generatedBy: GeneratedBySchema.optional(),
} as const

export const TextPartSchema = z.object({
  ...basePartFields,
  type: z.literal("text"),
  text: z.string(),
  state: z.enum(["streaming", "complete"]).default("complete"),
})
export type TextPart = z.infer<typeof TextPartSchema>

export const ImagePartSchema = z.object({
  ...basePartFields,
  type: z.literal("image"),
  role: z.enum(["input", "output", "derived"]),
  representation: z.enum(["raster", "svg"]),
  asset: AssetReferenceSchema.extend({ kind: z.literal("image") }),
  alt: z.string().optional(),
  sourceAssetIds: z.array(z.string().min(1)).optional(),
})
export type ImagePart = z.infer<typeof ImagePartSchema>

export const AudioPartSchema = z.object({
  ...basePartFields,
  type: z.literal("audio"),
  role: z.enum(["input", "speech", "music", "sound-effect", "transformed"]),
  asset: AssetReferenceSchema.extend({ kind: z.literal("audio") }),
  transcriptPartId: z.string().min(1).optional(),
  voiceIdentity: OwnerScopedIdentityLinkSchema.optional(),
  sourceAssetIds: z.array(z.string().min(1)).optional(),
})
export type AudioPart = z.infer<typeof AudioPartSchema>

export const TranscriptWordSchema = z.object({
  text: z.string(),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
})
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>

export const TranscriptSegmentSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  speakerId: z.string().min(1).optional(),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  words: z.array(TranscriptWordSchema).optional(),
  confidence: z.number().min(0).max(1).optional(),
})
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>

export const TranscriptEventSchema = z.object({
  type: z.enum(["music", "laughter", "applause", "noise", "silence", "other"]),
  label: z.string().min(1).optional(),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
})
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>

export const TranscriptPartSchema = z.object({
  ...basePartFields,
  type: z.literal("transcript"),
  sourceAssetId: z.string().min(1),
  text: z.string(),
  language: z.string().min(1).optional(),
  speakers: z
    .array(
      z.object({
        speakerId: z.string().min(1),
        label: z.string().min(1).optional(),
      })
    )
    .optional(),
  segments: z.array(TranscriptSegmentSchema),
  events: z.array(TranscriptEventSchema).optional(),
})
export type TranscriptPart = z.infer<typeof TranscriptPartSchema>

export const VideoPartSchema = z.object({
  ...basePartFields,
  type: z.literal("video"),
  role: z.enum(["input", "output", "derived"]),
  asset: AssetReferenceSchema.extend({ kind: z.literal("video") }),
  posterAssetId: z.string().min(1).optional(),
  hasAudio: z.boolean().optional(),
  sourceAssetIds: z.array(z.string().min(1)).optional(),
})
export type VideoPart = z.infer<typeof VideoPartSchema>

export const Model3DPartSchema = z.object({
  ...basePartFields,
  type: z.literal("model3d"),
  role: z.enum(["input", "output", "derived"]),
  asset: AssetReferenceSchema.extend({ kind: z.literal("model3d") }),
  previewAssetId: z.string().min(1).optional(),
  geometry: z
    .object({
      faceCount: z.number().int().nonnegative().optional(),
      polygonCount: z.number().int().nonnegative().optional(),
      vertexCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  materials: z
    .object({
      mode: z.enum(["none", "basic", "pbr"]),
      textured: z.boolean(),
    })
    .optional(),
  relatedAssetIds: z.array(z.string().min(1)).optional(),
  sourceAssetIds: z.array(z.string().min(1)).optional(),
})
export type Model3DPart = z.infer<typeof Model3DPartSchema>

export const DerivedMediaOperationSchema = z.enum([
  "image-edit",
  "background-removal",
  "upscale",
  "video-edit",
  "video-extension",
  "audio-isolation",
  "voice-conversion",
  "dubbing",
  "model3d-rigging",
  "model3d-animation",
  "other",
])
export type DerivedMediaOperation = z.infer<
  typeof DerivedMediaOperationSchema
>

export const DerivedMediaPartSchema = z.object({
  ...basePartFields,
  type: z.literal("derived-media"),
  operation: DerivedMediaOperationSchema,
  customOperation: z.string().min(1).optional(),
  sourceAssetIds: z.array(z.string().min(1)).min(1),
  outputAssetIds: z.array(z.string().min(1)).min(1),
  settings: JsonObjectSchema.default({}),
})
export type DerivedMediaPart = z.infer<typeof DerivedMediaPartSchema>

export const FilePartSchema = z.object({
  ...basePartFields,
  type: z.literal("file"),
  purpose: z.enum(["attachment", "document", "reference", "other"]),
  asset: AssetReferenceSchema.extend({ kind: z.literal("file") }),
})
export type FilePart = z.infer<typeof FilePartSchema>

export const SourcePartSchema = z.object({
  ...basePartFields,
  type: z.literal("source"),
  sourceId: z.string().min(1),
  url: z.string().url(),
  title: z.string().optional(),
})
export type SourcePart = z.infer<typeof SourcePartSchema>

export const ToolPartSchema = z.object({
  ...basePartFields,
  type: z.literal("tool"),
  toolName: z.string().min(1),
  toolCallId: z.string().min(1),
  state: z.enum(["requested", "input-ready", "running", "succeeded", "failed"]),
  input: JsonValueSchema.optional(),
  output: JsonValueSchema.optional(),
  error: z
    .object({
      code: z.string().min(1).optional(),
      message: z.string().min(1),
    })
    .optional(),
})
export type ToolPart = z.infer<typeof ToolPartSchema>

export const GenerationStateSchema = z.enum([
  "queued",
  "submitted",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
])
export type GenerationState = z.infer<typeof GenerationStateSchema>

export const GenerationPartSchema = z.object({
  ...basePartFields,
  type: z.literal("generation"),
  jobId: z.string().min(1),
  state: GenerationStateSchema,
  operation: z.string().min(1),
  modelKey: z.string().min(1).optional(),
  progress: z.number().min(0).max(1).optional(),
  statusText: z.string().optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean().optional(),
    })
    .optional(),
})
export type GenerationPart = z.infer<typeof GenerationPartSchema>

export const ProvenancePartSchema = z.object({
  ...basePartFields,
  type: z.literal("provenance"),
  value: ProvenanceReferenceSchema,
})
export type ProvenancePart = z.infer<typeof ProvenancePartSchema>

export const IdentityPartSchema = z.object({
  ...basePartFields,
  type: z.literal("identity"),
  identity: OwnerScopedIdentityLinkSchema,
  label: z.string().min(1).optional(),
})
export type IdentityPart = z.infer<typeof IdentityPartSchema>

export const ErrorPartSchema = z.object({
  ...basePartFields,
  type: z.literal("error"),
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().optional(),
  relatedPartId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
})
export type ErrorPart = z.infer<typeof ErrorPartSchema>

const resolvedPartSchemas = [
  TextPartSchema,
  ImagePartSchema,
  AudioPartSchema,
  TranscriptPartSchema,
  VideoPartSchema,
  Model3DPartSchema,
  DerivedMediaPartSchema,
  FilePartSchema,
  SourcePartSchema,
  ToolPartSchema,
  ProvenancePartSchema,
  IdentityPartSchema,
  ErrorPartSchema,
] as const

export const ResolvedConversationPartSchema = z.discriminatedUnion(
  "type",
  resolvedPartSchemas
)
export type ResolvedConversationPart = z.infer<
  typeof ResolvedConversationPartSchema
>

export const ConversationPartSchema = z.discriminatedUnion("type", [
  ...resolvedPartSchemas,
  GenerationPartSchema,
])
export type ConversationPart = z.infer<typeof ConversationPartSchema>

export const ConversationMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["system", "user", "assistant", "tool"]),
  createdAt: z.string().min(1).optional(),
  parts: z.array(ConversationPartSchema),
})
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>

export const TextDeltaEventSchema = z.object({
  type: z.literal("text.delta"),
  messageId: z.string().min(1),
  partId: z.string().min(1),
  delta: z.string(),
  final: z.boolean().optional(),
})

export const PartUpsertEventSchema = z.object({
  type: z.literal("part.upsert"),
  messageId: z.string().min(1),
  part: ConversationPartSchema,
})

export const GenerationTransitionEventSchema = z.object({
  type: z.literal("generation.transition"),
  messageId: z.string().min(1),
  partId: z.string().min(1),
  jobId: z.string().min(1),
  to: GenerationStateSchema,
  progress: z.number().min(0).max(1).optional(),
  statusText: z.string().optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean().optional(),
    })
    .optional(),
})

export const GenerationResolveEventSchema = z.object({
  type: z.literal("generation.resolve"),
  messageId: z.string().min(1),
  partId: z.string().min(1),
  jobId: z.string().min(1),
  result: ResolvedConversationPartSchema,
})

export const ConversationEventSchema = z.discriminatedUnion("type", [
  TextDeltaEventSchema,
  PartUpsertEventSchema,
  GenerationTransitionEventSchema,
  GenerationResolveEventSchema,
])
export type ConversationEvent = z.infer<typeof ConversationEventSchema>

const generationTransitions: Record<GenerationState, readonly GenerationState[]> = {
  queued: ["submitted", "running", "succeeded", "failed", "cancelled", "expired"],
  submitted: ["running", "succeeded", "failed", "cancelled", "expired"],
  running: ["succeeded", "failed", "cancelled", "expired"],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
}

export function canTransitionGeneration(
  from: GenerationState,
  to: GenerationState
) {
  return generationTransitions[from].includes(to)
}

function findPartIndex(message: ConversationMessage, partId: string) {
  return message.parts.findIndex((part) => part.id === partId)
}

function assertEventMessage(message: ConversationMessage, event: ConversationEvent) {
  if (message.id !== event.messageId) {
    throw new Error(
      `Conversation event targets message ${event.messageId}, not ${message.id}.`
    )
  }
}

export function applyConversationEvent(
  messageInput: ConversationMessage,
  eventInput: ConversationEvent
): ConversationMessage {
  const message = ConversationMessageSchema.parse(messageInput)
  const event = ConversationEventSchema.parse(eventInput)
  assertEventMessage(message, event)

  if (event.type === "part.upsert") {
    const index = findPartIndex(message, event.part.id)
    const parts = [...message.parts]
    if (index === -1) parts.push(event.part)
    else parts[index] = event.part
    return ConversationMessageSchema.parse({ ...message, parts })
  }

  const index = findPartIndex(message, event.partId)
  if (index === -1) {
    throw new Error(`Conversation part ${event.partId} does not exist.`)
  }
  const current = message.parts[index]

  if (event.type === "text.delta") {
    if (current?.type !== "text") {
      throw new Error(`Conversation part ${event.partId} is not text.`)
    }
    const parts = [...message.parts]
    parts[index] = {
      ...current,
      text: `${current.text}${event.delta}`,
      state: event.final ? "complete" : "streaming",
    }
    return ConversationMessageSchema.parse({ ...message, parts })
  }

  if (current?.type !== "generation") {
    throw new Error(`Conversation part ${event.partId} is not a generation job.`)
  }
  if (current.jobId !== event.jobId) {
    throw new Error(
      `Generation job ${event.jobId} does not match part job ${current.jobId}.`
    )
  }

  if (event.type === "generation.transition") {
    if (!canTransitionGeneration(current.state, event.to)) {
      throw new Error(
        `Invalid generation transition ${current.state} -> ${event.to}.`
      )
    }
    const parts = [...message.parts]
    parts[index] = {
      ...current,
      state: event.to,
      progress: event.progress ?? current.progress,
      statusText: event.statusText ?? current.statusText,
      error: event.error,
    }
    return ConversationMessageSchema.parse({ ...message, parts })
  }

  if (
    current.state === "failed" ||
    current.state === "cancelled" ||
    current.state === "expired"
  ) {
    throw new Error(`Cannot resolve terminal generation job ${current.jobId}.`)
  }

  const result = ResolvedConversationPartSchema.parse({
    ...event.result,
    id: event.partId,
    generatedBy: {
      ...event.result.generatedBy,
      jobId: event.jobId,
      workflowExecutionId:
        event.result.generatedBy?.workflowExecutionId ??
        current.generatedBy?.workflowExecutionId,
      stepExecutionId:
        event.result.generatedBy?.stepExecutionId ?? current.generatedBy?.stepExecutionId,
    },
  })

  const parts = [...message.parts]
  parts[index] = result
  return ConversationMessageSchema.parse({ ...message, parts })
}

export function serializeConversationMessage(message: ConversationMessage) {
  return JSON.stringify(ConversationMessageSchema.parse(message))
}

export function parseConversationMessage(serialized: string) {
  return ConversationMessageSchema.parse(JSON.parse(serialized) as unknown)
}

export function serializeConversationEvent(event: ConversationEvent) {
  return JSON.stringify(ConversationEventSchema.parse(event))
}

export function parseConversationEvent(serialized: string) {
  return ConversationEventSchema.parse(JSON.parse(serialized) as unknown)
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled conversation variant: ${JSON.stringify(value)}`)
}
