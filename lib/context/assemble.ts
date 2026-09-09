import type { ConversationMessage, ConversationPart, TranscriptPart } from "../conversation"
import { getAsset, isAssetUsable } from "../db/assets"
import { getConversationMessages } from "../db/conversations"
import type { LedgerEnv } from "../db/env"
import { getModelDefinition } from "../models"
import { createDownloadUrl } from "../storage/downloads"
import { requireStorageEnv, type UnconfiguredStorageEnv } from "../storage/env"
import { describePartAsText, estimateTokens, projectHistoricalPart } from "./project"
import type {
  AssembleContextResult,
  ContextBudgetMetadata,
  ExplicitSourceOutcome,
  PortableContentPart,
  PortableMessage,
} from "./types"

/**
 * #28's server-owned context assembler. Reads owner-scoped canonical
 * conversation state from D1 (#6) and builds a bounded,
 * capability-projected context for exactly one atomic model
 * invocation (#3). The caller passes ids/keys only — there is no
 * parameter through which a client could inject fabricated history;
 * every message in the returned context was read from D1.
 */
export interface AssembleContextInput {
  ownerId: string
  conversationId: string
  modelKey: string
  bucketName: string
  /** Asset ids the current turn explicitly references (#27's "use as reference") — never inferred from mere history. */
  explicitSourceAssetIds?: readonly string[]
}

type Env = LedgerEnv & UnconfiguredStorageEnv

const DEFAULT_CONTEXT_TOKEN_LIMIT = 32_000
const RESERVED_OUTPUT_TOKENS_FLOOR = 1024
const RESERVED_OUTPUT_FRACTION = 0.25

function toPortableRole(role: ConversationMessage["role"]): PortableMessage["role"] {
  return role === "system" ? "system" : role === "assistant" ? "assistant" : "user"
}

function findTranscriptForAsset(
  messages: readonly ConversationMessage[],
  assetId: string
): TranscriptPart | undefined {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "transcript" && part.sourceAssetId === assetId) return part
    }
  }
  return undefined
}

function partAssetId(part: ConversationPart): string | undefined {
  switch (part.type) {
    case "image":
    case "audio":
    case "video":
    case "model3d":
    case "file":
      return part.asset.assetId
    default:
      return undefined
  }
}

async function projectExplicitSource(
  env: Env,
  input: { ownerId: string; assetId: string; bucketName: string; modelInputs: readonly string[] },
  messages: readonly ConversationMessage[]
): Promise<{ outcome: ExplicitSourceOutcome; contentPart?: PortableContentPart }> {
  const asset = await getAsset(env, { ownerId: input.ownerId, assetId: input.assetId })
  if (!asset) {
    return { outcome: { assetId: input.assetId, outcome: "unauthorized", reason: "Asset not found or not owned by this owner." } }
  }
  if (!isAssetUsable(asset)) {
    return {
      outcome: {
        assetId: input.assetId,
        outcome: "unavailable",
        reason: `Asset is not usable (upload_state: ${asset.upload_state}).`,
      },
    }
  }

  if (asset.artifact_kind === "image") {
    if (!input.modelInputs.includes("image")) {
      return {
        outcome: {
          assetId: input.assetId,
          outcome: "incompatible-capability",
          reason: "Selected model does not accept image input.",
        },
      }
    }
    let downloadUrl: string
    try {
      const storageEnv = requireStorageEnv(env)
      const download = await createDownloadUrl(storageEnv, {
        ownerId: input.ownerId,
        assetId: input.assetId,
        bucketName: input.bucketName,
      })
      if (download.outcome !== "ok") {
        return {
          outcome: {
            assetId: input.assetId,
            outcome: "unavailable",
            reason: `Could not authorize a download (${download.outcome}).`,
          },
        }
      }
      downloadUrl = download.url
    } catch (error) {
      return {
        outcome: {
          assetId: input.assetId,
          outcome: "unavailable",
          reason: error instanceof Error ? error.message : "Storage is not configured.",
        },
      }
    }
    return {
      outcome: { assetId: input.assetId, outcome: "included" },
      contentPart: { type: "file", url: downloadUrl, mediaType: asset.mime_type ?? "image/png" },
    }
  }

  // Audio/video/file/3D: never sent as raw bytes through this generic
  // path (#28) — only an existing transcript, or a plain textual
  // reference when none exists yet.
  const transcript = findTranscriptForAsset(messages, input.assetId)
  if (transcript) {
    return {
      outcome: { assetId: input.assetId, outcome: "included" },
      contentPart: { type: "text", text: `[Referenced ${asset.artifact_kind} transcript]: ${transcript.text}` },
    }
  }
  return {
    outcome: { assetId: input.assetId, outcome: "included", reason: "No transcript/extraction available; referenced by id only." },
    contentPart: {
      type: "text",
      text: `[User referenced a ${asset.artifact_kind} asset (${asset.id}) with no available transcript/extraction yet.]`,
    },
  }
}

