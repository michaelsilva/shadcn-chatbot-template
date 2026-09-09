import {
  ConversationMessageSchema,
  type ConversationMessage,
  type ConversationPart,
  type JsonValue,
  type ToolPart,
} from "./conversation"
import type { ChatUIMessage } from "./tools"

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined

  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return undefined
    return JSON.parse(serialized) as JsonValue
  } catch {
    return undefined
  }
}

function canonicalPartId(messageId: string, index: number) {
  return `${messageId}:part:${index}`
}

function canonicalToolState(state: unknown): ToolPart["state"] {
  if (state === "output-available") return "succeeded"
  if (state === "output-error") return "failed"
  if (state === "input-available") return "input-ready"
  if (state === "input-streaming") return "requested"
  if (state === "approval-requested" || state === "approval-responded") {
    return "running"
  }
  return "running"
}

function mapToolPart(
  messageId: string,
  index: number,
  part: ChatUIMessage["parts"][number]
): ToolPart | undefined {
  if (!part.type.startsWith("tool-")) return undefined

  const raw = part as unknown as Record<string, unknown>
  const toolCallId =
    typeof raw.toolCallId === "string"
      ? raw.toolCallId
      : `${messageId}:tool:${index}`
  const errorText =
    typeof raw.errorText === "string" && raw.errorText
      ? raw.errorText
      : undefined

  return {
    id: canonicalPartId(messageId, index),
    type: "tool",
    toolName: part.type.slice("tool-".length),
    toolCallId,
    state: canonicalToolState(raw.state),
    input: toJsonValue(raw.input),
    output: toJsonValue(raw.output),
    error: errorText ? { message: errorText } : undefined,
  }
}

/**
 * Normalize the starter's live Vercel UIMessage into the durable application
 * conversation contract. This is intentionally one-way: provider/UI SDK shapes
 * are transport state, while ConversationMessage is persistence state.
 */
export function chatUIMessageToConversationMessage(
  message: ChatUIMessage
): ConversationMessage {
  const parts = message.parts.flatMap((part, index): ConversationPart[] => {
    const id = canonicalPartId(message.id, index)

    if (part.type === "text") {
      return [
        {
          id,
          type: "text" as const,
          text: part.text,
          state: "complete" as const,
        },
      ]
    }

    if (part.type === "source-url") {
      return [
        {
          id,
          type: "source" as const,
          sourceId: part.sourceId,
          url: part.url,
          title: part.title,
        },
      ]
    }

    const tool = mapToolPart(message.id, index, part)
    return tool ? [tool] : []
  })

  return ConversationMessageSchema.parse({
    id: message.id,
    role: message.role,
    parts,
  })
}

/**
 * The minimal shape this module needs from `streamText()`'s `onFinish`
 * `content` array (AI SDK core generation content, distinct from the UI
 * message parts `chatUIMessageToConversationMessage()` reads). Declared
 * structurally rather than importing the SDK's generic `ContentPart<TOOLS>`
 * so this adapter doesn't need to be parameterized by the app's tool set.
 */
export interface AssistantContentItem {
  type: string
  text?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  error?: unknown
}

/**
 * #29: `ask_user` (and any other tool without a server-side `execute`)
 * produces a `tool-call` content item with no matching `tool-result` in
 * the same request — the model is pausing for a client-supplied answer,
 * not failing. Persisting this turn (rather than only final text, #28's
 * deferred non-goal) is what lets a resubmitted continuation be
 * reconstructed from D1 instead of only from the browser's local state.
 *
 * A `tool-call`/`tool-result` (or `tool-error`) pair sharing the same
 * `toolCallId` collapses into one `ToolPart`, matching one tool
 * invocation's full lifecycle rather than two separate history entries.
 */
export function assistantContentToConversationParts(
  messageId: string,
  content: readonly AssistantContentItem[]
): ConversationPart[] {
  const parts: ConversationPart[] = []
  const toolPartIndexByCallId = new Map<string, number>()

  for (const item of content) {
    if (item.type === "text") {
      if (!item.text) continue
      parts.push({
        id: canonicalPartId(messageId, parts.length),
        type: "text",
        text: item.text,
        state: "complete",
      })
      continue
    }

    if (item.type === "tool-call" && item.toolCallId && item.toolName) {
      toolPartIndexByCallId.set(item.toolCallId, parts.length)
      parts.push({
        id: canonicalPartId(messageId, parts.length),
        type: "tool",
        toolName: item.toolName,
        toolCallId: item.toolCallId,
        state: "input-ready",
        input: toJsonValue(item.input),
      })
      continue
    }

    if (
      (item.type === "tool-result" || item.type === "tool-error") &&
      item.toolCallId
    ) {
      const index = toolPartIndexByCallId.get(item.toolCallId)
      if (index === undefined) continue
      const existing = parts[index] as ToolPart

      parts[index] =
        item.type === "tool-result"
          ? { ...existing, state: "succeeded", output: toJsonValue(item.output) }
          : {
              ...existing,
              state: "failed",
              error: { message: item.error ? String(item.error) : "Tool execution failed." },
            }
    }
  }

  return parts
}
