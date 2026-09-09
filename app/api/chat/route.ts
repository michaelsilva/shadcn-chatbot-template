import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
} from "ai"

import { getCloudflareModel } from "@/lib/ai"
import { DEFAULT_MODEL, getModelDefinition } from "@/lib/models"
import { getTools, type ChatUIMessage } from "@/lib/tools"

export async function POST(req: Request) {
  const { messages, model }: { messages: ChatUIMessage[]; model?: string } =
    await req.json()

  const modelKey = model ?? DEFAULT_MODEL
  const modelDefinition = getModelDefinition(modelKey)

  if (!modelDefinition) {
    return Response.json(
      { error: `Model ${modelKey} is not available.` },
      { status: 400 }
    )
  }

  const { env } = await getCloudflareContext({ async: true })
  const upstreamModelId = modelDefinition.upstreamModelId

  const result = streamText({
    model: getCloudflareModel(env, upstreamModelId),
    messages: await convertToModelMessages(messages),
    tools: getTools(upstreamModelId),
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
            event: "ai_gateway_request_failed",
            message,
            model: modelKey,
            upstreamModel: upstreamModelId,
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
