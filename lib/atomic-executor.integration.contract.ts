import {
  AtomicExecutionError,
  executeAtomic,
  getAtomicLanguageModel,
  submitAtomic,
} from "./atomic-executor"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function fakeEnv() {
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
        options: Record<string, unknown>
      ) {
        calls.push({ model, input, options })
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

  // All four text protocol families can be instantiated without provider-prefix
  // branching. Full repo typecheck validates these against the installed SDK APIs.
  for (const modelKey of [
    "@cf/zai-org/glm-5.3-flash",
    "openai/gpt-5.6-terra",
    "anthropic/claude-sonnet-5",
    "google/gemini-3.7-flash",
  ]) {
    assert(getAtomicLanguageModel(env, modelKey), `${modelKey} language adapter exists`)
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

  const unifiedResult = await executeAtomic(env, {
    modelKey: "black-forest-labs/flux-2-max",
    input: { prompt: "a quiet observatory" },
    operation: {
      capabilities: ["image-generation"],
      inputKinds: ["text"],
      outputKind: "image",
      representation: { artifact: "image", format: "raster" },
    },
    workflowStepId: "step_flux",
  })

  assert(unifiedResult.kind === "immediate", "Unified call returns immediate result")
  assert(unifiedResult.metadata.keySource === "unified-billing", "Unified key source")
  assert(unifiedResult.metadata.workflowStepId === "step_flux", "workflow step preserved")
  assert(calls[1]?.model === "black-forest-labs/flux-2-max", "Unified canonical model id")
  assert(
    (calls[1]?.options.gateway as { id?: string } | undefined)?.id === "default",
    "Unified call uses configured Gateway"
  )

  const nativeRequests: Array<{ url: string; init: RequestInit }> = []
  const nativeFetch: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.toString()
    nativeRequests.push({ url, init })

    if (init.headers && new Headers(init.headers).has("x-fal-target-url")) {
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

  return true
}

void runAtomicExecutorIntegrationChecks()
