import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
} from "ai"

import { getAtomicLanguageModel } from "@/lib/atomic-executor"
import { getCurrentOwner } from "@/lib/current-owner"
import { DEFAULT_MODEL, getChatModelDefinition } from "@/lib/models"
import { getTools, type ChatUIMessage } from "@/lib/tools"
import { finalizeInlineChatExecution, recordInlineChatExecution } from "@/lib/workflows/inline"

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

  // #24: inline execution class still writes canonical D1
  // workflow/provenance state — "inline" means no durable Cloudflare
  // Workflow instance, not untracked. Full conversation/message
  // persistence for chat remains #28's job.
  const owner = await getCurrentOwner(env)
  const execution = await recordInlineChatExecution(env, {
    ownerId: owner.id,
    requestedModelKey: modelKey,
  })
  const finalizeExecution = (state: "succeeded" | "failed") =>
    finalizeInlineChatExecution(env, { executionId: execution.id, state }).catch((error) => {
      console.error(
        JSON.stringify({ event: "inline_execution_finalize_failed", executionId: execution.id, error: String(error) })
      )
    })

  const result = streamText({
    model: getAtomicLanguageModel(env, modelKey, {
      ownerId: owner.id,
      correlationId: execution.id,
    }),
    messages: await convertToModelMessages(messages),
    tools: supportsTools ? getTools(upstreamModelId) : undefined,
    stopWhen: isStepCount(5),
    onFinish: () => finalizeExecution("succeeded"),
    onError: () => finalizeExecution("failed"),
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
