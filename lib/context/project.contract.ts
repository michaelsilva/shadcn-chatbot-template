import { estimateTokens, describePartAsText, projectHistoricalPart } from "./project"
import type { ConversationPart } from "../conversation"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function runProjectContractChecks() {
  assert(estimateTokens("") === 0, "empty text estimates to zero tokens")
  assert(estimateTokens("abcd") === 1, "four characters estimate to one token")
  assert(estimateTokens("a".repeat(401)) === 101, "token estimate scales with length")

  const textPart: ConversationPart = { id: "p1", type: "text", text: "hello", state: "complete" }
  assert(describePartAsText(textPart) === "hello", "text parts project verbatim")

  const imagePart: ConversationPart = {
    id: "p2",
    type: "image",
    role: "output",
    representation: "raster",
    asset: { assetId: "a1", kind: "image", mimeType: "image/png" },
  }
  const imageDescription = describePartAsText(imagePart)
  assert(
    typeof imageDescription === "string" && !imageDescription.includes("a1"),
    "a historical image is described textually, never carrying a resendable byte reference"
  )
  assert(imageDescription!.toLowerCase().includes("assistant"), "role is reflected in the description")

  const provenancePart: ConversationPart = {
    id: "p3",
    type: "provenance",
    value: { executionId: "exec_1" },
  }
  assert(
    describePartAsText(provenancePart) === null,
    "provenance carries no independent context-relevant meaning"
  )
  assert(
    projectHistoricalPart(provenancePart) === null,
    "a part with no textual description projects to nothing, not an empty note"
  )

  const toolPart: ConversationPart = {
    id: "p4",
    type: "tool",
    toolName: "github_repo",
    toolCallId: "call_1",
    state: "succeeded",
  }
  assert(
    describePartAsText(toolPart)!.includes("github_repo") &&
      describePartAsText(toolPart)!.includes("succeeded"),
    "tool history is a compact portable summary, not the provider tool-call protocol shape"
  )

  const errorPart: ConversationPart = {
    id: "p5",
    type: "error",
    code: "UPSTREAM_TIMEOUT",
    message: "The request timed out.",
  }
  assert(
    describePartAsText(errorPart)!.includes("timed out"),
    "structured errors project into readable text"
  )

  const historical = projectHistoricalPart(textPart)
  assert(
    historical?.type === "text" && historical.text === "hello",
    "a historical text part becomes a plain text content part"
  )

  return true
}

void runProjectContractChecks()
