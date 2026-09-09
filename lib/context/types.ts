/**
 * #28's portable model-context representation. This is deliberately
 * close to the AI SDK's `ModelMessage` shape (role + text-or-parts
 * content) so protocol adapters (#3) can consume it directly, but it
 * is our own type: canonical D1 conversation state (#4/#6) is the
 * permanent record, this is a temporary, capability-projected view of
 * it for exactly one atomic model invocation.
 */

export type PortableContentPart =
  | { type: "text"; text: string }
  // Matches the AI SDK's current (non-deprecated) `FilePart` shape —
  // `image`/`ImagePart` is deprecated in favor of `file` + `mediaType`.
  | { type: "file"; url: string; mediaType: string }

export interface PortableMessage {
  role: "system" | "user" | "assistant"
  content: string | PortableContentPart[]
}

export interface ExplicitSourceOutcome {
  assetId: string
  outcome: "included" | "unauthorized" | "incompatible-capability" | "unavailable"
  reason?: string
}

export interface ContextBudgetMetadata {
  contextTokenLimit: number
  historyBudgetTokens: number
  estimatedInputTokens: number
  consideredMessageCount: number
  includedMessageCount: number
  omittedMessageCount: number
  truncated: boolean
}

export type AssembleContextResult =
  | {
      ok: true
      messages: PortableMessage[]
      budget: ContextBudgetMetadata
      explicitSources: ExplicitSourceOutcome[]
    }
  | { ok: false; reason: string }
