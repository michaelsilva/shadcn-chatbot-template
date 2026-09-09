import {
  filterModelCatalog,
  findEnabledCatalogModel,
  type ModelDefinition,
  type ModelProtocol,
  type ModelQuery,
} from "@/lib/model-catalog"
import {
  LAUNCH_MODEL_CATALOG,
  MODEL_CATALOG,
  WORKERS_AI_LAUNCH_MODEL_KEYS,
} from "@/lib/model-catalog-data"

export {
  LAUNCH_MODEL_CATALOG,
  MODEL_CATALOG,
  WORKERS_AI_LAUNCH_MODEL_KEYS,
}

export interface GatewayModel {
  /** Stable application-facing model key. */
  id: string
  name: string
}

const ATOMIC_CHAT_PROTOCOLS = new Set<ModelProtocol>([
  "workers-ai",
  "responses",
  "messages",
  "chat-completions",
])

function isAtomicChatModel(model: ModelDefinition) {
  return (
    (model.lifecycle === "launch" || model.lifecycle === "legacy") &&
    model.capabilities.includes("chat") &&
    model.inputs.includes("text") &&
    model.outputs.includes("text") &&
    ATOMIC_CHAT_PROTOCOLS.has(model.protocol)
  )
}

/**
 * Text-chat projection backed by the atomic executor. Media models remain in
 * MODEL_CATALOG and are selected by workflow/capability code rather than this
 * compatibility picker.
 */
export const MODELS: GatewayModel[] = MODEL_CATALOG.filter(isAtomicChatModel).map(
  (model) => ({ id: model.key, name: model.name })
)

const PREFERRED_DEFAULT_MODEL = "@cf/zai-org/glm-5.3-flash"
const defaultModel = MODELS.find(
  (model) => model.id === PREFERRED_DEFAULT_MODEL
)

if (!defaultModel) {
  throw new Error(
    `Preferred default model ${PREFERRED_DEFAULT_MODEL} is not available to the atomic chat executor.`
  )
}

export const DEFAULT_MODEL = defaultModel.id

/** Resolve any enabled catalog entry for workflow/executor code. */
export function getModelDefinition(key: string) {
  return findEnabledCatalogModel(MODEL_CATALOG, key)
}

/** Resolve only models that the streaming text-chat surface can execute. */
export function getChatModelDefinition(key: string) {
  const model = getModelDefinition(key)
  return model && isAtomicChatModel(model) ? model : undefined
}

export function isModelAllowed(key: string) {
  return Boolean(getChatModelDefinition(key))
}

export function queryModelCatalog(query: ModelQuery) {
  return filterModelCatalog(MODEL_CATALOG, query)
}
