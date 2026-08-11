import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createWorkersAI } from "workers-ai-provider"

const PROVIDER_AUTH_PLACEHOLDER = "binding-authenticated"

function parseProviderBody(body: BodyInit | null | undefined) {
  if (typeof body !== "string") {
    throw new Error("The AI provider request body must be JSON.")
  }

  const parsed: unknown = JSON.parse(body)

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The AI provider request body must be a JSON object.")
  }

  const inputs = { ...(parsed as Record<string, unknown>) }
  delete inputs.model

  return inputs
}

function createCloudflareFetch(
  env: CloudflareEnv,
  modelId: string
): typeof fetch {
  return async (_input, init) => {
    const response = await env.AI.run(modelId, parseProviderBody(init?.body), {
      gateway: { id: env.CLOUDFLARE_AI_GATEWAY_ID },
      returnRawResponse: true,
      ...(init?.signal ? { signal: init.signal } : {}),
    })

    return response as unknown as Response
  }
}

export function getCloudflareModel(env: CloudflareEnv, modelId: string) {
  if (modelId.startsWith("@cf/")) {
    const workersAI = createWorkersAI({
      binding: env.AI,
      gateway: { id: env.CLOUDFLARE_AI_GATEWAY_ID },
    })

    return workersAI(modelId)
  }

  const providerFetch = createCloudflareFetch(env, modelId)

  if (modelId.startsWith("anthropic/")) {
    const anthropic = createAnthropic({
      apiKey: PROVIDER_AUTH_PLACEHOLDER,
      fetch: providerFetch,
    })

    return anthropic(modelId.slice("anthropic/".length))
  }

  if (modelId.startsWith("openai/")) {
    const openai = createOpenAI({
      apiKey: PROVIDER_AUTH_PLACEHOLDER,
      fetch: providerFetch,
    })

    return openai.responses(modelId.slice("openai/".length))
  }

  throw new Error(`Unsupported AI model: ${modelId}`)
}
