import {
  assertValidModelCatalog,
  filterModelCatalog,
  findEnabledCatalogModel,
  type ModelDefinition,
  type OwnerScopedIdentityReference,
} from "@/lib/model-catalog"

/**
 * Compile-time/runtime contract fixtures for the catalog shape.
 * These are deliberately synthetic and are not exposed as product models.
 * A future test runner can call runModelCatalogContractChecks() directly.
 */
const CONTRACT_FIXTURES = assertValidModelCatalog([
  {
    key: "contract/text-vision",
    upstreamModelId: "contract/text-vision",
    name: "Text Vision Fixture",
    provider: "contract",
    catalogSource: "unified",
    transport: "unified-run",
    protocol: "responses",
    lifecycle: "launch",
    roles: ["balanced"],
    inputs: ["text", "image"],
    outputs: ["text"],
    capabilities: [
      "chat",
      "vision",
      "reasoning",
      "tool-calling",
      "structured-output",
      "ocr",
      "image-captioning",
      "object-detection",
    ],
    representations: [{ artifact: "text", format: "markdown" }],
    execution: { result: "immediate", streaming: true },
    tools: { appTools: true, nativeTools: ["web-search"] },
    reasoning: { supported: true, controls: ["effort"] },
    continuation: { mode: "provider-state" },
    limits: { contextTokens: 128_000, maxOutputTokens: 16_000 },
    verification: { lastVerifiedAt: "2026-09-09", docs: [] },
  },
  {
    key: "contract/raster",
    upstreamModelId: "contract/raster",
    name: "Raster Fixture",
    provider: "contract",
    catalogSource: "gateway-provider-native",
    transport: "gateway-provider-native",
    protocol: "provider-native",
    lifecycle: "experimental",
    roles: ["editing"],
    inputs: ["text", "image"],
    outputs: ["image"],
    capabilities: [
      "image-generation",
      "image-edit",
      "image-inpaint",
      "image-outpaint",
      "image-object-removal",
      "image-relighting",
      "image-multi-reference",
      "image-mask-input",
      "background-removal",
      "upscale-faithful",
      "upscale-creative",
    ],
    representations: [
      {
        artifact: "image",
        format: "raster",
        mimeTypes: ["image/png", "image/webp"],
        alpha: true,
      },
    ],
    execution: { result: "either", streaming: false, background: true },
    parameters: [
      {
        key: "aspectRatio",
        label: "Aspect ratio",
        kind: "select",
        options: [
          { value: "1:1", label: "Square" },
          { value: "16:9", label: "Landscape" },
        ],
      },
    ],
    verification: { lastVerifiedAt: "2026-09-09", docs: [] },
  },
  {
    key: "contract/svg",
    upstreamModelId: "contract/svg",
    name: "SVG Fixture",
    provider: "contract",
    catalogSource: "unified",
    transport: "unified-run",
    protocol: "unified-run",
    lifecycle: "launch",
    roles: ["design"],
    inputs: ["text", "image"],
    outputs: ["image"],
    capabilities: ["svg-generation"],
    representations: [
      { artifact: "image", format: "svg", mimeTypes: ["image/svg+xml"] },
    ],
    execution: { result: "immediate", streaming: false },
    verification: { lastVerifiedAt: "2026-09-09", docs: [] },
  },
  {
    key: "contract/asr",
    upstreamModelId: "contract/asr",
    name: "ASR Fixture",
    provider: "contract",
    catalogSource: "workers-ai",
    transport: "workers-binding",
    protocol: "workers-ai",
    lifecycle: "launch",
    roles: ["specialist", "workers-hosted"],
    inputs: ["audio"],
    outputs: ["text"],
    capabilities: [
      "transcription",
      "diarization",
      "speech-language-detection",
    ],
    representations: [{ artifact: "text", format: "transcript" }],
    execution: { result: "immediate", streaming: false },
    verification: { lastVerifiedAt: "2026-09-09", docs: [] },
  },
  {
    key: "contract/tts",
    upstreamModelId: "contract/tts",
    name: "TTS Fixture",
    provider: "contract",
    catalogSource: "unified",
    transport: "unified-run",
    protocol: "unified-run",
    lifecycle: "launch",
    roles: ["specialist"],
    inputs: ["text"],
    outputs: ["audio"],
    capabilities: ["text-to-speech"],
    representations: [
      {
        artifact: "audio",
        format: "audio",
        containers: ["mp3", "wav"],
        codecs: ["mp3", "pcm_s16le"],
      },
    ],
    identityInputs: [
      "builtin-voice",
      "cloned-voice",
      "designed-voice",
      "reference-voice",
    ],
    execution: { result: "immediate", streaming: true },
    verification: { lastVerifiedAt: "2026-09-09", docs: [] },
  },
  {
    key: "contract/voice-clone",
    upstreamModelId: "contract/voice-clone",
    name: "Voice Clone Fixture",
    provider: "contract",
    catalogSource: "gateway-provider-native",
    transport: "gateway-provider-native",
    protocol: "provider-native",
    lifecycle: "experimental",
    inputs: ["audio"],
    outputs: [],
    capabilities: ["voice-cloning"],
    identityOutputs: ["cloned-voice"],
    execution: { result: "immediate", streaming: false },
    verification: { lastVerifiedAt: "2026-09-09", docs: [] },
  },
  {
    key: "contract/music",
    upstreamModelId: "contract/music",
    name: "Music Fixture",
    provider: "contract",
    catalogSource: "gateway-provider-native",
    transport: "gateway-provider-native",
    protocol: "provider-native",
    lifecycle: "experimental",
    inputs: ["text", "audio"],
    outputs: ["audio"],
    capabilities: [
      "music-generation",
      "sound-effect-generation",
      "audio-to-audio",
      "audio-isolation",
      "voice-conversion",
    ],
    representations: [
      { artifact: "audio", format: "audio", containers: ["mp3", "wav"] },
    ],
    execution: { result: "queued", streaming: false, background: true },
    verification: { lastVerifiedAt: "2026-09-09", docs: [] },
  },
  {
    key: "contract/dubbing",
    upstreamModelId: "contract/dubbing",
    name: "Dubbing Fixture",
    provider: "contract",
    catalogSource: "gateway-provider-native",
    transport: "gateway-provider-native",
    protocol: "provider-native",
    lifecycle: "experimental",
    inputs: ["audio", "video"],
    outputs: ["audio", "video"],
    capabilities: ["dubbing", "speaker-preservation"],
    representations: [
      { artifact: "audio", format: "audio", containers: ["mp3"] },
      { artifact: "video", format: "video", containers: ["mp4"] },
    ],
    execution: { result: "queued", streaming: false, background: true },
    verification: { lastVerifiedAt: "2026-09-09", docs: [] },
  },
  {
    key: "contract/video",
    upstreamModelId: "contract/video",
    name: "Video Fixture",
    provider: "contract",
    catalogSource: "unified",
    transport: "unified-run",
    protocol: "unified-run",
    lifecycle: "launch",
    roles: ["reference-heavy", "editing"],
    inputs: ["text", "image", "video", "audio"],
    outputs: ["video"],
    capabilities: [
      "video-generation",
      "image-to-video",
      "video-reference",
      "video-edit",
      "video-continuation",
      "video-first-frame",
      "video-last-frame",
      "video-multi-image-reference",
      "video-multi-video-reference",
      "video-audio-reference",
      "video-multi-shot",
      "video-element-reference",
      "native-video-audio",
      "avatar-video",
      "video-4k",
    ],
    representations: [
      { artifact: "video", format: "video", containers: ["mp4"] },
    ],
    execution: { result: "queued", streaming: false, background: true },
    limits: { maxDurationSeconds: 30, maxReferences: 50 },
    verification: { lastVerifiedAt: "2026-09-09", docs: [] },
  },
  {
    key: "contract/model3d",
    upstreamModelId: "contract/model3d",
    name: "3D Fixture",
    provider: "contract",
    catalogSource: "gateway-provider-native",
    transport: "gateway-provider-native",
    protocol: "provider-native",
    lifecycle: "experimental",
    inputs: ["text", "image", "model3d"],
    outputs: ["model3d"],
    capabilities: [
      "text-to-3d",
      "image-to-3d",
      "model3d-rigging",
      "model3d-animation",
    ],
    representations: [
      {
        artifact: "model3d",
        format: "model3d",
        containers: ["glb", "gltf", "obj", "fbx"],
        materials: "pbr",
      },
    ],
    execution: { result: "queued", streaming: false, background: true },
    verification: { lastVerifiedAt: "2026-09-09", docs: [] },
  },
] as const satisfies readonly ModelDefinition[])

