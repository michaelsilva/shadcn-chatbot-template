import { assertNever, type ConversationPart, type JsonValue, type ToolPart } from "../conversation"
import type { PortableContentPart } from "./types"

/**
 * A documented, deliberately approximate heuristic (~4 characters per
 * token) — not a real tokenizer. Good enough for a conservative history
 * budget; #28 explicitly scopes out building/depending on a precise
 * per-model tokenizer for v0.1.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function describeAssetRole(kind: string, role?: string): string {
  return role ? `${role} ${kind}` : kind
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined
}

/**
 * #29: a generic `[Tool X succeeded]` description is fine for a
 * read-only lookup, but `ask_user`'s whole point is the questions it
 * asked and the answers the user gave — losing that in history/current-
 * turn projection would make a resumed conversation incoherent, not
 * merely terser. Falls back to the generic description if the input/
 * output don't match `ask_user`'s known shape (e.g. an in-flight
 * `input-ready` state with no answer yet).
 */
function describeAskUserTool(part: ToolPart): string | undefined {
  const questions = asRecord(part.input)?.questions
  if (!Array.isArray(questions) || questions.length === 0) return undefined

  const questionTexts = questions
    .map((entry) => asRecord(entry)?.question)
    .filter((question): question is string => typeof question === "string")
  if (questionTexts.length !== questions.length) return undefined

  if (part.state === "succeeded" && Array.isArray(part.output)) {
    const answers = new Map(
      part.output
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, JsonValue> => Boolean(entry))
        .map((entry) => [entry.question, entry.answer])
    )
    const pairs = questionTexts.map(
      (question) => `"${question}" → "${String(answers.get(question) ?? "(no answer)")}"`
    )
    return `[Asked the user and got an answer: ${pairs.join("; ")}]`
  }

  if (part.state === "failed") {
    return `[Asked the user (${questionTexts.map((q) => `"${q}"`).join(", ")}) but did not get an answer${part.error ? `: ${part.error.message}` : ""}]`
  }

  return `[Asked the user: ${questionTexts.map((q) => `"${q}"`).join(", ")} — awaiting answer]`
}

/**
 * Compact, portable, textual description of one canonical part —
 * "the historical event happened", never the bytes. Used for every
 * non-current-turn message (#28: "do not fail a text-only model merely
 * because an image appeared 40 turns ago") and as the fallback when an
 * explicit current source can't be projected as real content either.
 *
 * Returns `null` for parts that carry no context-relevant meaning on
 * their own (provenance/identity references) — #28's context audit
 * doctrine is metadata, not a second copy of content, and provenance
 * parts exist for that audit trail, not for the model to read.
 */
export function describePartAsText(part: ConversationPart): string | null {
  switch (part.type) {
    case "text":
      return part.text
    case "image":
      return `[${part.role === "input" ? "User" : "Assistant"} ${describeAssetRole(
        part.representation === "svg" ? "SVG image" : "image",
        undefined
      )}${part.alt ? `: ${part.alt}` : ""}]`
    case "audio":
      return `[${part.role === "input" ? "User" : "Assistant"} audio (${part.role})]`
    case "video":
      return `[${part.role === "input" ? "User" : "Assistant"} video]`
    case "model3d":
      return `[${part.role === "input" ? "User" : "Assistant"} 3D asset]`
    case "file":
      return `[File attached: ${part.asset.fileName ?? part.asset.assetId} (${part.purpose})]`
    case "derived-media":
      return `[Derived media: ${part.operation}]`
    case "transcript":
      return part.text ? `[Transcript]: ${part.text}` : null
    case "source":
      return `[Source: ${part.title ?? part.url}]`
    case "tool": {
      if (part.toolName === "ask_user") {
        const described = describeAskUserTool(part)
        if (described) return described
      }
      const outcome =
        part.state === "succeeded"
          ? "succeeded"
          : part.state === "failed"
            ? `failed${part.error ? `: ${part.error.message}` : ""}`
            : part.state
      return `[Tool ${part.toolName} ${outcome}]`
    }
    case "generation":
      return `[Generation job (${part.operation}): ${part.state}${part.error ? ` — ${part.error.message}` : ""}]`
    case "error":
      return `[Error: ${part.message}]`
    case "provenance":
    case "identity":
      return null
    default:
      return assertNever(part)
  }
}

/** Historical (non-current-turn) parts are always projected as text — never resent media. */
export function projectHistoricalPart(part: ConversationPart): PortableContentPart | null {
  const text = describePartAsText(part)
  return text ? { type: "text", text } : null
}
