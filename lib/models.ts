import {
  assertValidModelCatalog,
  filterModelCatalog,
  findEnabledCatalogModel,
  isServerEnabledModel,
  type ModelDefinition,
  type ModelQuery,
} from "@/lib/model-catalog"

export interface GatewayModel {
  /** Stable application-facing model key. */
  id: string
  name: string
}

export const MODEL_CATALOG = assertValidModelCatalog([
  {
    key: "@cf/zai-org/glm-4.7-flash",
    upstreamModelId: "@cf/zai-org/glm-4.7-flash",
    name: "GLM 4.7 Flash",
    provider: "zai-org",
    catalogSource: "workers-ai",
    transport: "workers-binding",
    protocol: "workers-ai",
    lifecycle: "legacy",
    roles: ["fast", "value", "workers-hosted"],
    inputs: ["text"],
    outputs: ["text"],
    capabilities: ["chat", "tool-calling"],
    representations: [{ artifact: "text", format: "markdown" }],
    execution: { result: "immediate", streaming: true },
    tools: { appTools: true },
    billingClass: "value",
    accessClass: "public",
    zeroDataRetention: "unknown",
    verification: {
      lastVerifiedAt: "2026-09-09",
      docs: [],
    },
  },
  {
    key: "anthropic/claude-sonnet-5",
    upstreamModelId: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "anthropic",
    catalogSource: "unified",
    transport: "unified-run",
    protocol: "messages",
    lifecycle: "launch",
    roles: ["balanced"],
    inputs: ["text"],
    outputs: ["text"],
    capabilities: ["chat", "tool-calling"],
    representations: [{ artifact: "text", format: "markdown" }],
    execution: { result: "immediate", streaming: true },
    tools: { appTools: true, nativeTools: ["web-search"] },
    billingClass: "standard",
    accessClass: "credential-required",
    zeroDataRetention: "unknown",
    verification: {
      lastVerifiedAt: "2026-09-09",
      docs: [],
    },
  },
  {
    key: "openai/gpt-5.6-terra",
    upstreamModelId: "openai/gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "openai",
    catalogSource: "unified",
    transport: "unified-run",
    protocol: "responses",
    lifecycle: "launch",
    roles: ["balanced"],
    inputs: ["text"],
    outputs: ["text"],
    capabilities: ["chat", "tool-calling"],
    representations: [{ artifact: "text", format: "markdown" }],
    execution: { result: "immediate", streaming: true },
    tools: { appTools: true, nativeTools: ["web-search"] },
    billingClass: "standard",
    accessClass: "credential-required",
    zeroDataRetention: "unknown",
    verification: {
      lastVerifiedAt: "2026-09-09",
      docs: [],
    },
  },
] as const satisfies readonly ModelDefinition[])

/**
 * Compatibility projection for the current text-chat UI.
 * #5 will replace this minimal shape with workflow-aware public metadata.
 */
export const MODELS: GatewayModel[] = MODEL_CATALOG.filter(
  isServerEnabledModel
).map((model) => ({ id: model.key, name: model.name }))

export const DEFAULT_MODEL = MODELS[0].id

export function getModelDefinition(key: string) {
  return findEnabledCatalogModel(MODEL_CATALOG, key)
}

export function isModelAllowed(key: string) {
  return Boolean(getModelDefinition(key))
}

export function queryModelCatalog(query: ModelQuery) {
  return filterModelCatalog(MODEL_CATALOG, query)
}
