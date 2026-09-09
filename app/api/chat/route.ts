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
import {
  assistantContentToConversationParts,
  chatUIMessageToConversationMessage,
} from "@/lib/conversation-adapters"
import { getCurrentOwner } from "@/lib/current-owner"
import {
  appendMessage,
  createConversation,
  getConversation,
  replaceMessageParts,
} from "@/lib/db/conversations"
import { DEFAULT_MODEL, getChatModelDefinition } from "@/lib/models"
import { getTools, type ChatUIMessage } from "@/lib/tools"
import { finalizeInlineChatExecution, recordInlineChatExecution } from "@/lib/workflows/inline"

/**
 * #29: `useChat`'s `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls`
 * (components/chat.tsx) resubmits automatically once every tool call in the
 * last *assistant* message has a result — `ask_user` included. That
 * resubmission is a continuation of an existing assistant turn, not a new
 * user turn: the message keeps the same id/role, only its tool part(s)
 * gain a `state`/`output`. A tool part still awaiting an answer never
 * reaches here because `lastAssistantMessageIsCompleteWithToolCalls` won't
 * have fired yet.
 */
function isAnsweredToolContinuation(message: ChatUIMessage) {
  if (message.role !== "assistant") return false
  return message.parts.some((part) => {
    if (!part.type.startsWith("tool-")) return false
    const state = (part as unknown as { state?: string }).state
    return state === "output-available" || state === "output-error"
  })
}

/**
 * #28: the browser is trusted only for the new turn, never as canonical
 * history. `messages` still arrives as the AI SDK's full local
 * transcript (useChat's default transport sends it — there is no
 * frontend rewrite here), but only its last message is read; all prior
 * context is reconstructed from owner-scoped D1 state via
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
  const isContinuation = Boolean(lastMessage && isAnsweredToolContinuation(lastMessage))
  if (!lastMessage || (!isContinuation && lastMessage.role !== "user")) {
    return Response.json(
      { error: "Request must include a new user message or an answered tool continuation." },
      { status: 400 }
    )
  }

  const { env } = await getCloudflareContext({ async: true })
  const owner = await getCurrentOwner(env)

  const conversationId = requestedConversationId ?? crypto.randomUUID()
  const existingConversation = await getConversation(env, { ownerId: owner.id, conversationId })
  if (!existingConversation) {
    await createConversation(env, { id: conversationId, ownerId: owner.id })
  }

  if (isContinuation) {
    // #29: never trust a client-crafted historical tool result on its own —
    // replaceMessageParts() only updates a message that already exists in
    // *this* conversation, so a forged/unknown message id is a no-op, not
    // an accepted write.
    const convertedContinuation = chatUIMessageToConversationMessage(lastMessage)
    const replaced = await replaceMessageParts(env, {
      conversationId,
      messageId: lastMessage.id,
      parts: convertedContinuation.parts,
    })
    if (!replaced) {
      return Response.json({ error: "Unknown tool continuation." }, { status: 422 })
    }
  } else {
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
  }

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
    tools: supportsTools ? getTools(modelDefinition) : undefined,
    stopWhen: isStepCount(5),
    onFinish: async ({ content }) => {
      // #29: persist the full assistant turn — text *and* tool calls
      // (e.g. ask_user's, which has no server-side `execute` and so
      // pauses here with no matching tool-result yet) — not just final
      // text. This is what makes an ask_user continuation reconstructable
      // from D1 instead of only from the browser's local state.
      const assistantMessageId = crypto.randomUUID()
      const parts = assistantContentToConversationParts(assistantMessageId, content)
      if (parts.length) {
        await appendMessage(env, {
          conversationId,
          role: "assistant",
          id: assistantMessageId,
          parts,
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
