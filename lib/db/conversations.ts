import {
  ConversationMessageSchema,
  ConversationPartSchema,
  type ConversationMessage,
  type ConversationPart,
} from "../conversation"

import type { LedgerEnv } from "./env"
import { isoNow, newId } from "./ids"

export interface ConversationRow {
  id: string
  owner_id: string
  title: string | null
  summary: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

export async function createConversation(
  env: LedgerEnv,
  input: { ownerId: string; title?: string; id?: string }
): Promise<ConversationRow> {
  const now = isoNow()
  const row: ConversationRow = {
    id: input.id ?? newId("conv"),
    owner_id: input.ownerId,
    title: input.title ?? null,
    summary: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
  }
  await env.DB.prepare(
    `INSERT INTO conversations (id, owner_id, title, summary, archived_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  )
    .bind(row.id, row.owner_id, row.title, row.summary, row.archived_at, row.created_at, row.updated_at)
    .run()
  return row
}

/** Owner-scoped by construction: a conversation id alone is never enough to read it. */
export async function getConversation(
  env: LedgerEnv,
  input: { ownerId: string; conversationId: string }
): Promise<ConversationRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM conversations WHERE id = ?1 AND owner_id = ?2`
  )
    .bind(input.conversationId, input.ownerId)
    .first<ConversationRow>()
  return row ?? null
}

export async function listConversations(
  env: LedgerEnv,
  input: { ownerId: string; limit?: number; cursor?: string | null }
): Promise<{ conversations: ConversationRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
  const [cursorUpdatedAt, cursorId] = input.cursor ? input.cursor.split("|") : [null, null]

  const rows = cursorUpdatedAt
    ? await env.DB.prepare(
        `SELECT * FROM conversations
         WHERE owner_id = ?1
           AND (updated_at < ?2 OR (updated_at = ?2 AND id < ?3))
         ORDER BY updated_at DESC, id DESC
         LIMIT ?4`
      )
        .bind(input.ownerId, cursorUpdatedAt, cursorId, limit + 1)
        .all<ConversationRow>()
    : await env.DB.prepare(
        `SELECT * FROM conversations WHERE owner_id = ?1 ORDER BY updated_at DESC, id DESC LIMIT ?2`
      )
        .bind(input.ownerId, limit + 1)
        .all<ConversationRow>()

  const conversations = rows.results.slice(0, limit)
  const hasMore = rows.results.length > limit
  const last = conversations[conversations.length - 1]
  return {
    conversations,
    nextCursor: hasMore && last ? `${last.updated_at}|${last.id}` : null,
  }
}

export async function updateConversationTitle(
  env: LedgerEnv,
  input: { ownerId: string; conversationId: string; title: string }
): Promise<void> {
  await env.DB.prepare(
    `UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3 AND owner_id = ?4`
  )
    .bind(input.title, isoNow(), input.conversationId, input.ownerId)
    .run()
}

export async function archiveConversation(
  env: LedgerEnv,
  input: { ownerId: string; conversationId: string }
): Promise<void> {
  const now = isoNow()
  await env.DB.prepare(
    `UPDATE conversations SET archived_at = ?1, updated_at = ?1 WHERE id = ?2 AND owner_id = ?3`
  )
    .bind(now, input.conversationId, input.ownerId)
    .run()
}

function extractPartQueryColumns(part: ConversationPart): {
  assetId: string | null
  identityId: string | null
} {
  switch (part.type) {
    case "image":
    case "audio":
    case "video":
    case "model3d":
    case "file":
      return { assetId: part.asset.assetId, identityId: null }
    case "identity":
      return { assetId: null, identityId: part.identity.identityId }
    default:
      return { assetId: null, identityId: null }
  }
}

/**
 * Appends one message and all of its parts atomically via D1 `batch()`
 * (#6: "create user message + workflow execution" is the canonical
 * example of an operation that must commit together). `sequence` is
 * computed from the current max first since D1 batch statements cannot
 * read intermediate results within the same batch.
 */
export async function appendMessage(
  env: LedgerEnv,
  input: {
    conversationId: string
    role: ConversationMessage["role"]
    parts: ConversationPart[]
    workflowExecutionId?: string
    id?: string
    createdAt?: string
  }
): Promise<ConversationMessage> {
  const validatedParts = input.parts.map((part) => ConversationPartSchema.parse(part))

  const nextSeq = await env.DB.prepare(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE conversation_id = ?1`
  )
    .bind(input.conversationId)
    .first<{ next: number }>()

  const messageId = input.id ?? newId("msg")
  const createdAt = input.createdAt ?? isoNow()
  const sequence = nextSeq?.next ?? 1

  const statements = [
    env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, role, sequence, workflow_execution_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(
      messageId,
      input.conversationId,
      input.role,
      sequence,
      input.workflowExecutionId ?? null,
      createdAt
    ),
    ...validatedParts.map((part, index) => {
      const { assetId, identityId } = extractPartQueryColumns(part)
      return env.DB.prepare(
        `INSERT INTO message_parts (id, message_id, ordinal, part_type, data_json, asset_id, identity_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      ).bind(
        part.id,
        messageId,
        index,
        part.type,
        JSON.stringify(part),
        assetId,
        identityId,
        createdAt
      )
    }),
    env.DB.prepare(`UPDATE conversations SET updated_at = ?1 WHERE id = ?2`).bind(
      createdAt,
      input.conversationId
    ),
  ]

  await env.DB.batch(statements)

  return ConversationMessageSchema.parse({
    id: messageId,
    role: input.role,
    createdAt,
    parts: validatedParts,
  })
}

interface MessagePartJoinRow {
  message_id: string
  role: string
  message_created_at: string
  data_json: string | null
  ordinal: number | null
}

/**
 * Reconstructs every message in a conversation, including all parts,
 * from the D1 projection back through ConversationMessageSchema —
 * proving #4's canonical shape round-trips through persistence, not
 * just through JSON.stringify/parse in memory.
 */
export async function getConversationMessages(
  env: LedgerEnv,
  conversationId: string
): Promise<ConversationMessage[]> {
  const rows = await env.DB.prepare(
    `SELECT m.id AS message_id, m.role, m.created_at AS message_created_at,
            p.data_json, p.ordinal
     FROM messages m
     LEFT JOIN message_parts p ON p.message_id = m.id
     WHERE m.conversation_id = ?1
     ORDER BY m.sequence ASC, p.ordinal ASC`
  )
    .bind(conversationId)
    .all<MessagePartJoinRow>()

  const byMessage = new Map<
    string,
    { role: string; createdAt: string; parts: ConversationPart[] }
  >()

  for (const row of rows.results) {
    let entry = byMessage.get(row.message_id)
    if (!entry) {
      entry = { role: row.role, createdAt: row.message_created_at, parts: [] }
      byMessage.set(row.message_id, entry)
    }
    if (row.data_json) {
      entry.parts.push(ConversationPartSchema.parse(JSON.parse(row.data_json)))
    }
  }

  return Array.from(byMessage.entries()).map(([id, entry]) =>
    ConversationMessageSchema.parse({
      id,
      role: entry.role,
      createdAt: entry.createdAt,
      parts: entry.parts,
    })
  )
}
