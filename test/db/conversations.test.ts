import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import type { ConversationPart } from "../../lib/conversation"
import {
  appendMessage,
  createConversation,
  getConversation,
  getConversationMessages,
  listConversations,
} from "../../lib/db/conversations"
import { getOrCreateOwner } from "../../lib/db/owners"

async function ownerId() {
  const owner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "conversations" })
  return owner.id
}

describe("conversations", () => {
  it("creates, reads, and lists conversations owner-scoped", async () => {
    const owner = await ownerId()
    const otherOwner = await getOrCreateOwner(env, { authProvider: "test", authSubject: "someone-else" })

    const conversation = await createConversation(env, { ownerId: owner, title: "First chat" })
    expect(conversation.title).toBe("First chat")

    const fetched = await getConversation(env, { ownerId: owner, conversationId: conversation.id })
    expect(fetched?.id).toBe(conversation.id)

    // Owner scoping: a conversation is invisible under the wrong owner id.
    const wrongOwner = await getConversation(env, {
      ownerId: otherOwner.id,
      conversationId: conversation.id,
    })
    expect(wrongOwner).toBeNull()

    const { conversations } = await listConversations(env, { ownerId: owner })
    expect(conversations.map((c) => c.id)).toContain(conversation.id)
  })

  it("appends multimodal messages atomically and reconstructs them exactly through ConversationMessageSchema", async () => {
    const owner = await ownerId()
    const conversation = await createConversation(env, { ownerId: owner })

    const userParts: ConversationPart[] = [
      { id: "part_text_1", type: "text", text: "Generate an SVG logo", state: "complete" },
    ]
    await appendMessage(env, { conversationId: conversation.id, role: "user", parts: userParts })

    const assistantParts: ConversationPart[] = [
      { id: "part_text_2", type: "text", text: "Here you go:", state: "complete" },
      {
        id: "part_image_1",
        type: "image",
        role: "output",
        representation: "svg",
        asset: {
          assetId: "asset_svg_1",
          kind: "image",
          mimeType: "image/svg+xml",
          format: "svg",
        },
      },
      {
        id: "part_identity_1",
        type: "identity",
        identity: { identityId: "identity_voice_1", kind: "cloned-voice" },
        label: "Narration voice",
      },
    ]
    const appended = await appendMessage(env, {
      conversationId: conversation.id,
      role: "assistant",
      parts: assistantParts,
    })
    expect(appended.parts).toHaveLength(3)

    const messages = await getConversationMessages(env, conversation.id)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe("user")
    expect(messages[0]?.parts).toEqual(userParts.map((p) => expect.objectContaining({ id: p.id })))
    expect(messages[1]?.role).toBe("assistant")
    expect(messages[1]?.parts.map((p) => p.id)).toEqual([
      "part_text_2",
      "part_image_1",
      "part_identity_1",
    ])

    const imagePart = messages[1]?.parts.find((p) => p.id === "part_image_1")
    expect(imagePart).toMatchObject({ type: "image", representation: "svg" })

    // The denormalized query column is populated for parts that carry an asset reference.
    const row = await env.DB.prepare(
      `SELECT asset_id FROM message_parts WHERE id = ?1`
    )
      .bind("part_image_1")
      .first<{ asset_id: string }>()
    expect(row?.asset_id).toBe("asset_svg_1")
  })

  it("keeps message sequence monotonic per conversation across appends", async () => {
    const owner = await ownerId()
    const conversation = await createConversation(env, { ownerId: owner })

    await appendMessage(env, {
      conversationId: conversation.id,
      role: "user",
      parts: [{ id: "seq_1", type: "text", text: "one", state: "complete" }],
    })
    await appendMessage(env, {
      conversationId: conversation.id,
      role: "assistant",
      parts: [{ id: "seq_2", type: "text", text: "two", state: "complete" }],
    })

    const sequences = await env.DB.prepare(
      `SELECT sequence FROM messages WHERE conversation_id = ?1 ORDER BY sequence ASC`
    )
      .bind(conversation.id)
      .all<{ sequence: number }>()
    expect(sequences.results.map((r) => r.sequence)).toEqual([1, 2])
  })
})
