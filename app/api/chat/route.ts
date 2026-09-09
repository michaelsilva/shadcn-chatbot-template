import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
} from "ai"

import { getAtomicLanguageModel } from "@/lib/atomic-executor"
import { assembleModelContext } from "@/lib/context/assemble"
import { toModelMessages } from "@/lib/context/to-model-messages"
import { chatUIMessageToConversationMessage } from "@/lib/conversation-adapters"
import { getCurrentOwner } from "@/lib/current-owner"
import { appendMessage, createConversation, getConversation } from "@/lib/db/conversations"
import { DEFAULT_MODEL, getChatModelDefinition } from "@/lib/models"
import { getTools, type ChatUIMessage } from "@/lib/tools"
import { finalizeInlineChatExecution, recordInlineChatExecution } from "@/lib/workflows/inline"

/**
 * #28: the browser is trusted only for the new turn, never as canonical
 * history. `messages` still arrives as the AI SDK's full local
 * transcript (useChat's default transport sends it — there is no
 * frontend rewrite here), but only its last (new) message is read; all
 * prior context is reconstructed from owner-scoped D1 state via
 * assembleModelContext(), not from anything the browser sent.
 */
export async function POST(req: Request) {
  const {
    messages,
    model,
    conversationId: requestedConversationId,
  }: { messages: ChatUIMessage[]; model?: string; conversationId?: string } = await req.json()

  const modelKey = model ?? DEFAULT_MODEL
  const modelDefinition = getChatModelDefinition(modelKey)

  if (!modelDefinition) {
    return Response.json(
      { error: `Model ${modelKey} is not available for chat.` },
      { status: 400 }
    )
  }

  const lastMessage = messages.at(-1)
  if (!lastMessage || lastMessage.role !== "user") {
    return Response.json({ error: "Request must include a new user message." }, { status: 400 })
  }

  const { env } = await getCloudflareContext({ async: true })
  const owner = await getCurrentOwner(env)

  const conversationId = requestedConversationId ?? crypto.randomUUID()
  const existingConversation = await getConversation(env, { ownerId: owner.id, conversationId })
  if (!existingConversation) {
    await createConversation(env, { id: conversationId, ownerId: owner.id })
  }

  // The client-supplied message/part ids (from useChat's local state) are
  // never trusted as durable identity — D1's message_parts.id is a global
  // primary key, and a resent/retried request carrying the same client id
  // must not collide with an already-persisted part.
  const convertedUserMessage = chatUIMessageToConversationMessage(lastMessage)
  await appendMessage(env, {
    conversationId,
    role: "user",
    parts: convertedUserMessage.parts.map((part) => ({ ...part, id: crypto.randomUUID() })),
  })

  // #24: inline execution class still writes canonical D1
  // workflow/provenance state — "inline" means no durable Cloudflare
  // Workflow instance, not untracked.
  const execution = await recordInlineChatExecution(env, {
    ownerId: owner.id,
    conversationId,
    requestedModelKey: modelKey,
  })
  const finalizeExecution = (state: "succeeded" | "failed") =>
    finalizeInlineChatExecution(env, { executionId: execution.id, state }).catch((error) => {
      console.error(
        JSON.stringify({ event: "inline_execution_finalize_failed", executionId: execution.id, error: String(error) })
      )
    })

  const assembled = await assembleModelContext(env, {
    ownerId: owner.id,
    conversationId,
    modelKey,
    bucketName: env.ASSETS_BUCKET_NAME,
  })
  if (!assembled.ok) {
    await finalizeExecution("failed")
    return Response.json({ error: assembled.reason }, { status: 422 })
  }

  const upstreamModelId = modelDefinition.upstreamModelId
  const supportsTools = modelDefinition.capabilities.includes("tool-calling")

  const result = streamText({
    model: getAtomicLanguageModel(env, modelKey, {
      ownerId: owner.id,
      correlationId: execution.id,
    }),
    messages: toModelMessages(assembled.messages),
    tools: supportsTools ? getTools(upstreamModelId) : undefined,
    stopWhen: isStepCount(5),
    onFinish: async ({ text }) => {
      // Tool-call/result persistence for the assistant turn is a known
      // follow-on refinement, not required for #28's context-assembly
      // acceptance criteria — the portable ToolPart shape to persist
      // them into already exists (#4).
      if (text) {
        await appendMessage(env, {
          conversationId,
          role: "assistant",
          parts: [{ id: crypto.randomUUID(), type: "text", text, state: "complete" }],
        }).catch((error) => {
          console.error(
            JSON.stringify({ event: "assistant_message_persist_failed", conversationId, error: String(error) })
          )
        })
      }
      await finalizeExecution("succeeded")
    },
    onError: () => finalizeExecution("failed"),
  })

  const response = createUIMessageStreamResponse({
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
  response.headers.set("X-Conversation-Id", conversationId)
  return response
}
