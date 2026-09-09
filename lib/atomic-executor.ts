import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createWorkersAI } from "workers-ai-provider"

import {
  findEnabledCatalogModel,
  type ArtifactKind,
  type ModelCapability,
  type ModelDefinition,
  type OutputRepresentationSelector,
} from "./model-catalog"
import { MODEL_CATALOG } from "./model-catalog-data"

const PROVIDER_AUTH_PLACEHOLDER = "binding-authenticated"
const SAFE_PROVIDER_ROUTE = /^[A-Za-z0-9@._/-]+$/

export type AtomicErrorCode =
  | "MODEL_NOT_FOUND"
  | "UNSUPPORTED_OPERATION"
  | "INVALID_INPUT"
  | "INVALID_PARAMETER"
  | "MISSING_CONFIGURATION"
  | "UPSTREAM_AUTH"
  | "UPSTREAM_PAYMENT"
  | "UPSTREAM_RATE_LIMIT"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_REJECTED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_INVALID_RESPONSE"

export class AtomicExecutionError extends Error {
  readonly code: AtomicErrorCode
  readonly retryable: boolean
  readonly status?: number
  readonly requestId?: string

  constructor(
    code: AtomicErrorCode,
    message: string,
    options: {
      retryable?: boolean
      status?: number
      requestId?: string
    } = {}
  ) {
    super(message)
    this.name = "AtomicExecutionError"
    this.code = code
    this.retryable = options.retryable ?? false
    this.status = options.status
    this.requestId = options.requestId
  }
}

export interface AtomicOperationRequirement {
  capabilities?: readonly ModelCapability[]
  inputKinds?: readonly ArtifactKind[]
  outputKind?: ArtifactKind
  representation?: OutputRepresentationSelector
}

export interface AtomicRequestBase {
  modelKey: string
  input: Record<string, unknown>
  operation?: AtomicOperationRequirement
  correlationId?: string
  workflowStepId?: string
  signal?: AbortSignal
}

export interface AtomicExecuteRequest extends AtomicRequestBase {}

export interface AtomicSubmitRequest extends AtomicRequestBase {}

export interface AtomicExecutionMetadata {
  requestedModelKey: string
  resolvedModelKey: string
  upstreamModelId: string
  provider: string
  catalogSource: ModelDefinition["catalogSource"]
  transport: ModelDefinition["transport"]
  protocol: ModelDefinition["protocol"]
  correlationId?: string
  workflowStepId?: string
  upstreamRequestId?: string
}

export type AtomicImmediatePayload =
  | { type: "json"; value: unknown }
  | { type: "text"; value: string; contentType?: string }
  | { type: "binary"; value: ArrayBuffer; contentType?: string }

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

interface ProviderNativeAdapter {
  gatewaySegment: string
  authEnv: keyof Pick<AtomicExecutorEnv, "FAL_KEY">
  authPrefix: string
  queueOrigin?: string
}

const PROVIDER_NATIVE_ADAPTERS: Readonly<Record<string, ProviderNativeAdapter>> = {
  fal: {
    gatewaySegment: "fal",
    authEnv: "FAL_KEY",
    authPrefix: "Key",
    queueOrigin: "https://queue.fal.run",
  },
}

