export interface GatewayModel {
  id: string
  name: string
}

export const MODELS: GatewayModel[] = [
  { id: "@cf/zai-org/glm-4.7-flash", name: "GLM 4.7 Flash" },
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "openai/gpt-5.6-terra", name: "GPT-5.6 Terra" },
]

export const DEFAULT_MODEL = MODELS[0].id

export function isModelAllowed(id: string) {
  return MODELS.some((model) => model.id === id)
}
