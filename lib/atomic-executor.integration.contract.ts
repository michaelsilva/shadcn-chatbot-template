import {
  AtomicExecutionError,
  executeAtomic,
  getAtomicLanguageModel,
  submitAtomic,
} from "./atomic-executor"
import type { AtomicOperationRequirement } from "./atomic-executor-core"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function fakeEnv(
  options: { failingModelIds?: ReadonlyMap<string, "retryable" | "non-retryable"> } = {}
) {
  const calls: Array<{
    model: string
    input: Record<string, unknown>
    options: Record<string, unknown>
  }> = []

  const env = {
    CLOUDFLARE_AI_GATEWAY_ID: "default",
    CLOUDFLARE_ACCOUNT_ID: "acct_123",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "gateway_test_token",
    FAL_KEY: "fal_test_key",
    AI: {
      async run(
        model: string,
        input: Record<string, unknown>,
        runOptions: Record<string, unknown>
      ) {
        calls.push({ model, input, options: runOptions })

        const failure = options.failingModelIds?.get(model)
        if (failure === "retryable") {
          throw new Error("Upstream request failed with status 503.")
        }
        if (failure === "non-retryable") {
          throw new AtomicExecutionError("UPSTREAM_AUTH", "Upstream rejected credentials.", {
            retryable: false,
          })
        }

        return new Response(
          JSON.stringify({
            ok: true,
            model,
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cf-aig-request-id": `aig_${calls.length}`,
            },
          }
        )
      },
    },
  } as unknown as CloudflareEnv & {
    CLOUDFLARE_ACCOUNT_ID: string
    CLOUDFLARE_AI_GATEWAY_TOKEN: string
    FAL_KEY: string
  }

  return { env, calls }
}

async function expectAtomicError(
  fn: () => Promise<unknown>,
  code: AtomicExecutionError["code"],
  message: string
) {
  try {
    await fn()
  } catch (error) {
    assert(error instanceof AtomicExecutionError, `${message}: wrong error type`)
    assert(error.code === code, `${message}: expected ${code}, got ${error.code}`)
    return error
  }
  throw new Error(`${message}: expected error`)
}