function includesAll<T>(available: readonly T[], required?: readonly T[]) {
  return !required?.length || required.every((item) => available.includes(item))
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

function assertSafeProviderRoute(route: string) {
  const segments = route.split("/")
  if (
    !route ||
    route.startsWith("/") ||
    !SAFE_PROVIDER_ROUTE.test(route) ||
    segments.some((segment) => segment === ".." || segment === ".")
  ) {
    throw new AtomicExecutionError(
      "INVALID_INPUT",
      `Unsafe provider-native catalog route: ${route}`
    )
  }
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

function assertOperationSupported(
  model: ModelDefinition,
  operation?: AtomicOperationRequirement
) {
  if (!operation) return

  if (!includesAll(model.capabilities, operation.capabilities)) {
    throw new AtomicExecutionError(
      "UNSUPPORTED_OPERATION",
      `${model.key} does not support the requested capability set.`
    )
  }

  if (!includesAll(model.inputs, operation.inputKinds)) {
    throw new AtomicExecutionError(
      "UNSUPPORTED_OPERATION",
      `${model.key} does not accept the requested input artifact kinds.`
    )
  }

  if (operation.outputKind && !model.outputs.includes(operation.outputKind)) {
    throw new AtomicExecutionError(
      "UNSUPPORTED_OPERATION",
      `${model.key} does not produce ${operation.outputKind}.`
    )
  }

  if (
    operation.representation &&
    !model.representations?.some(
      (representation) =>
        representation.artifact === operation.representation?.artifact &&
        representation.format === operation.representation?.format
    )
  ) {
    throw new AtomicExecutionError(
      "UNSUPPORTED_OPERATION",
      `${model.key} does not produce the requested representation.`
    )
  }
}

function validateConfiguredParameters(
  model: ModelDefinition,
  input: Record<string, unknown>
) {
  for (const parameter of model.parameters ?? []) {
    if (!(parameter.key in input)) continue
    const value = input[parameter.key]

    if (parameter.kind === "boolean" && typeof value !== "boolean") {
      throw new AtomicExecutionError(
        "INVALID_PARAMETER",
        `${parameter.key} must be a boolean.`
      )
    }

    if (parameter.kind === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new AtomicExecutionError(
          "INVALID_PARAMETER",
          `${parameter.key} must be a finite number.`
        )
      }
      if (parameter.min !== undefined && value < parameter.min) {
        throw new AtomicExecutionError(
          "INVALID_PARAMETER",
          `${parameter.key} must be at least ${parameter.min}.`
        )
      }
      if (parameter.max !== undefined && value > parameter.max) {
        throw new AtomicExecutionError(
          "INVALID_PARAMETER",
          `${parameter.key} must be at most ${parameter.max}.`
        )
      }
    }

    if (parameter.kind === "text" && typeof value !== "string") {
      throw new AtomicExecutionError(
        "INVALID_PARAMETER",
        `${parameter.key} must be text.`
      )
    }

    if (parameter.kind === "select") {
      if (
        typeof value !== "string" ||
        !parameter.options.some((option) => option.value === value)
      ) {
        throw new AtomicExecutionError(
          "INVALID_PARAMETER",
          `${parameter.key} is not an allowed value.`
        )
      }
    }
  }
}

export function validateAtomicRequest(request: AtomicRequestBase) {
  if (
    !request.input ||
    typeof request.input !== "object" ||
    Array.isArray(request.input)
  ) {
    throw new AtomicExecutionError(
      "INVALID_INPUT",
      "Atomic execution input must be a JSON object."
    )
  }

  const model = resolveModel(request.modelKey)
  assertOperationSupported(model, request.operation)
  validateConfiguredParameters(model, request.input)
  return model
}

function buildMetadata(
  model: ModelDefinition,
  request: AtomicRequestBase,
  upstreamRequestId?: string
): AtomicExecutionMetadata {
  return {
    requestedModelKey: request.modelKey,
    resolvedModelKey: model.key,
    upstreamModelId: model.upstreamModelId,
    provider: model.provider,
    catalogSource: model.catalogSource,
    transport: model.transport,
    protocol: model.protocol,
    correlationId: request.correlationId,
    workflowStepId: request.workflowStepId,
    upstreamRequestId,
  }
}

function extractRequestId(headers: Headers) {
  return (
    headers.get("cf-aig-request-id") ??
    headers.get("x-fal-request-id") ??
    headers.get("x-request-id") ??
    undefined
  )
}

function extractUsage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const usage = (value as Record<string, unknown>).usage
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : undefined
}

async function readResponsePayload(response: Response): Promise<AtomicImmediatePayload> {
  const contentType = response.headers.get("content-type") ?? undefined

  if (contentType?.includes("application/json")) {
    const text = await response.text()
    if (!text) return { type: "json", value: null }
    try {
      return { type: "json", value: JSON.parse(text) }
    } catch {
      throw new AtomicExecutionError(
        "UPSTREAM_INVALID_RESPONSE",
        "Upstream returned invalid JSON.",
        { retryable: false, status: response.status, requestId: extractRequestId(response.headers) }
      )
    }
  }

  if (contentType?.startsWith("text/")) {
    return { type: "text", value: await response.text(), contentType }
  }

  return {
    type: "binary",
    value: await response.arrayBuffer(),
    contentType,
  }
}

function classifyHttpError(status: number): {
  code: AtomicErrorCode
  retryable: boolean
} {
  if (status === 401 || status === 403) {
    return { code: "UPSTREAM_AUTH", retryable: false }
  }
  if (status === 402) {
    return { code: "UPSTREAM_PAYMENT", retryable: false }
  }
  if (status === 408 || status === 504) {
    return { code: "UPSTREAM_TIMEOUT", retryable: true }
  }
  if (status === 429) {
    return { code: "UPSTREAM_RATE_LIMIT", retryable: true }
  }
  if (status >= 500) {
    return { code: "UPSTREAM_UNAVAILABLE", retryable: true }
  }
  return { code: "UPSTREAM_REJECTED", retryable: false }
}

async function throwUpstreamError(response: Response): Promise<never> {
  const { code, retryable } = classifyHttpError(response.status)
  const requestId = extractRequestId(response.headers)
  let detail = ""
  try {
    detail = (await response.text()).slice(0, 1000)
  } catch {
    // Ignore body-read failures; status still carries the stable error class.
  }

  throw new AtomicExecutionError(
    code,
    detail
      ? `Upstream request failed (${response.status}): ${detail}`
      : `Upstream request failed with status ${response.status}.`,
    { retryable, status: response.status, requestId }
  )
}

