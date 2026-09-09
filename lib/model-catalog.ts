export type CatalogSource =
  | "workers-ai"
  | "unified"
  | "gateway-provider-native"

export type ModelTransport =
  | "workers-binding"
  | "unified-run"
  | "gateway-provider-native"

export type ModelProtocol =
  | "workers-ai"
  | "unified-run"
  | "chat-completions"
  | "responses"
  | "messages"
  | "provider-native"

export type ModelLifecycle =
  | "launch"
  | "experimental"
  | "legacy"
  | "disabled"
  | "deprecated"

export type ArtifactKind =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "file"
  | "model3d"

export type ModelRole =
  | "frontier"
  | "balanced"
  | "fast"
  | "value"
  | "design"
  | "editing"
  | "reference-heavy"
  | "specialist"
  | "workers-hosted"

export type ModelCapability =
  | "chat"
  | "reasoning"
  | "vision"
  | "tool-calling"
  | "structured-output"
  | "ocr"
  | "image-captioning"
  | "object-detection"
  | "image-generation"
  | "image-edit"
  | "image-inpaint"
  | "image-outpaint"
  | "image-object-removal"
  | "image-relighting"
  | "image-multi-reference"
  | "image-mask-input"
  | "background-removal"
  | "upscale-faithful"
  | "upscale-creative"
  | "svg-generation"
  | "transcription"
  | "diarization"
  | "speech-language-detection"
  | "text-to-speech"
  | "voice-cloning"
  | "voice-design"
  | "music-generation"
  | "sound-effect-generation"
  | "audio-to-audio"
  | "audio-isolation"
  | "voice-conversion"
  | "dubbing"
  | "speaker-preservation"
  | "video-generation"
  | "image-to-video"
  | "video-reference"
  | "video-edit"
  | "video-continuation"
  | "video-first-frame"
  | "video-last-frame"
  | "video-multi-image-reference"
  | "video-multi-video-reference"
  | "video-audio-reference"
  | "video-multi-shot"
  | "video-element-reference"
  | "native-video-audio"
  | "avatar-video"
  | "video-4k"
  | "text-to-3d"
  | "image-to-3d"
  | "model3d-rigging"
  | "model3d-animation"

export type ProviderNativeToolClass =
  | "web-search"
  | "code-execution"
  | "file-search"

export type IdentityKind =
  | "builtin-voice"
  | "cloned-voice"
  | "designed-voice"
  | "reference-voice"
  | "speaker-embedding"
  | "custom-element"

export type OwnerScopedIdentityKind = Exclude<IdentityKind, "builtin-voice">

export type ExecutionResultMode = "immediate" | "queued" | "either"

export type ZeroDataRetention = boolean | "unknown"

export type OutputRepresentation =
  | {
      artifact: "text"
      format: "plain" | "markdown" | "json" | "structured" | "transcript"
    }
  | {
      artifact: "image"
      format: "raster"
      mimeTypes?: readonly string[]
      alpha?: boolean
    }
  | {
      artifact: "image"
      format: "svg"
      mimeTypes?: readonly ["image/svg+xml"]
    }
  | {
      artifact: "audio"
      format: "audio"
      containers?: readonly string[]
      codecs?: readonly string[]
    }
  | {
      artifact: "video"
      format: "video"
      containers?: readonly string[]
      codecs?: readonly string[]
    }
  | {
      artifact: "model3d"
      format: "model3d"
      containers?: readonly ("glb" | "gltf" | "obj" | "fbx" | "stl")[]
      materials?: "none" | "optional" | "pbr"
    }

type RepresentationSelector<T extends OutputRepresentation> =
  T extends unknown ? Pick<T, "artifact" | "format"> : never

export type OutputRepresentationSelector =
  RepresentationSelector<OutputRepresentation>

export type ModelParameter =
  | {
      key: string
      label: string
      kind: "boolean"
      default?: boolean
    }
  | {
      key: string
      label: string
      kind: "number"
      min?: number
      max?: number
      step?: number
      default?: number
      unit?: string
    }
  | {
      key: string
      label: string
      kind: "select"
      options: readonly {
        value: string
        label: string
      }[]
      default?: string
    }
  | {
      key: string
      label: string
      kind: "text"
      placeholder?: string
      default?: string
    }

export interface ModelLimits {
  contextTokens?: number
  maxOutputTokens?: number
  maxDurationSeconds?: number
  maxReferences?: number
  maxInputBytes?: number
}

export interface ModelExecution {
  result: ExecutionResultMode
  streaming: boolean
  background?: boolean
}

export interface ModelToolSupport {
  appTools: boolean
  nativeTools?: readonly ProviderNativeToolClass[]
  parallelCalls?: boolean
}

export interface ModelReasoningSupport {
  supported: boolean
  controls?: readonly ("effort" | "budget" | "thinking")[]
}

export interface ModelContinuationSupport {
  mode: "none" | "provider-state"
}

export interface ModelVerification {
  lastVerifiedAt: string
  docs: readonly string[]
  schemaFingerprint?: string
}