export async function runAtomicExecutorIntegrationChecks() {
  const { env, calls } = fakeEnv()

  const protocolCases = [
    ["@cf/zai-org/glm-5.3-flash", "workers-ai"],
    ["openai/gpt-5.6-terra", "responses"],
    ["anthropic/claude-sonnet-5", "messages"],
    ["google/gemini-3.7-flash", "chat-completions"],
  ] as const

  for (const [modelKey, expectedProtocol] of protocolCases) {
    const languageModel = getAtomicLanguageModel(env, modelKey) as unknown as {
      protocol?: string
    }
    // The disposable integration harness stubs only the SDK wire serializer so
    // this assertion exercises #3's protocol dispatcher. Full repo typecheck
    // separately validates the real SDK factories.
    assert(
      languageModel.protocol === expectedProtocol,
      `${modelKey} dispatches through ${expectedProtocol}`
    )
  }

  const workersResult = await executeAtomic(env, {
    modelKey: "@cf/moondream/moondream3.1-9B-A2B",
    input: { task: "caption", image: "data:image/png;base64,AA==" },
    operation: {
      capabilities: ["image-captioning"],
      inputKinds: ["image"],
      outputKind: "text",
    },
    correlationId: "corr_workers",
  })

  assert(workersResult.kind === "immediate", "Workers call returns immediate result")
  assert(workersResult.metadata.keySource === "workers-binding", "Workers key source")
  assert(workersResult.metadata.gatewayId === "default", "Workers gateway metadata")
  assert(workersResult.metadata.routing.fallbackUsed === false, "Workers no fallback")
  assert(workersResult.usage?.input_tokens === 4, "Workers usage normalized")
  assert(calls[0]?.model === "@cf/moondream/moondream3.1-9B-A2B", "Workers model id")

  const universalCases: Array<{
    modelKey: string
    input: Record<string, unknown>
    operation: AtomicOperationRequirement
  }> = [
    {
      modelKey: "black-forest-labs/flux-2-max",
      input: { prompt: "a quiet observatory" },
      operation: {
        capabilities: ["image-generation"],
        inputKinds: ["text"],
        outputKind: "image",
        representation: { artifact: "image", format: "raster" },
      },
    },
    {
      modelKey: "recraft/recraftv4-1-pro-vector",
      input: { prompt: "a geometric fox mark" },
      operation: {
        capabilities: ["svg-generation"],
        inputKinds: ["text"],
        outputKind: "image",
        representation: { artifact: "image", format: "svg" },
      },
    },
    {
      modelKey: "xai/grok-stt",
      input: { audio: "data:audio/wav;base64,AA==" },
      operation: {
        capabilities: ["transcription"],
        inputKinds: ["audio"],
        outputKind: "text",
      },
    },
    {
      modelKey: "elevenlabs/eleven-v3",
      input: { text: "Hello from the atomic executor." },
      operation: {
        capabilities: ["text-to-speech"],
        inputKinds: ["text"],
        outputKind: "audio",
      },
    },
    {
      modelKey: "google/veo-3.1-fast",
      input: { prompt: "a paper kite above a shoreline" },
      operation: {
        capabilities: ["video-generation"],
        inputKinds: ["text"],
        outputKind: "video",
      },
    },
  ]

  for (const [index, testCase] of universalCases.entries()) {
    const result = await executeAtomic(env, {
      modelKey: testCase.modelKey,
      input: testCase.input,
      operation: testCase.operation,
      workflowStepId: `universal_${index}`,
    })
    assert(result.kind === "immediate", `${testCase.modelKey} returns immediate result`)
    assert(
      result.metadata.keySource === "unified-billing",
      `${testCase.modelKey} uses unified binding key source`
    )
    const call = calls[index + 1]
    assert(call?.model === testCase.modelKey, `${testCase.modelKey} uses canonical id`)
    assert(
      (call?.options.gateway as { id?: string } | undefined)?.id === "default",
      `${testCase.modelKey} uses configured Gateway`
    )
  }

  const nativeRequests: Array<{ url: string; init: RequestInit }> = []
  const nativeFetch: typeof fetch = async (input, init) => {
    const requestInit = (init ?? {}) as RequestInit
    const url = typeof input === "string" ? input : input.toString()
    nativeRequests.push({ url, init: requestInit })

    if (
      requestInit.headers &&
      new Headers(requestInit.headers).has("x-fal-target-url")
    ) {
      return new Response(
        JSON.stringify({
          request_id: "fal_job_1",
          status: "IN_QUEUE",
          status_url: "https://queue.fal.run/status/fal_job_1",
          response_url: "https://queue.fal.run/result/fal_job_1",
          cancel_url: "https://queue.fal.run/cancel/fal_job_1",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-fal-request-id": "fal_gateway_2",
          },
        }
      )
    }

    return new Response(JSON.stringify({ images: [{ url: "https://example.test/image.png" }] }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-fal-request-id": "fal_gateway_1",
      },
    })
  }

  const nativeImmediate = await executeAtomic(
    env,
    {
      modelKey: "ideogram/v4",
      input: { prompt: "letterpress poster" },
      operation: {
        capabilities: ["image-generation"],
        inputKinds: ["text"],
        outputKind: "image",
      },
    },
    { fetch: nativeFetch }
  )

  assert(nativeImmediate.metadata.keySource === "provider-key", "native key source")
  assert(
    nativeRequests[0]?.url ===
      "https://gateway.ai.cloudflare.com/v1/acct_123/default/fal/ideogram/v4",
    "native sync URL uses trusted catalog route"
  )
  const syncHeaders = new Headers(nativeRequests[0]?.init.headers)
  assert(syncHeaders.get("authorization") === "Key fal_test_key", "Fal sync uses Key auth")
  assert(
    syncHeaders.get("cf-aig-authorization") === "Bearer gateway_test_token",
    "Authenticated Gateway token stays server-side"
  )

  const submission = await submitAtomic(
    env,
    {
      modelKey: "fal-ai/kling-video/o3/standard/text-to-video",
      input: { prompt: "a sailboat at dusk" },
      operation: {
        capabilities: ["video-generation"],
        inputKinds: ["text"],
        outputKind: "video",
      },
      workflowStepId: "step_video",
    },
    { fetch: nativeFetch }
  )

  assert(submission.externalJob.requestId === "fal_job_1", "queue request id normalized")
  assert(submission.externalJob.initialState === "queued", "queue state normalized")
  assert(submission.metadata.keySource === "provider-key", "queue key source")
  assert(submission.metadata.workflowStepId === "step_video", "queue workflow step")
  assert(
    nativeRequests[1]?.url ===
      "https://gateway.ai.cloudflare.com/v1/acct_123/default/fal",
    "custom-target queue uses Fal Gateway base"
  )
  const queueHeaders = new Headers(nativeRequests[1]?.init.headers)
  assert(
    queueHeaders.get("authorization") === "Bearer fal_test_key",
    "Fal custom-target queue uses Bearer auth"
  )
  assert(
    queueHeaders.get("x-fal-target-url") ===
      "https://queue.fal.run/fal-ai/kling-video/o3/standard/text-to-video",
    "queue target comes only from trusted catalog route"
  )

  await expectAtomicError(
    () =>
      executeAtomic(
        env,
        {
          modelKey: "fal-ai/imageutils/rembg",
          input: { image_url: "https://example.test/input.png" },
        },
        { fetch: nativeFetch }
      ),
    "UNSUPPORTED_OPERATION",
    "queue-only endpoint cannot execute synchronously"
  )

  await expectAtomicError(
    () =>
      submitAtomic(env, {
        modelKey: "black-forest-labs/flux-2-max",
        input: { prompt: "x" },
      }),
    "UNSUPPORTED_OPERATION",
    "unified immediate endpoint cannot enter provider-native queue"
  )

  await expectAtomicError(
    () =>
      executeAtomic(env, {
        modelKey: "not/a/catalog-entry",
        input: { prompt: "x" },
      }),
    "MODEL_NOT_FOUND",
    "arbitrary upstream model ids are rejected"
  )

  const rejectedFetch: typeof fetch = async () =>
    new Response("rate limited", {
      status: 429,
      headers: { "x-request-id": "native_rate_1" },
    })

  const rateError = await expectAtomicError(
    () =>
      executeAtomic(
        env,
        {
          modelKey: "ideogram/v4",
          input: { prompt: "x" },
        },
        { fetch: rejectedFetch }
      ),
    "UPSTREAM_RATE_LIMIT",
    "provider-native HTTP failures use stable error taxonomy"
  )
  assert(rateError.retryable, "provider-native 429 is retryable")

  // #13: Gateway routing policy reaches env.AI.run() ---------------------
  const bindingGatewayCall = calls[0]
  const bindingGatewayOptions = bindingGatewayCall?.options.gateway as
    | {
        skipCache?: boolean
        requestTimeoutMs?: number
        metadata?: Record<string, unknown>
      }
    | undefined
  assert(bindingGatewayOptions?.skipCache === true, "binding calls skip cache")
  assert(
    typeof bindingGatewayOptions?.requestTimeoutMs === "number",
    "binding calls carry a request timeout"
  )
  assert(
    bindingGatewayOptions?.metadata?.correlation_id === "corr_workers" &&
      bindingGatewayOptions?.metadata?.resolved_model_key ===
        "@cf/moondream/moondream3.1-9B-A2B",
    "binding calls attach trusted attribution metadata"
  )

  const syncNativeHeaders = new Headers(nativeRequests[0]?.init.headers)
  assert(
    syncNativeHeaders.get("cf-aig-skip-cache") === "true",
    "provider-native sync calls skip cache via header"
  )
  assert(
    syncNativeHeaders.has("cf-aig-request-timeout"),
    "provider-native sync calls carry a request-timeout header"
  )
  assert(
    syncNativeHeaders.has("cf-aig-metadata"),
    "provider-native sync calls carry an attribution metadata header"
  )

  // #13: compatible fallback ------------------------------------------
  {
    const { env: fallbackEnv, calls: fallbackCalls } = fakeEnv({
      failingModelIds: new Map([["@cf/zai-org/glm-5.3-flash", "retryable"]]),
    })

    const result = await executeAtomic(fallbackEnv, {
      modelKey: "@cf/zai-org/glm-5.3-flash",
      input: { prompt: "hello" },
      operation: { capabilities: ["chat"] },
    })

    assert(result.metadata.routing.requestedModelKey === "@cf/zai-org/glm-5.3-flash", "fallback keeps original requested key")
    assert(
      result.metadata.routing.resolvedModelKey === "@cf/zai-org/glm-4.7-flash",
      "fallback resolves to the declared compatible catalog entry"
    )
    assert(result.metadata.routing.fallbackUsed === true, "fallback is reported in result metadata")
    assert(
      fallbackCalls.map((call) => call.model).join(",") ===
        "@cf/zai-org/glm-5.3-flash,@cf/zai-org/glm-4.7-flash",
      "primary is attempted before the fallback"
    )
  }

  // #13: incompatible fallback is never used, original error surfaces --
  {
    const { env: fallbackEnv, calls: fallbackCalls } = fakeEnv({
      failingModelIds: new Map([["@cf/zai-org/glm-5.3-flash", "retryable"]]),
    })

    const visionError = await expectAtomicError(
      () =>
        executeAtomic(fallbackEnv, {
          modelKey: "@cf/zai-org/glm-5.3-flash",
          input: { prompt: "describe this image" },
          operation: { capabilities: ["chat", "vision"] },
        }),
      "UPSTREAM_UNAVAILABLE",
      "fallback lacking a required capability (vision) is skipped and the original error surfaces"
    )
    assert(visionError.retryable, "surfaced error keeps its retryable classification")
    assert(
      fallbackCalls.map((call) => call.model).join(",") === "@cf/zai-org/glm-5.3-flash",
      "an incompatible fallback candidate is never actually called"
    )
  }

  // #13: non-retryable primary failure never attempts fallback ----------
  {
    const { env: fallbackEnv, calls: fallbackCalls } = fakeEnv({
      failingModelIds: new Map([["@cf/zai-org/glm-5.3-flash", "non-retryable"]]),
    })

    await expectAtomicError(
      () =>
        executeAtomic(fallbackEnv, {
          modelKey: "@cf/zai-org/glm-5.3-flash",
          input: { prompt: "hello" },
          operation: { capabilities: ["chat"] },
        }),
      "UPSTREAM_AUTH",
      "a non-retryable primary failure (e.g. auth/payment) is never masked by a fallback"
    )
    assert(
      fallbackCalls.map((call) => call.model).join(",") === "@cf/zai-org/glm-5.3-flash",
      "fallback is never attempted for a non-retryable failure"
    )
  }

  return true
}

void runAtomicExecutorIntegrationChecks()
