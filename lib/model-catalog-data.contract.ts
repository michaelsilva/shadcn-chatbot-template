import workersBaseline from "@/catalog/workers-ai-baseline.json"
import {
  DEFAULT_MODEL,
  getChatModelDefinition,
  getModelDefinition,
  MODELS,
} from "@/lib/models"
import {
  LAUNCH_MODEL_CATALOG,
  MODEL_CATALOG,
  WORKERS_AI_LAUNCH_MODEL_KEYS,
} from "@/lib/model-catalog-data"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sorted(values: readonly string[]) {
  return [...values].sort()
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right))
}

export function runModelCatalogDataContractChecks() {
  assert(MODEL_CATALOG.length > 20, "curated catalog has real cross-modality breadth")
  assert(LAUNCH_MODEL_CATALOG.length > 10, "launch catalog is populated")

  const launchKeys = new Set(LAUNCH_MODEL_CATALOG.map((model) => model.key))

  for (const required of [
    "@cf/zai-org/glm-5.3-flash",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-sol",
    "anthropic/claude-sonnet-5",
    "google/gemini-3.7-flash",
    "@cf/moondream/moondream3.1-9B-A2B",
    "black-forest-labs/flux-2-max",
    "openai/gpt-image-2",
    "recraft/recraftv4-1-pro",
    "google/nano-banana-2",
    "recraft/recraftv4-1-pro-vector",
    "recraft/recraftv4-1-vector",
    "xai/grok-stt",
    "@cf/deepgram/nova-3",
    "elevenlabs/eleven-v3",
    "elevenlabs/eleven-flash-v2-5",
    "google/veo-3.1-fast",
    "bytedance/seedance-2.5",
    "runwayml/aleph-2",
    "fal-ai/kling-video/o3/standard/text-to-video",
  ]) {
    assert(launchKeys.has(required), `expected launch catalog entry ${required}`)
  }

  for (const model of LAUNCH_MODEL_CATALOG) {
    assert(
      /^\d{4}-\d{2}-\d{2}$/.test(model.verification.lastVerifiedAt),
      `${model.key} has a dated verification record`
    )
    assert(
      model.verification.docs.length > 0 &&
        model.verification.docs.every((doc) => doc.startsWith("https://")),
      `${model.key} has authoritative verification docs`
    )

    if (model.catalogSource === "gateway-provider-native") {
      assert(
        model.verification.docs.some((doc) =>
          doc.includes("developers.cloudflare.com/ai-gateway/usage/providers/")
        ),
        `${model.key} provider-native route includes Cloudflare Gateway verification`
      )
      assert(
        model.verification.docs.some((doc) => doc.includes("fal.ai/")),
        `${model.key} provider-native route includes upstream endpoint verification`
      )
    }
  }

  assert(
    sameStrings(
      WORKERS_AI_LAUNCH_MODEL_KEYS,
      Object.keys(workersBaseline.models)
    ),
    "Workers launch catalog and authenticated freshness baseline stay in lockstep"
  )

  assert(
    WORKERS_AI_LAUNCH_MODEL_KEYS.every((key) => key.startsWith("@cf/")),
    "Workers freshness automation never claims third-party coverage"
  )

  assert(
    MODEL_CATALOG.filter((model) => model.outputs.includes("model3d")).every(
      (model) => model.lifecycle === "experimental"
    ),
    "3D remains experimental"
  )

  assert(
    getModelDefinition("elevenlabs/music-v2")?.lifecycle === "experimental",
    "music remains post-launch"
  )
  assert(
    getModelDefinition("fal-ai/elevenlabs/dubbing")?.lifecycle ===
      "experimental",
    "dubbing remains post-launch"
  )
  assert(
    getModelDefinition("fal-ai/qwen-3-tts/clone-voice/1.7b")?.lifecycle ===
      "experimental",
    "reusable voice cloning remains post-launch"
  )

  const klingLaunchKeys = LAUNCH_MODEL_CATALOG.filter((model) =>
    model.key.startsWith("fal-ai/kling-video/")
  ).map((model) => model.key)

  assert(klingLaunchKeys.length >= 5, "Kling O3 launch workflow family is present")
  assert(
    klingLaunchKeys.every((key) => key.includes("/o3/standard/")),
    "Kling launch entries use O3 Standard, not stale Kling 3/O1 or premium tiers"
  )

  assert(
    DEFAULT_MODEL === "@cf/zai-org/glm-5.3-flash",
    "current chat defaults to the new Workers value multimodal model"
  )
  assert(
    MODELS.some((model) => model.id === "@cf/zai-org/glm-4.7-flash"),
    "legacy GLM 4.7 remains a development-compatible chat option"
  )
  assert(
    MODELS.some((model) => model.id === "openai/gpt-5.6-terra") &&
      MODELS.some((model) => model.id === "anthropic/claude-sonnet-5"),
    "existing Responses/Messages chat paths remain visible"
  )

  assert(
    getModelDefinition("google/gemini-3.7-flash")?.lifecycle === "launch" &&
      !getChatModelDefinition("google/gemini-3.7-flash"),
    "Gemini is launch catalog data but waits for #3 Chat Completions execution"
  )
  assert(
    getModelDefinition("black-forest-labs/flux-2-max")?.lifecycle === "launch" &&
      !getChatModelDefinition("black-forest-labs/flux-2-max"),
    "media launch entries cannot leak into the legacy chat route"
  )

  return true
}