export async function assembleModelContext(
  env: Env,
  input: AssembleContextInput
): Promise<AssembleContextResult> {
  const model = getModelDefinition(input.modelKey)
  if (!model) {
    return { ok: false, reason: `Unknown or disabled model "${input.modelKey}".` }
  }

  const contextTokenLimit = model.limits?.contextTokens ?? DEFAULT_CONTEXT_TOKEN_LIMIT
  const reservedOutput = Math.max(
    RESERVED_OUTPUT_TOKENS_FLOOR,
    Math.min(model.limits?.maxOutputTokens ?? RESERVED_OUTPUT_TOKENS_FLOOR, Math.round(contextTokenLimit * RESERVED_OUTPUT_FRACTION))
  )
  const historyBudgetTokens = Math.max(0, contextTokenLimit - reservedOutput)

  const messages = await getConversationMessages(env, input.conversationId)
  if (messages.length === 0) {
    return { ok: false, reason: "Conversation has no messages to assemble context from." }
  }

  const currentTurn = messages[messages.length - 1]!
  const history = messages.slice(0, -1)

  const explicitSourceIds = input.explicitSourceAssetIds ?? []
  const explicitSourceOutcomes: ExplicitSourceOutcome[] = []
  const explicitContentByAssetId = new Map<string, PortableContentPart>()
  for (const assetId of explicitSourceIds) {
    const { outcome, contentPart } = await projectExplicitSource(
      env,
      { ownerId: input.ownerId, assetId, bucketName: input.bucketName, modelInputs: model.inputs },
      messages
    )
    explicitSourceOutcomes.push(outcome)
    if (contentPart) explicitContentByAssetId.set(assetId, contentPart)
  }

  // Required: the current turn, in full — text verbatim, any part that
  // is an authorized explicit source gets its real projection, anything
  // else historical-shaped on this same turn is still just described.
  const currentTurnParts: PortableContentPart[] = []
  const consumedExplicitIds = new Set<string>()
  for (const part of currentTurn.parts) {
    if (part.type === "text") {
      currentTurnParts.push({ type: "text", text: part.text })
      continue
    }
    const assetId = partAssetId(part)
    if (assetId && explicitContentByAssetId.has(assetId)) {
      currentTurnParts.push(explicitContentByAssetId.get(assetId)!)
      consumedExplicitIds.add(assetId)
      continue
    }
    const text = describePartAsText(part)
    if (text) currentTurnParts.push({ type: "text", text })
  }
  // An explicit source not physically attached to the current turn's
  // parts (referenced by id from the request, e.g. "use this earlier
  // image") is still required content.
  for (const [assetId, contentPart] of explicitContentByAssetId) {
    if (!consumedExplicitIds.has(assetId)) currentTurnParts.push(contentPart)
  }

  if (currentTurnParts.length === 0) {
    return { ok: false, reason: "Current turn has no content to send to the model." }
  }

  const requiredMessage: PortableMessage = { role: toPortableRole(currentTurn.role), content: currentTurnParts }
  const requiredTokens = estimateTokens(
    currentTurnParts
      .filter((p): p is Extract<PortableContentPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n")
  )

  if (requiredTokens > historyBudgetTokens) {
    return {
      ok: false,
      reason: `The current turn (~${requiredTokens} estimated tokens) alone exceeds "${model.key}"'s available context budget (~${historyBudgetTokens} tokens after reserving output). Choose a workflow/model with more headroom rather than truncating required content.`,
    }
  }

  // Deterministic oldest-first trimming: walk history newest-to-oldest,
  // keeping whatever fits; once one message no longer fits, everything
  // older than it is omitted too (#28's documented v0.1 policy).
  const includedHistory: PortableMessage[] = []
  let remainingBudget = historyBudgetTokens - requiredTokens
  let consideredCount = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!
    const parts = message.parts
      .map(projectHistoricalPart)
      .filter((part): part is PortableContentPart => part !== null)
    if (parts.length === 0) continue
    consideredCount++

    const text = parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")
    const tokens = estimateTokens(text)
    if (tokens > remainingBudget) break

    includedHistory.unshift({ role: toPortableRole(message.role), content: parts })
    remainingBudget -= tokens
  }

  const includedTokens = historyBudgetTokens - requiredTokens - remainingBudget
  const budget: ContextBudgetMetadata = {
    contextTokenLimit,
    historyBudgetTokens,
    estimatedInputTokens: requiredTokens + includedTokens,
    consideredMessageCount: consideredCount,
    includedMessageCount: includedHistory.length,
    omittedMessageCount: consideredCount - includedHistory.length,
    truncated: consideredCount > includedHistory.length,
  }

  return {
    ok: true,
    messages: [...includedHistory, requiredMessage],
    budget,
    explicitSources: explicitSourceOutcomes,
  }
}