function parseProviderBody(body: BodyInit | null | undefined) {
  if (typeof body !== "string") {
    throw new AtomicExecutionError(
      "INVALID_INPUT",
      "Language-model protocol request body must be JSON."
    )
  }

  const parsed: unknown = JSON.parse(body)
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
      parseProviderBody(init?.body),
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
      `${model.key} cannot be exposed through the streaming language-model adapter.`
    )
  }
}

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
    return anthropic.messages(sdkModelId(model))
  }

  const openai = createOpenAI({
    apiKey: PROVIDER_AUTH_PLACEHOLDER,
    name: `cloudflare-${model.protocol}`,
    fetch: protocolFetch,
  })

  if (model.protocol === "responses") {
    return openai.responses(sdkModelId(model))
  }

  return openai.chat(sdkModelId(model))
}

async function runBindingAtomic(
  env: AtomicExecutorEnv,
  model: ModelDefinition,
  request: AtomicExecuteRequest
) {
  const response = (await env.AI.run(model.upstreamModelId, request.input, {
    gateway: { id: env.CLOUDFLARE_AI_GATEWAY_ID },
    returnRawResponse: true,
    ...(request.signal ? { signal: request.signal } : {}),
  })) as unknown as Response

  if (!response.ok) await throwUpstreamError(response)
  const payload = await readResponsePayload(response)
  const usage = payload.type === "json" ? extractUsage(payload.value) : undefined
  return {
    kind: "immediate" as const,
    model,
    payload,
    usage,
    metadata: buildMetadata(model, request, extractRequestId(response.headers)),
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
  adapter: ProviderNativeAdapter
) {
  const token = requireEnvString(env, adapter.authEnv, `${adapter.authEnv}`)
  const headers = new Headers({
    Authorization: `${adapter.authPrefix} ${token}`,
    "Content-Type": "application/json",
  })

  const gatewayToken = getEnvString(env, "CLOUDFLARE_AI_GATEWAY_TOKEN")
  if (gatewayToken) {
    headers.set("cf-aig-authorization", `Bearer ${gatewayToken}`)
  }

  return headers
}

function gatewayProviderBaseUrl(
  env: AtomicExecutorEnv,
  adapter: ProviderNativeAdapter
) {
  const accountId = requireEnvString(
    env,
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_ACCOUNT_ID"
  )
  const gatewayId = env.CLOUDFLARE_AI_GATEWAY_ID
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/${adapter.gatewaySegment}`
}

async function executeProviderNative(
  env: AtomicExecutorEnv,
  model: ModelDefinition,
  request: AtomicExecuteRequest,
  runtime: AtomicExecutorRuntime
): Promise<AtomicImmediateResult> {
  assertSafeProviderRoute(model.upstreamModelId)
  const adapter = providerNativeAdapter(model)
  const response = await (runtime.fetch ?? fetch)(
    `${gatewayProviderBaseUrl(env, adapter)}/${model.upstreamModelId}`,
    {
      method: "POST",
      headers: providerNativeHeaders(env, adapter),
      body: JSON.stringify(request.input),
      signal: request.signal,
    }
  )

  if (!response.ok) await throwUpstreamError(response)
  const payload = await readResponsePayload(response)
  const usage = payload.type === "json" ? extractUsage(payload.value) : undefined
  return {
    kind: "immediate",
    model,
    payload,
    usage,
    metadata: buildMetadata(model, request, extractRequestId(response.headers)),
  }
}

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

function readStringField(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" && field ? field : undefined
}

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

  const headers = providerNativeHeaders(atomicEnv, adapter)
  headers.set(
    "x-fal-target-url",
    `${adapter.queueOrigin}/${model.upstreamModelId}`
  )

  const response = await (runtime.fetch ?? fetch)(
    gatewayProviderBaseUrl(atomicEnv, adapter),
    {
      method: "POST",
      headers,
      body: JSON.stringify(request.input),
      signal: request.signal,
    }
  )

  if (!response.ok) await throwUpstreamError(response)
  const payload = await readResponsePayload(response)
  if (payload.type !== "json") {
    throw new AtomicExecutionError(
      "UPSTREAM_INVALID_RESPONSE",
      "Queued provider-native submission did not return JSON.",
      { requestId: extractRequestId(response.headers) }
    )
  }

  const requestId = readStringField(payload.value, "request_id")
  if (!requestId) {
    throw new AtomicExecutionError(
      "UPSTREAM_INVALID_RESPONSE",
      "Queued provider-native submission did not return request_id.",
      { requestId: extractRequestId(response.headers) }
    )
  }

  const status = readStringField(payload.value, "status")
  const initialState =
    status === "IN_PROGRESS"
      ? "running"
      : status === "IN_QUEUE" || !status
        ? "queued"
        : "unknown"

  return {
    kind: "submitted",
    model,
    externalJob: {
      provider: model.provider,
      requestId,
      statusUrl: readStringField(payload.value, "status_url"),
      responseUrl: readStringField(payload.value, "response_url"),
      cancelUrl: readStringField(payload.value, "cancel_url"),
      initialState,
    },
    metadata: buildMetadata(
      model,
      request,
      extractRequestId(response.headers) ?? requestId
    ),
  }
}
