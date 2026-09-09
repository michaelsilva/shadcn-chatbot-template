import type {
  ArtifactKind,
  ModelCapability,
  ModelDefinition,
  OutputRepresentationSelector,
} from "./model-catalog"

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

/**
 * #13: the small, trusted attribution dimension attached to every Gateway
 * call as `metadata` — never prompt/media content. `ownerId` is the D1
 * owner (#6/#15 authorization boundary), not a browser-supplied value.
 */
export interface AtomicRequestContext {
  ownerId?: string
  correlationId?: string
  workflowStepId?: string
}

export interface AtomicRequestBase extends AtomicRequestContext {
  modelKey: string
  input: Record<string, unknown>
  operation?: AtomicOperationRequirement
  signal?: AbortSignal
}

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

function includesAll<T>(available: readonly T[], required?: readonly T[]) {
  return !required?.length || required.every((item) => available.includes(item))
}

export function assertSafeProviderRoute(route: string) {
  const safeProviderRoute = /^[A-Za-z0-9@._/-]+$/
  const segments = route.split("/")

  if (
    !route ||
    route.startsWith("/") ||
    !safeProviderRoute.test(route) ||
    segments.some((segment) => segment === ".." || segment === "." || !segment)
  ) {
    throw new AtomicExecutionError(
      "INVALID_INPUT",
      `Unsafe provider-native catalog route: ${route}`
    )
  }
}

export function assertOperationSupported(
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

export function validateConfiguredParameters(
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

/**
 * #13: does this catalog entry actually support the calling request —
 * both the declared operation shape and its own parameter schema
 * against the same `request.input`? Used to filter `fallbackModelKeys`
 * candidates, which share transport/protocol with the primary but may
 * still declare a different parameter schema (e.g. different `select`
 * options), so falling back must not skip that check.
 */
export function fallbackCandidateSupportsRequest(
  model: ModelDefinition,
  request: Pick<AtomicRequestBase, "input" | "operation">
): boolean {
  try {
    assertOperationSupported(model, request.operation)
    validateConfiguredParameters(model, request.input)
    return true
  } catch {
    return false
  }
}

export function validateAtomicRequestAgainstModel(
  model: ModelDefinition,
  request: AtomicRequestBase
) {
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

  if (request.modelKey !== model.key) {
    throw new AtomicExecutionError(
      "MODEL_NOT_FOUND",
      `Resolved model ${model.key} does not match requested catalog key ${request.modelKey}.`
    )
  }

  assertOperationSupported(model, request.operation)
  validateConfiguredParameters(model, request.input)
  return model
}

/**
 * #13: the AI Gateway routing policy for one atomic call — cache,
 * request timeout, and retry behavior — plus the trusted metadata
 * dimension attached for later attribution/observability (#14).
 * Deliberately transport-agnostic: `executeAtomic()`/`getAtomicLanguageModel()`
 * translate this into `env.AI.run()`'s `gateway` option object, and the
 * provider-native path translates it into `cf-aig-*` headers, but the
 * policy itself is decided once, here, from catalog/request shape only.
 */
export interface AtomicGatewayPolicy {
  metadata: Record<string, string>
  skipCache: boolean
  requestTimeoutMs: number
  /**
   * Deliberately `undefined` for every v0.1 execution class. Cloudflare
   * Gateway's automatic retry re-sends the same request to the same
   * model on failure, but the Gateway cannot know whether an upstream
   * provider already started billable generation work before returning
   * an error — enabling it here would risk a duplicate paid job on top
   * of every transient 5xx/timeout, which is exactly the "unbounded
   * duplicate paid generation" failure #10 exists to prevent. #10's
   * submission idempotency (an app-owned idempotency key the provider
   * can de-duplicate against) is the prerequisite for turning this on
   * for the execution classes it covers; this field stays typed and
   * threaded through so that follow-up work is a policy change here,
   * not a new mechanism.
   */
  retries?: {
    maxAttempts: 1 | 2 | 3 | 4 | 5
    retryDelayMs: number
    backoff: "constant" | "linear" | "exponential"
  }
}

const IMMEDIATE_REQUEST_TIMEOUT_MS = 60_000
const QUEUE_SUBMIT_REQUEST_TIMEOUT_MS = 15_000

export function resolveAtomicGatewayPolicy(
  model: ModelDefinition,
  context: AtomicRequestContext
): AtomicGatewayPolicy {
  const metadata: Record<string, string> = {
    resolved_model_key: model.key,
  }
  if (context.ownerId) metadata.owner_id = context.ownerId
  if (context.correlationId) metadata.correlation_id = context.correlationId
  if (context.workflowStepId) metadata.workflow_step_id = context.workflowStepId

  return {
    metadata,
    // Every current v0.1 execution class is either a unique conversational
    // turn or a paid generation call; none is a safe, idempotent,
    // side-effect-free lookup Gateway could correctly de-duplicate by
    // request-body hash. Skip cache unconditionally until a genuinely
    // cacheable class exists, and make that an explicit opt-in then.
    skipCache: true,
    requestTimeoutMs:
      model.execution.result === "queued"
        ? QUEUE_SUBMIT_REQUEST_TIMEOUT_MS
        : IMMEDIATE_REQUEST_TIMEOUT_MS,
    retries: undefined,
  }
}

export function buildAtomicMetadata(
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

export function extractAtomicRequestId(headers: Headers) {
  return (
    headers.get("cf-aig-request-id") ??
    headers.get("x-fal-request-id") ??
    headers.get("x-request-id") ??
    undefined
  )
}

export function extractAtomicUsage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const usage = (value as Record<string, unknown>).usage
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : undefined
}

export async function readAtomicResponsePayload(
  response: Response
): Promise<AtomicImmediatePayload> {
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
        {
          retryable: false,
          status: response.status,
          requestId: extractAtomicRequestId(response.headers),
        }
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

export function classifyAtomicHttpError(status: number): {
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

export async function throwAtomicUpstreamError(response: Response): Promise<never> {
  const { code, retryable } = classifyAtomicHttpError(response.status)
  const requestId = extractAtomicRequestId(response.headers)
  let detail = ""

  try {
    detail = (await response.text()).slice(0, 1000)
  } catch {
    // Status and headers are enough to preserve the stable error classification.
  }

  throw new AtomicExecutionError(
    code,
    detail
      ? `Upstream request failed (${response.status}): ${detail}`
      : `Upstream request failed with status ${response.status}.`,
    { retryable, status: response.status, requestId }
  )
}

export function readAtomicStringField(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" && field ? field : undefined
}

export function normalizeAtomicQueueState(value: unknown) {
  const status = readAtomicStringField(value, "status")
  if (status === "IN_PROGRESS") return "running" as const
  if (status === "IN_QUEUE" || !status) return "queued" as const
  return "unknown" as const
}

export function buildProviderNativeGatewayUrl(options: {
  accountId: string
  gatewayId: string
  gatewaySegment: string
  route?: string
}) {
  const base = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(options.accountId)}/${encodeURIComponent(options.gatewayId)}/${encodeURIComponent(options.gatewaySegment)}`

  if (!options.route) return base
  assertSafeProviderRoute(options.route)
  return `${base}/${options.route}`
}

export function buildFalQueueTarget(route: string) {
  assertSafeProviderRoute(route)
  return `https://queue.fal.run/${route}`
}
