import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
} from "ai"

import { getAtomicLanguageModel } from "@/lib/atomic-executor"
import { DEFAULT_MODEL, getChatModelDefinition } from "@/lib/models"
import { getTools, type ChatUIMessage } from "@/lib/tools"

export async function POST(req: Request) {
  const { messages, model }: { messages: ChatUIMessage[]; model?: string } =
    await req.json()

  const modelKey = model ?? DEFAULT_MODEL
  const modelDefinition = getChatModelDefinition(modelKey)

  if (!modelDefinition) {
    return Response.json(
      { error: `Model ${modelKey} is not available for chat.` },
      { status: 400 }
    )
  }

  const { env } = await getCloudflareContext({ async: true })
  const upstreamModelId = modelDefinition.upstreamModelId
  const supportsTools = modelDefinition.capabilities.includes("tool-calling")

  const result = streamText({
    model: getAtomicLanguageModel(env, modelKey),
    messages: await convertToModelMessages(messages),
    tools: supportsTools ? getTools(upstreamModelId) : undefined,
    stopWhen: isStepCount(5),
  })

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      sendSources: true,
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(
          JSON.stringify({
            event: "atomic_ai_request_failed",
            message,
            model: modelKey,
            upstreamModel: upstreamModelId,
            transport: modelDefinition.transport,
            protocol: modelDefinition.protocol,
          })
        )

        if (message === "Payment Required") {
          return "This model requires Cloudflare AI Gateway credits. Choose GLM 4.7 Flash or add credits to the Cloudflare account."
        }

        return "Cloudflare AI Gateway could not complete the request. Please try again."
      },
    }),
  })
}
