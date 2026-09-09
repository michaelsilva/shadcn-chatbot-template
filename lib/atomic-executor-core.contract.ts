import {
  AtomicExecutionError,
  assertSafeProviderRoute,
  buildAtomicMetadata,
  buildFalQueueTarget,
  buildProviderNativeGatewayUrl,
  classifyAtomicHttpError,
  extractAtomicRequestId,
  extractAtomicUsage,
  fallbackCandidateSupportsRequest,
  normalizeAtomicQueueState,
  readAtomicResponsePayload,
  resolveAtomicGatewayPolicy,
  throwAtomicUpstreamError,
  validateAtomicRequestAgainstModel,
} from "./atomic-executor-core"
import type { ModelDefinition } from "./model-catalog"

const IMAGE_MODEL = {
  key: "contract/image",
  upstreamModelId: "contract/image",
  name: "Contract Image",
  provider: "contract",
  catalogSource: "unified",
  transport: "unified-run",
  protocol: "unified-run",
  lifecycle: "launch",
  inputs: ["text", "image"],
  outputs: ["image"],
  capabilities: ["image-generation", "image-edit"],
  representations: [
    {
      artifact: "image",
      format: "raster",
      mimeTypes: ["image/png"],
      alpha: true,
    },
  ],
  execution: { result: "immediate", streaming: false },
  parameters: [
    {
      key: "quality",
      label: "Quality",
      kind: "select",
      options: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      default: "high",
    },
    {
      key: "steps",
      label: "Steps",
      kind: "number",
      min: 1,
      max: 50,
    },
  ],
  verification: { lastVerifiedAt: "2026-09-09", docs: [] },
} as const satisfies ModelDefinition

const QUEUED_MODEL = {
  ...IMAGE_MODEL,
  key: "contract/queued",
  upstreamModelId: "contract/queued",
  transport: "gateway-provider-native",
  execution: { result: "queued", streaming: false },
} as const satisfies ModelDefinition

const NARROWER_FALLBACK_MODEL = {
  ...IMAGE_MODEL,
  key: "contract/fallback-narrow",
  upstreamModelId: "contract/fallback-narrow",
  capabilities: ["image-generation"],
  parameters: [
    {
      key: "quality",
      label: "Quality",
      kind: "select",
      options: [{ value: "standard", label: "Standard" }],
      default: "standard",
    },
  ],
} as const satisfies ModelDefinition

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function expectAtomicError(
  fn: () => unknown,
  code: AtomicExecutionError["code"],
  message: string
) {
  try {
    fn()
  } catch (error) {
    assert(error instanceof AtomicExecutionError, `${message}: wrong error type`)
    assert(error.code === code, `${message}: expected ${code}, got ${error.code}`)
    return error
  }
  throw new Error(`${message}: expected error`)
}