const OWNER_SCOPED_VOICE_FIXTURE = {
  id: "voice_app_owned_1",
  kind: "cloned-voice",
  ownerId: "owner_1",
  provider: "contract",
} as const satisfies OwnerScopedIdentityReference

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function runModelCatalogContractChecks() {
  assert(
    OWNER_SCOPED_VOICE_FIXTURE.ownerId === "owner_1",
    "identity is owner scoped"
  )

  assert(
    filterModelCatalog(CONTRACT_FIXTURES, {
      capabilities: ["vision", "ocr"],
      inputs: ["image"],
      outputs: ["text"],
    })
      .map((model) => model.key)
      .join(",") === "contract/text-vision",
    "filters by capability and artifact kind"
  )

  assert(
    filterModelCatalog(CONTRACT_FIXTURES, {
      representation: { artifact: "image", format: "svg" },
      lifecycles: ["launch"],
    })
      .map((model) => model.key)
      .join(",") === "contract/svg",
    "filters by output representation and lifecycle"
  )

  assert(
    filterModelCatalog(CONTRACT_FIXTURES, {
      transports: ["gateway-provider-native"],
      protocols: ["provider-native"],
      capabilities: ["dubbing"],
    })
      .map((model) => model.key)
      .join(",") === "contract/dubbing",
    "filters by provider-native transport and protocol"
  )

  assert(
    filterModelCatalog(CONTRACT_FIXTURES, {
      capabilities: ["voice-cloning"],
    })[0]?.identityOutputs?.[0] === "cloned-voice",
    "represents endpoints that produce owner-scoped identities"
  )

  assert(
    filterModelCatalog(CONTRACT_FIXTURES, {
      outputs: ["model3d"],
      lifecycles: ["experimental"],
    })
      .map((model) => model.key)
      .join(",") === "contract/model3d",
    "represents experimental 3D without a schema change"
  )

  assert(
    findEnabledCatalogModel(CONTRACT_FIXTURES, "contract/model3d")?.key ===
      "contract/model3d",
    "experimental entries remain server-addressable"
  )

  const disabledFixture = assertValidModelCatalog([
    {
      ...CONTRACT_FIXTURES[0],
      key: "contract/disabled",
      upstreamModelId: "contract/disabled",
      lifecycle: "disabled",
    },
  ] satisfies readonly ModelDefinition[])

  assert(
    findEnabledCatalogModel(disabledFixture, "contract/disabled") === undefined,
    "disabled entries are rejected server-side"
  )

  return true
}