export interface ModelDefinition {
  /** Stable application-facing key. This is the id accepted from the browser. */
  key: string
  /** Canonical upstream model id or provider-native route. Server-owned. */
  upstreamModelId: string
  name: string
  provider: string
  catalogSource: CatalogSource
  transport: ModelTransport
  protocol: ModelProtocol
  lifecycle: ModelLifecycle
  roles?: readonly ModelRole[]
  inputs: readonly ArtifactKind[]
  outputs: readonly ArtifactKind[]
  capabilities: readonly ModelCapability[]
  representations?: readonly OutputRepresentation[]
  execution: ModelExecution
  tools?: ModelToolSupport
  reasoning?: ModelReasoningSupport
  continuation?: ModelContinuationSupport
  /** Identity values are stored separately; this only declares accepted kinds. */
  identityInputs?: readonly IdentityKind[]
  /** Endpoints such as voice cloning can create owner-scoped identities. */
  identityOutputs?: readonly OwnerScopedIdentityKind[]
  parameters?: readonly ModelParameter[]
  parameterSchemaRef?: string
  limits?: ModelLimits
  billingClass?: "free" | "value" | "standard" | "premium" | "high-cost"
  accessClass?: "public" | "credential-required" | "preview"
  license?: string
  zeroDataRetention?: ZeroDataRetention
  verification: ModelVerification
}

/**
 * User/provider-scoped identities are deliberately separate from ModelDefinition.
 * The catalog may declare accepted/created identity kinds, but concrete identities
 * live in owner-scoped application state and are referenced through an app-owned id.
 */
export interface OwnerScopedIdentityReference {
  id: string
  kind: OwnerScopedIdentityKind
  ownerId: string
  provider: string
}

export interface BuiltinIdentityReference {
  kind: "builtin-voice"
  provider: string
  value: string
}

export type ModelIdentityReference =
  | OwnerScopedIdentityReference
  | BuiltinIdentityReference

export interface ModelQuery {
  capabilities?: readonly ModelCapability[]
  inputs?: readonly ArtifactKind[]
  outputs?: readonly ArtifactKind[]
  representation?: OutputRepresentationSelector
  transports?: readonly ModelTransport[]
  protocols?: readonly ModelProtocol[]
  lifecycles?: readonly ModelLifecycle[]
  roles?: readonly ModelRole[]
}

const SERVER_ENABLED_LIFECYCLES = new Set<ModelLifecycle>([
  "launch",
  "experimental",
  "legacy",
])

function includesAll<T>(available: readonly T[], required?: readonly T[]) {
  return !required?.length || required.every((item) => available.includes(item))
}

export function isServerEnabledModel(model: ModelDefinition) {
  return SERVER_ENABLED_LIFECYCLES.has(model.lifecycle)
}

export function matchesModelQuery(model: ModelDefinition, query: ModelQuery) {
  if (!includesAll(model.capabilities, query.capabilities)) return false
  if (!includesAll(model.inputs, query.inputs)) return false
  if (!includesAll(model.outputs, query.outputs)) return false
  if (!includesAll(model.roles ?? [], query.roles)) return false

  if (query.transports?.length && !query.transports.includes(model.transport)) {
    return false
  }

  if (query.protocols?.length && !query.protocols.includes(model.protocol)) {
    return false
  }

  if (query.lifecycles?.length && !query.lifecycles.includes(model.lifecycle)) {
    return false
  }

  if (
    query.representation &&
    !model.representations?.some(
      (representation) =>
        representation.artifact === query.representation?.artifact &&
        representation.format === query.representation?.format
    )
  ) {
    return false
  }

  return true
}

export function filterModelCatalog(
  catalog: readonly ModelDefinition[],
  query: ModelQuery
) {
  return catalog.filter((model) => matchesModelQuery(model, query))
}

export function findCatalogModel(
  catalog: readonly ModelDefinition[],
  key: string
) {
  return catalog.find((model) => model.key === key)
}

export function findEnabledCatalogModel(
  catalog: readonly ModelDefinition[],
  key: string
) {
  const model = findCatalogModel(catalog, key)
  return model && isServerEnabledModel(model) ? model : undefined
}

export function assertValidModelCatalog(catalog: readonly ModelDefinition[]) {
  const keys = new Set<string>()

  for (const model of catalog) {
    if (!model.key.trim()) throw new Error("Model catalog key cannot be empty.")
    if (!model.upstreamModelId.trim()) {
      throw new Error(`Model ${model.key} has an empty upstream model id.`)
    }
    if (keys.has(model.key)) {
      throw new Error(`Duplicate model catalog key: ${model.key}`)
    }
    keys.add(model.key)

    if (!model.inputs.length) {
      throw new Error(`Model ${model.key} must declare at least one input kind.`)
    }
    if (!model.outputs.length && !model.identityOutputs?.length) {
      throw new Error(
        `Model ${model.key} must declare at least one artifact or identity output.`
      )
    }

    for (const representation of model.representations ?? []) {
      if (!model.outputs.includes(representation.artifact)) {
        throw new Error(
          `Model ${model.key} declares ${representation.artifact}/${representation.format} without that output artifact.`
        )
      }
    }
  }

  return catalog
}
