import { describe, expect, it } from "vitest"

import type { ToolPart } from "../lib/conversation"
import {
  assistantContentToConversationParts,
  chatUIMessageToConversationMessage,
} from "../lib/conversation-adapters"
import type { ChatUIMessage } from "../lib/tools"

describe("assistantContentToConversationParts (#29)", () => {
  it("persists a pending ask_user tool call (no matching tool-result) as an input-ready ToolPart, not silently dropped", () => {
    const parts = assistantContentToConversationParts("msg_1", [
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "ask_user",
        input: { questions: [{ question: "Which city?", choices: ["NYC", "LA", "SF"] }] },
      },
    ])

    expect(parts).toHaveLength(1)
    const tool = parts[0] as ToolPart
    expect(tool.type).toBe("tool")
    expect(tool.state).toBe("input-ready")
    expect(tool.output).toBeUndefined()
  })

  it("merges a tool-call and its later tool-result (same toolCallId) into one succeeded ToolPart", () => {
    const parts = assistantContentToConversationParts("msg_1", [
      { type: "text", text: "Let me check that." },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "github_repo",
        input: { repo: "cloudflare/workers-sdk" },
      },
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "github_repo",
        output: { stars: 100 },
      },
    ])

    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatchObject({ type: "text", text: "Let me check that." })
    const tool = parts[1] as ToolPart
    expect(tool.type).toBe("tool")
    expect(tool.state).toBe("succeeded")
    expect(tool.output).toEqual({ stars: 100 })
  })

  it("marks a tool-error as a failed ToolPart with a message", () => {
    const parts = assistantContentToConversationParts("msg_1", [
      { type: "tool-call", toolCallId: "call_1", toolName: "github_repo", input: { repo: "x" } },
      { type: "tool-error", toolCallId: "call_1", toolName: "github_repo", error: "not found" },
    ])

    const tool = parts[0] as ToolPart
    expect(tool.state).toBe("failed")
    expect(tool.error?.message).toContain("not found")
  })

  it("ignores a tool-result with no prior tool-call (nothing to merge into)", () => {
    const parts = assistantContentToConversationParts("msg_1", [
      { type: "tool-result", toolCallId: "orphan", toolName: "x", output: {} },
    ])
    expect(parts).toHaveLength(0)
  })
})

describe("chatUIMessageToConversationMessage: ask_user continuation round-trip (#29)", () => {
  it("maps an answered ask_user tool part to a succeeded ToolPart carrying the answers", () => {
    const message = chatUIMessageToConversationMessage({
      id: "msg_asst_1",
      role: "assistant",
      parts: [
        {
          type: "tool-ask_user",
          toolCallId: "call_1",
          state: "output-available",
          input: { questions: [{ question: "Which city?", choices: ["NYC", "LA", "SF"] }] },
          output: [{ question: "Which city?", answer: "SF" }],
        },
      ],
    } as unknown as ChatUIMessage)

    expect(message.parts).toHaveLength(1)
    const tool = message.parts[0] as ToolPart
    expect(tool.state).toBe("succeeded")
    expect(tool.output).toEqual([{ question: "Which city?", answer: "SF" }])
  })
})
