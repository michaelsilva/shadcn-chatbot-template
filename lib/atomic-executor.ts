import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createWorkersAI } from "workers-ai-provider"

import {
  AtomicExecutionError,
  assertSafeProviderRoute,
  buildAtomicMetadata,
  buildFalQueueTarget,
  buildProviderNativeGatewayUrl,
  extractAtomicRequestId,
  extractAtomicUsage,
  normalizeAtomicQueueState,
  readAtomicResponsePayload,
  readAtomicStringField,
  throwAtomicUpstreamError,
  validateAtomicRequestAgainstModel,
  type AtomicExecutionMetadata,
  type AtomicImmediatePayload,
  type AtomicOperationRequirement,
  type AtomicRequestBase,
} from "./atomic-executor-core"
import { findEnabledCatalogModel, type ModelDefinition } from "./model-catalog"
import { MODEL_CATALOG } from "./model-catalog-data"

export {
  AtomicExecutionError,
  type AtomicErrorCode,
  type AtomicExecutionMetadata,
  type AtomicImmediatePayload,
  type AtomicOperationRequirement,
  type AtomicRequestBase,
} from "./atomic-executor-core"

const PROVIDER_AUTH_PLACEHOLDER = "binding-authenticated"

export interface AtomicExecuteRequest extends AtomicRequestBase {}
export interface AtomicSubmitRequest extends AtomicRequestBase {}

export interface AtomicImmediateResult {
  kind: "immediate"
  model: ModelDefinition
  payload: AtomicImmediatePayload
  usage?: Record<string, unknown>
  metadata: AtomicExecutionMetadata
}

export interface AtomicSubmissionHandle {
  kind: "submitted"
  model: ModelDefinition
  externalJob: {
    provider: string
    requestId: string
    statusUrl?: string
    responseUrl?: string
    cancelUrl?: string
    initialState: "queued" | "running" | "unknown"
  }
  metadata: AtomicExecutionMetadata
}

export interface AtomicExecutorRuntime {
  fetch?: typeof fetch
}

type AtomicExecutorEnv = CloudflareEnv & {
  CLOUDFLARE_ACCOUNT_ID?: string
  CLOUDFLARE_AI_GATEWAY_TOKEN?: string
  FAL_KEY?: string
}

type ProviderAuthMode = "sync" | "custom-target"

interface ProviderNativeAdapter {
  gatewaySegment: string
  authEnv: "FAL_KEY"
  syncAuthPrefix: string
  customTargetAuthPrefix: string
  queueOrigin?: string
}

const PROVIDER_NATIVE_ADAPTERS: Readonly<Record<string, ProviderNativeAdapter>> = {
  fal: {
    gatewaySegment: "fal",
    authEnv: "FAL_KEY",
    syncAuthPrefix: "Key",
    customTargetAuthPrefix: "Bearer",
    queueOrigin: "https://queue.fal.run",
  },
}

