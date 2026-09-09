import type { LedgerEnv } from "./env"
import { isoNow, newId } from "./ids"

/**
 * D1's hard row/string limit is 2 MiB; this boundary is deliberately far
 * below that so ordinary extracted Markdown/text stays inline while
 * anything sizeable is pushed to R2 well before the row itself becomes
 * risky. This is enforced here, not just documented — see
 * `createDocumentExtraction`.
 */
export const INLINE_EXTRACTION_CONTENT_LIMIT = 100_000

export interface DocumentExtractionRow {
  id: string
  source_asset_id: string
  extraction_method: string
  model_key: string | null
  service_version: string | null
  language: string | null
  page_count: number | null
  char_count: number | null
  token_count: number | null
  content: string | null
  content_asset_id: string | null
  created_at: string
}

export async function createDocumentExtraction(
  env: LedgerEnv,
  input: {
    sourceAssetId: string
    extractionMethod: string
    modelKey?: string
    serviceVersion?: string
    language?: string
    pageCount?: number
    tokenCount?: number
    content?: string
    contentAssetId?: string
    id?: string
  }
): Promise<DocumentExtractionRow> {
  if (input.content === undefined && input.contentAssetId === undefined) {
    throw new Error("A document extraction needs either inline content or a content asset.")
  }
  if (input.content !== undefined && input.content.length > INLINE_EXTRACTION_CONTENT_LIMIT) {
    throw new Error(
      `Extraction content is ${input.content.length} characters, over the ${INLINE_EXTRACTION_CONTENT_LIMIT}-character inline limit. ` +
        "Store it as an R2-backed asset and pass contentAssetId instead."
    )
  }

  const now = isoNow()
  const row: DocumentExtractionRow = {
    id: input.id ?? newId("extract"),
    source_asset_id: input.sourceAssetId,
    extraction_method: input.extractionMethod,
    model_key: input.modelKey ?? null,
    service_version: input.serviceVersion ?? null,
    language: input.language ?? null,
    page_count: input.pageCount ?? null,
    char_count: input.content?.length ?? null,
    token_count: input.tokenCount ?? null,
    content: input.content ?? null,
    content_asset_id: input.contentAssetId ?? null,
    created_at: now,
  }

  await env.DB.prepare(
    `INSERT INTO document_extractions (id, source_asset_id, extraction_method, model_key, service_version, language, page_count, char_count, token_count, content, content_asset_id, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
  )
    .bind(
      row.id,
      row.source_asset_id,
      row.extraction_method,
      row.model_key,
      row.service_version,
      row.language,
      row.page_count,
      row.char_count,
      row.token_count,
      row.content,
      row.content_asset_id,
      row.created_at
    )
    .run()
  return row
}

export async function listDocumentExtractions(
  env: LedgerEnv,
  sourceAssetId: string
): Promise<DocumentExtractionRow[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM document_extractions WHERE source_asset_id = ?1 ORDER BY created_at ASC`
  )
    .bind(sourceAssetId)
    .all<DocumentExtractionRow>()
  return rows.results
}
