import type { LedgerEnv } from "./env"
import { isoNow, newId } from "./ids"

export type AssetSource = "upload" | "generated" | "derived" | "provider-imported" | "preview"

export interface AssetRow {
  id: string
  owner_id: string
  r2_object_key: string
  artifact_kind: string
  mime_type: string | null
  representation: string | null
  byte_size: number | null
  checksum: string | null
  source: AssetSource
  metadata_json: string | null
  created_at: string
  deleted_at: string | null
}

/** Metadata only — R2 (#25/#7) owns the bytes at `r2ObjectKey`. */
export async function createAsset(
  env: LedgerEnv,
  input: {
    ownerId: string
    r2ObjectKey: string
    artifactKind: string
    source: AssetSource
    mimeType?: string
    representation?: string
    byteSize?: number
    checksum?: string
    metadata?: Record<string, unknown>
    id?: string
  }
): Promise<AssetRow> {
  const now = isoNow()
  const row: AssetRow = {
    id: input.id ?? newId("asset"),
    owner_id: input.ownerId,
    r2_object_key: input.r2ObjectKey,
    artifact_kind: input.artifactKind,
    mime_type: input.mimeType ?? null,
    representation: input.representation ?? null,
    byte_size: input.byteSize ?? null,
    checksum: input.checksum ?? null,
    source: input.source,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
    created_at: now,
    deleted_at: null,
  }
  await env.DB.prepare(
    `INSERT INTO assets (id, owner_id, r2_object_key, artifact_kind, mime_type, representation, byte_size, checksum, source, metadata_json, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
  )
    .bind(
      row.id,
      row.owner_id,
      row.r2_object_key,
      row.artifact_kind,
      row.mime_type,
      row.representation,
      row.byte_size,
      row.checksum,
      row.source,
      row.metadata_json,
      row.created_at
    )
    .run()
  return row
}

export async function getAsset(
  env: LedgerEnv,
  input: { ownerId: string; assetId: string }
): Promise<AssetRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM assets WHERE id = ?1 AND owner_id = ?2`
  )
    .bind(input.assetId, input.ownerId)
    .first<AssetRow>()
  return row ?? null
}

export type AssetRelationKind =
  | "derived-from"
  | "preview-of"
  | "thumbnail-of"
  | "localized-from"
  | "edited-from"
  | "animation-of"

/** Graph-style lineage (#6) — a source asset may relate to several derived assets and vice versa. */
export async function addAssetRelation(
  env: LedgerEnv,
  input: {
    sourceAssetId: string
    targetAssetId: string
    relationKind: AssetRelationKind
    workflowExecutionId?: string
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO asset_relations (source_asset_id, target_asset_id, relation_kind, workflow_execution_id, created_at)
     VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT (source_asset_id, target_asset_id, relation_kind) DO NOTHING`
  )
    .bind(
      input.sourceAssetId,
      input.targetAssetId,
      input.relationKind,
      input.workflowExecutionId ?? null,
      isoNow()
    )
    .run()
}

export interface AssetRelationRow {
  source_asset_id: string
  target_asset_id: string
  relation_kind: AssetRelationKind
  workflow_execution_id: string | null
  created_at: string
}

/** Every asset derived from, or a preview/thumbnail of, this asset. */
export async function listDerivedAssets(
  env: LedgerEnv,
  sourceAssetId: string
): Promise<AssetRelationRow[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM asset_relations WHERE source_asset_id = ?1 ORDER BY created_at ASC`
  )
    .bind(sourceAssetId)
    .all<AssetRelationRow>()
  return rows.results
}

/** Every asset this asset was derived from. */
export async function listSourceAssets(
  env: LedgerEnv,
  targetAssetId: string
): Promise<AssetRelationRow[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM asset_relations WHERE target_asset_id = ?1 ORDER BY created_at ASC`
  )
    .bind(targetAssetId)
    .all<AssetRelationRow>()
  return rows.results
}