async function expectAtomicErrorAsync(
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

export async function runAtomicExecutorCoreContractChecks() {
  const request = {
    modelKey: IMAGE_MODEL.key,
    input: { prompt: "a poster", quality: "high", steps: 20 },
    operation: {
      capabilities: ["image-generation"] as const,
      inputKinds: ["text"] as const,
      outputKind: "image" as const,
      representation: { artifact: "image" as const, format: "raster" as const },
    },
    correlationId: "corr_1",
    workflowStepId: "step_1",
  }

  assert(
    validateAtomicRequestAgainstModel(IMAGE_MODEL, request) === IMAGE_MODEL,
    "valid request returns resolved model"
  )

  expectAtomicError(
    () =>
      validateAtomicRequestAgainstModel(IMAGE_MODEL, {
        ...request,
        modelKey: "contract/other",
      }),
    "MODEL_NOT_FOUND",
    "catalog-key mismatch is rejected"
  )

  expectAtomicError(
    () =>
      validateAtomicRequestAgainstModel(IMAGE_MODEL, {
        ...request,
        operation: { capabilities: ["video-generation"] },
      }),
    "UNSUPPORTED_OPERATION",
    "unsupported capability is rejected"
  )

  expectAtomicError(
    () =>
      validateAtomicRequestAgainstModel(IMAGE_MODEL, {
        ...request,
        operation: {
          outputKind: "image",
          representation: { artifact: "image", format: "svg" },
        },
      }),
    "UNSUPPORTED_OPERATION",
    "unsupported output representation is rejected"
  )

  expectAtomicError(
    () =>
      validateAtomicRequestAgainstModel(IMAGE_MODEL, {
        ...request,
        input: { prompt: "a poster", quality: "ultra" },
      }),
    "INVALID_PARAMETER",
    "invalid select value is rejected"
  )

  expectAtomicError(
    () =>
      validateAtomicRequestAgainstModel(IMAGE_MODEL, {
        ...request,
        input: { prompt: "a poster", steps: 51 },
      }),
    "INVALID_PARAMETER",
    "numeric maximum is enforced"
  )

  assertSafeProviderRoute("fal-ai/kling-video/o3/standard/text-to-video")
  for (const route of [
    "../metadata",
    "/absolute/path",
    "fal-ai//bad",
    "https://example.com/model",
  ]) {
    expectAtomicError(
      () => assertSafeProviderRoute(route),
      "INVALID_INPUT",
      `unsafe route ${route} is rejected`
    )
  }

  assert(
    buildProviderNativeGatewayUrl({
      accountId: "acct",
      gatewayId: "default",
      gatewaySegment: "fal",
      route: "ideogram/v4",
    }) === "https://gateway.ai.cloudflare.com/v1/acct/default/fal/ideogram/v4",
    "provider-native sync URL is deterministic"
  )

  assert(
    buildFalQueueTarget("fal-ai/kling-video/o3/standard/text-to-video") ===
      "https://queue.fal.run/fal-ai/kling-video/o3/standard/text-to-video",
    "Fal queue target is deterministic"
  )

  const metadata = buildAtomicMetadata(IMAGE_MODEL, request, "upstream_1")
  assert(metadata.requestedModelKey === IMAGE_MODEL.key, "metadata keeps requested key")
  assert(metadata.resolvedModelKey === IMAGE_MODEL.key, "metadata keeps resolved key")
  assert(metadata.correlationId === "corr_1", "metadata keeps correlation id")
  assert(metadata.workflowStepId === "step_1", "metadata keeps workflow step id")
  assert(metadata.upstreamRequestId === "upstream_1", "metadata keeps request id")

  const headers = new Headers({
    "cf-aig-request-id": "gateway_1",
    "x-fal-request-id": "fal_1",
  })
  assert(
    extractAtomicRequestId(headers) === "gateway_1",
    "Gateway request id takes precedence"
  )

  assert(
    extractAtomicUsage({ usage: { input_tokens: 2, output_tokens: 3 } })
      ?.input_tokens === 2,
    "usage object is normalized"
  )

  const jsonPayload = await readAtomicResponsePayload(
    new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    })
  )
  assert(
    jsonPayload.type === "json" &&
      (jsonPayload.value as { ok?: boolean }).ok === true,
    "JSON payload is preserved"
  )

  const textPayload = await readAtomicResponsePayload(
    new Response("hello", { headers: { "content-type": "text/plain" } })
  )
  assert(
    textPayload.type === "text" && textPayload.value === "hello",
    "text payload is preserved"
  )

  const binaryPayload = await readAtomicResponsePayload(
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    })
  )
  assert(
    binaryPayload.type === "binary" && binaryPayload.value.byteLength === 3,
    "binary payload is preserved"
  )

  await expectAtomicErrorAsync(
    () =>
      readAtomicResponsePayload(
        new Response("{not-json", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "bad_json_1",
          },
        })
      ),
    "UPSTREAM_INVALID_RESPONSE",
    "invalid upstream JSON is normalized"
  )

  assert(
    classifyAtomicHttpError(429).code === "UPSTREAM_RATE_LIMIT" &&
      classifyAtomicHttpError(429).retryable,
    "429 is retryable rate limit"
  )
  assert(
    classifyAtomicHttpError(400).code === "UPSTREAM_REJECTED" &&
      !classifyAtomicHttpError(400).retryable,
    "400 is non-retryable rejection"
  )
  assert(
    classifyAtomicHttpError(503).code === "UPSTREAM_UNAVAILABLE" &&
      classifyAtomicHttpError(503).retryable,
    "503 is retryable unavailable"
  )

  const rateLimitError = await expectAtomicErrorAsync(
    () =>
      throwAtomicUpstreamError(
        new Response("slow down", {
          status: 429,
          headers: { "x-request-id": "rate_1" },
        })
      ),
    "UPSTREAM_RATE_LIMIT",
    "HTTP error is normalized"
  )
  assert(rateLimitError.retryable, "rate-limit error is retryable")
  assert(rateLimitError.requestId === "rate_1", "HTTP error preserves request id")

  assert(
    normalizeAtomicQueueState({ status: "IN_QUEUE" }) === "queued",
    "IN_QUEUE normalizes to queued"
  )
  assert(
    normalizeAtomicQueueState({ status: "IN_PROGRESS" }) === "running",
    "IN_PROGRESS normalizes to running"
  )
  assert(
    normalizeAtomicQueueState({ status: "COMPLETED" }) === "unknown",
    "unexpected submit status remains unknown for #10"
  )

  // #13: Gateway routing policy ----------------------------------------
  const immediatePolicy = resolveAtomicGatewayPolicy(IMAGE_MODEL, {
    ownerId: "owner_1",
    correlationId: "corr_1",
    workflowStepId: "step_1",
  })
  assert(immediatePolicy.skipCache === true, "generation calls skip cache")
  assert(immediatePolicy.retries === undefined, "no automatic Gateway retry pending #10 idempotency")
  assert(
    immediatePolicy.metadata.owner_id === "owner_1" &&
      immediatePolicy.metadata.correlation_id === "corr_1" &&
      immediatePolicy.metadata.workflow_step_id === "step_1" &&
      immediatePolicy.metadata.resolved_model_key === IMAGE_MODEL.key,
    "policy metadata carries only trusted attribution ids"
  )

  const anonymousPolicy = resolveAtomicGatewayPolicy(IMAGE_MODEL, {})
  assert(
    !("owner_id" in anonymousPolicy.metadata) &&
      !("correlation_id" in anonymousPolicy.metadata) &&
      !("workflow_step_id" in anonymousPolicy.metadata),
    "policy metadata omits absent context rather than sending empty values"
  )

  const queuedPolicy = resolveAtomicGatewayPolicy(QUEUED_MODEL, {})
  assert(
    queuedPolicy.requestTimeoutMs < immediatePolicy.requestTimeoutMs,
    "queued submission timeout is shorter than an immediate/streaming call"
  )

  // #13: fallback candidate compatibility --------------------------------
  const fallbackRequest = {
    input: { prompt: "a poster", quality: "high", steps: 20 },
    operation: {
      capabilities: ["image-generation", "image-edit"] as const,
      outputKind: "image" as const,
    },
  }
  assert(
    fallbackCandidateSupportsRequest(IMAGE_MODEL, fallbackRequest),
    "a model satisfying the request's operation and parameters is a valid fallback candidate"
  )
  assert(
    !fallbackCandidateSupportsRequest(NARROWER_FALLBACK_MODEL, fallbackRequest),
    "a fallback missing a required capability (image-edit) is rejected"
  )
  assert(
    !fallbackCandidateSupportsRequest(NARROWER_FALLBACK_MODEL, {
      input: { prompt: "a poster", quality: "high" },
      operation: { capabilities: ["image-generation"] as const },
    }),
    "a fallback whose own parameter schema rejects the input is rejected, even with a compatible capability set"
  )
  assert(
    fallbackCandidateSupportsRequest(NARROWER_FALLBACK_MODEL, {
      input: { prompt: "a poster", quality: "standard" },
      operation: { capabilities: ["image-generation"] as const },
    }),
    "a fallback is accepted once both operation and its own parameter schema are satisfied"
  )

  return true
}

void runAtomicExecutorCoreContractChecks()
