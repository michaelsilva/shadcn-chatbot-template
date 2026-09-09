import {
  ConversationMessageSchema,
  type ConversationMessage,
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
  const parts = message.parts.flatMap((part, index) => {
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