function getEnvString(env: AtomicExecutorEnv, key: keyof AtomicExecutorEnv) {
  const value = env[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function requireEnvString(
  env: AtomicExecutorEnv,
  key: keyof AtomicExecutorEnv,
  label: string
) {
  const value = getEnvString(env, key)
  if (!value) {
    throw new AtomicExecutionError(
      "MISSING_CONFIGURATION",
      `${label} is required for this atomic transport.`
    )
  }
  return value
}

function resolveModel(modelKey: string) {
  const model = findEnabledCatalogModel(MODEL_CATALOG, modelKey)
  if (!model) {
    throw new AtomicExecutionError(
      "MODEL_NOT_FOUND",
      `Model or endpoint ${modelKey} is not enabled.`
    )
  }
  return model
}

export function validateAtomicRequest(request: AtomicRequestBase) {
  const model = resolveModel(request.modelKey)
  return validateAtomicRequestAgainstModel(model, request)
}

function parseProtocolRequestBody(body: BodyInit | null | undefined) {
  if (typeof body !== "string") {
    throw new AtomicExecutionError(
      "INVALID_INPUT",
      "Language-model protocol request body must be JSON."
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new AtomicExecutionError(
      "INVALID_INPUT",
      "Language-model protocol request body must contain valid JSON."
    )
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AtomicExecutionError(
      "INVALID_INPUT",
      "Language-model protocol request body must be a JSON object."
    )
  }

  const input = { ...(parsed as Record<string, unknown>) }
  delete input.model
  return input
}

function createBindingProtocolFetch(
  env: AtomicExecutorEnv,
  model: ModelDefinition
): typeof fetch {
  return async (_input, init) => {
    const response = await env.AI.run(
      model.upstreamModelId,
      parseProtocolRequestBody(init?.body),
      {
        gateway: { id: env.CLOUDFLARE_AI_GATEWAY_ID },
        returnRawResponse: true,
        ...(init?.signal ? { signal: init.signal } : {}),
      }
    )

    return response as unknown as Response
  }
}

function sdkModelId(model: ModelDefinition) {
  const prefix = `${model.provider}/`
  return model.upstreamModelId.startsWith(prefix)
    ? model.upstreamModelId.slice(prefix.length)
    : model.upstreamModelId
}

export function assertLanguageModel(model: ModelDefinition) {
  if (
    !model.capabilities.includes("chat") ||
    !model.inputs.includes("text") ||
    !model.outputs.includes("text")
  ) {
    throw new AtomicExecutionError(
      "UNSUPPORTED_OPERATION",
      `${model.key} is not a text chat language model.`
    )
  }

  if (
    model.protocol !== "workers-ai" &&
    model.protocol !== "responses" &&
    model.protocol !== "messages" &&
    model.protocol !== "chat-completions"
  ) {
    throw new AtomicExecutionError(
      "UNSUPPORTED_OPERATION",
      `${model.key} cannot use the streaming language-model adapter.`
    )
  }
}

/**
 * Returns one Vercel AI SDK language model selected entirely from catalog
 * protocol metadata. Provider names are not used to choose the protocol.
 */
export function getAtomicLanguageModel(env: CloudflareEnv, modelKey: string) {
  const model = resolveModel(modelKey)
  assertLanguageModel(model)
  const atomicEnv = env as AtomicExecutorEnv

  if (model.protocol === "workers-ai") {
    const workersAI = createWorkersAI({
      binding: env.AI,
      gateway: { id: env.CLOUDFLARE_AI_GATEWAY_ID },
    })
    return workersAI(model.upstreamModelId)
  }

  const protocolFetch = createBindingProtocolFetch(atomicEnv, model)

  if (model.protocol === "messages") {
    const anthropic = createAnthropic({
      apiKey: PROVIDER_AUTH_PLACEHOLDER,
      fetch: protocolFetch,
    })
    return anthropic(sdkModelId(model))
  }

  const openaiCompatible = createOpenAI({
    apiKey: PROVIDER_AUTH_PLACEHOLDER,
    fetch: protocolFetch,
  })

  if (model.protocol === "responses") {
    return openaiCompatible.responses(sdkModelId(model))
  }

  return openaiCompatible.chat(sdkModelId(model))
}

async function runBindingAtomic(
  env: AtomicExecutorEnv,
  model: ModelDefinition,
  request: AtomicExecuteRequest
): Promise<AtomicImmediateResult> {
  let response: Response
  try {
    response = (await env.AI.run(model.upstreamModelId, request.input, {
      gateway: { id: env.CLOUDFLARE_AI_GATEWAY_ID },
      returnRawResponse: true,
      ...(request.signal ? { signal: request.signal } : {}),
    })) as unknown as Response
  } catch (error) {
    if (error instanceof AtomicExecutionError) throw error
    throw new AtomicExecutionError(
      "UPSTREAM_UNAVAILABLE",
      error instanceof Error ? error.message : "Upstream execution failed.",
      { retryable: true }
    )
  }

  if (!response.ok) await throwAtomicUpstreamError(response)
  const payload = await readAtomicResponsePayload(response)
  const usage = payload.type === "json" ? extractAtomicUsage(payload.value) : undefined

  return {
    kind: "immediate",
    model,
    payload,
    usage,
    metadata: buildAtomicMetadata(
      model,
      request,
      extractAtomicRequestId(response.headers)
    ),
  }
}

function providerNativeAdapter(model: ModelDefinition) {
  const adapter = PROVIDER_NATIVE_ADAPTERS[model.provider]
  if (!adapter) {
    throw new AtomicExecutionError(
      "UNSUPPORTED_OPERATION",
      `No provider-native Gateway adapter is registered for ${model.provider}.`
    )
  }
  return adapter
}

function providerNativeHeaders(
  env: AtomicExecutorEnv,
  adapter: ProviderNativeAdapter,
  mode: ProviderAuthMode
) {
  const token = requireEnvString(env, adapter.authEnv, adapter.authEnv)
  const authPrefix =
    mode === "custom-target"
      ? adapter.customTargetAuthPrefix
      : adapter.syncAuthPrefix
  const headers = new Headers({
    Authorization: `${authPrefix} ${token}`,
    "Content-Type": "application/json",
  })

  const gatewayToken = getEnvString(env, "CLOUDFLARE_AI_GATEWAY_TOKEN")
  if (gatewayToken) {
    headers.set("cf-aig-authorization", `Bearer ${gatewayToken}`)
  }

  return headers
}

function providerNativeGatewayUrl(
  env: AtomicExecutorEnv,
  adapter: ProviderNativeAdapter,
  route?: string
) {
  const accountId = requireEnvString(
    env,
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_ACCOUNT_ID"
  )
  return buildProviderNativeGatewayUrl({
    accountId,
    gatewayId: env.CLOUDFLARE_AI_GATEWAY_ID,
    gatewaySegment: adapter.gatewaySegment,
    route,
  })
}

async function callProviderNative(
  env: AtomicExecutorEnv,
  model: ModelDefinition,
  request: AtomicRequestBase,
  runtime: AtomicExecutorRuntime,
  options: {
    mode: ProviderAuthMode
    route?: string
    targetUrl?: string
  }
) {
  if (options.route) assertSafeProviderRoute(options.route)
  const adapter = providerNativeAdapter(model)
  const headers = providerNativeHeaders(env, adapter, options.mode)
  if (options.targetUrl) headers.set("x-fal-target-url", options.targetUrl)

  try {
    return await (runtime.fetch ?? fetch)(
      providerNativeGatewayUrl(env, adapter, options.route),
      {
        method: "POST",
        headers,
        body: JSON.stringify(request.input),
        signal: request.signal,
      }
    )
  } catch (error) {
    if (error instanceof AtomicExecutionError) throw error
    throw new AtomicExecutionError(
      "UPSTREAM_UNAVAILABLE",
      error instanceof Error ? error.message : "Provider-native request failed.",
      { retryable: true }
    )
  }
}

async function executeProviderNative(
  env: AtomicExecutorEnv,
  model: ModelDefinition,
  request: AtomicExecuteRequest,
  runtime: AtomicExecutorRuntime
): Promise<AtomicImmediateResult> {
  const response = await callProviderNative(env, model, request, runtime, {
    mode: "sync",
    route: model.upstreamModelId,
  })

  if (!response.ok) await throwAtomicUpstreamError(response)
  const payload = await readAtomicResponsePayload(response)
  const usage = payload.type === "json" ? extractAtomicUsage(payload.value) : undefined

  return {
    kind: "immediate",
    model,
    payload,
    usage,
    metadata: buildAtomicMetadata(
      model,
      request,
      extractAtomicRequestId(response.headers)
    ),
  }
}

/** Execute exactly one immediate-capable trusted catalog entry. */
export async function executeAtomic(
  env: CloudflareEnv,
  request: AtomicExecuteRequest,
  runtime: AtomicExecutorRuntime = {}
): Promise<AtomicImmediateResult> {
  const model = validateAtomicRequest(request)
  const atomicEnv = env as AtomicExecutorEnv

  if (model.transport === "gateway-provider-native") {
    if (model.execution.result === "queued") {
      throw new AtomicExecutionError(
        "UNSUPPORTED_OPERATION",
        `${model.key} is queue-only; submit it with submitAtomic().`
      )
    }
    return executeProviderNative(atomicEnv, model, request, runtime)
  }

  return runBindingAtomic(atomicEnv, model, request)
}

/**
 * Submit exactly one provider-native queued atomic invocation. Durable polling,
 * callbacks, retry scheduling, and completion ingestion belong to #10.
 */
export async function submitAtomic(
  env: CloudflareEnv,
  request: AtomicSubmitRequest,
  runtime: AtomicExecutorRuntime = {}
): Promise<AtomicSubmissionHandle> {
  const model = validateAtomicRequest(request)
  const atomicEnv = env as AtomicExecutorEnv

  if (model.transport !== "gateway-provider-native") {
    throw new AtomicExecutionError(
      "UNSUPPORTED_OPERATION",
      `${model.key} does not use the provider-native queue transport.`
    )
  }
  if (model.execution.result === "immediate") {
    throw new AtomicExecutionError(
      "UNSUPPORTED_OPERATION",
      `${model.key} is immediate-only and cannot be submitted as a queued job.`
    )
  }

  assertSafeProviderRoute(model.upstreamModelId)
  const adapter = providerNativeAdapter(model)
  if (!adapter.queueOrigin) {
    throw new AtomicExecutionError(
      "UNSUPPORTED_OPERATION",
      `${model.provider} does not declare an asynchronous queue target.`
    )
  }

  const response = await callProviderNative(atomicEnv, model, request, runtime, {
    mode: "custom-target",
    targetUrl: buildFalQueueTarget(model.upstreamModelId),
  })

  if (!response.ok) await throwAtomicUpstreamError(response)
  const payload = await readAtomicResponsePayload(response)
  if (payload.type !== "json") {
    throw new AtomicExecutionError(
      "UPSTREAM_INVALID_RESPONSE",
      "Queued provider-native submission did not return JSON.",
      { requestId: extractAtomicRequestId(response.headers) }
    )
  }

  const requestId = readAtomicStringField(payload.value, "request_id")
  if (!requestId) {
    throw new AtomicExecutionError(
      "UPSTREAM_INVALID_RESPONSE",
      "Queued provider-native submission did not return request_id.",
      { requestId: extractAtomicRequestId(response.headers) }
    )
  }

  return {
    kind: "submitted",
    model,
    externalJob: {
      provider: model.provider,
      requestId,
      statusUrl: readAtomicStringField(payload.value, "status_url"),
      responseUrl: readAtomicStringField(payload.value, "response_url"),
      cancelUrl: readAtomicStringField(payload.value, "cancel_url"),
      initialState: normalizeAtomicQueueState(payload.value),
    },
    metadata: buildAtomicMetadata(
      model,
      request,
      extractAtomicRequestId(response.headers) ?? requestId
    ),
  }
}
