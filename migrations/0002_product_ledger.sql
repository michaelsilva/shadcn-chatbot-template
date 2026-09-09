-- #6: canonical product ledger.
--
-- Domain boundaries follow #6 exactly. Column names may evolve later,
-- but table responsibilities should not: D1 owns relational identity,
-- conversation/message/part projection, workflow/step/attempt
-- provenance, asset metadata + lineage, document extraction metadata,
-- and owner-scoped reusable identities. R2 (#25/#7) owns bytes.

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  auth_provider TEXT,
  auth_subject TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX owners_auth_identity_idx
  ON owners (auth_provider, auth_subject)
  WHERE auth_provider IS NOT NULL AND auth_subject IS NOT NULL;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners (id),
  title TEXT,
  summary TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX conversations_owner_updated_idx
  ON conversations (owner_id, updated_at DESC);

-- The user-facing projection. Messages/parts, not workflow/step state,
-- are what a conversation renders (see the conversation-projection rule
-- in #6): do not append a message for every durable step transition.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  role TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  workflow_execution_id TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX messages_conversation_sequence_idx
  ON messages (conversation_id, sequence);

-- Canonical typed parts from #4. `data_json` is the full part, parsed
-- back through ConversationPartSchema on read — never a provider or
-- Vercel UIMessage shape. `asset_id`/`identity_id` are denormalized
-- query columns for parts that carry an asset or identity reference;
-- they are not a second source of truth.
CREATE TABLE message_parts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (id),
  ordinal INTEGER NOT NULL,
  part_type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  asset_id TEXT,
  identity_id TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX message_parts_message_ordinal_idx
  ON message_parts (message_id, ordinal);

-- The durable logical user request. One workflow_execution may span
-- many workflow_steps/step_attempts across retries; a Cloudflare
-- Workflow instance is one durable-execution-class implementation
-- detail of a single execution, not the execution's identity.
CREATE TABLE workflow_executions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners (id),
  conversation_id TEXT REFERENCES conversations (id),
  triggering_message_id TEXT REFERENCES messages (id),
  target_asset_id TEXT,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  plan_id TEXT,
  plan_version TEXT,
  execution_class TEXT NOT NULL, -- 'inline' | 'durable'
  requested_model_key TEXT,
  state TEXT NOT NULL,
  result_message_id TEXT REFERENCES messages (id),
  result_part_id TEXT,
  parent_execution_id TEXT REFERENCES workflow_executions (id),
  parent_relationship TEXT, -- 'replay' | 'regenerate' | 'variant'
  correlation_id TEXT,
  cf_workflow_name TEXT,
  cf_workflow_instance_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX workflow_executions_cf_instance_idx
  ON workflow_executions (cf_workflow_name, cf_workflow_instance_id)
  WHERE cf_workflow_instance_id IS NOT NULL;

CREATE INDEX workflow_executions_owner_created_idx
  ON workflow_executions (owner_id, created_at DESC);

CREATE INDEX workflow_executions_conversation_created_idx
  ON workflow_executions (conversation_id, created_at);

CREATE INDEX workflow_executions_state_updated_idx
  ON workflow_executions (state, updated_at);

-- Application-domain step ledger, distinct from Cloudflare Workflow's
-- own transient runtime state.
CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  workflow_execution_id TEXT NOT NULL REFERENCES workflow_executions (id),
  step_key TEXT NOT NULL,
  step_kind TEXT NOT NULL,
  catalog_key TEXT,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  input_ref TEXT,
  output_ref TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX workflow_steps_execution_key_idx
  ON workflow_steps (workflow_execution_id, step_key);

-- Append-only execution-attempt/provenance record.
CREATE TABLE step_attempts (
  id TEXT PRIMARY KEY,
  workflow_step_id TEXT NOT NULL REFERENCES workflow_steps (id),
  attempt_no INTEGER NOT NULL,
  state TEXT NOT NULL,
  requested_catalog_key TEXT,
  resolved_catalog_key TEXT,
  provider TEXT,
  transport TEXT,
  protocol TEXT,
  request_correlation_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT,
  error_retryable INTEGER,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX step_attempts_step_attempt_idx
  ON step_attempts (workflow_step_id, attempt_no);

-- Server-only provider/Gateway async correlation. Never browser-visible.
CREATE TABLE external_jobs (
  id TEXT PRIMARY KEY,
  step_attempt_id TEXT NOT NULL REFERENCES step_attempts (id),
  provider TEXT NOT NULL,
  catalog_key TEXT,
  provider_job_id TEXT NOT NULL,
  state TEXT NOT NULL,
  webhook_metadata TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX external_jobs_provider_job_idx
  ON external_jobs (provider, provider_job_id);

-- Metadata only; R2 owns bytes.
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners (id),
  r2_object_key TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  mime_type TEXT,
  representation TEXT,
  byte_size INTEGER,
  checksum TEXT,
  source TEXT NOT NULL, -- 'upload' | 'generated' | 'derived' | 'provider-imported' | 'preview'
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX assets_r2_object_key_idx ON assets (r2_object_key);
CREATE INDEX assets_owner_created_idx ON assets (owner_id, created_at DESC);
CREATE INDEX assets_owner_kind_idx ON assets (owner_id, artifact_kind);

-- Graph-style lineage rather than one nullable parent column.
CREATE TABLE asset_relations (
  source_asset_id TEXT NOT NULL REFERENCES assets (id),
  target_asset_id TEXT NOT NULL REFERENCES assets (id),
  relation_kind TEXT NOT NULL,
  workflow_execution_id TEXT REFERENCES workflow_executions (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_asset_id, target_asset_id, relation_kind)
);

CREATE INDEX asset_relations_target_idx ON asset_relations (target_asset_id);

-- For small extracted text/Markdown, `content` may store it directly.
-- For large bodies, `content_asset_id` points at an R2-backed asset
-- instead. Enforced in lib/db/document-extractions.ts, not just here.
CREATE TABLE document_extractions (
  id TEXT PRIMARY KEY,
  source_asset_id TEXT NOT NULL REFERENCES assets (id),
  extraction_method TEXT NOT NULL,
  model_key TEXT,
  service_version TEXT,
  language TEXT,
  page_count INTEGER,
  char_count INTEGER,
  token_count INTEGER,
  content TEXT,
  content_asset_id TEXT REFERENCES assets (id),
  created_at TEXT NOT NULL
);

CREATE INDEX document_extractions_source_asset_idx
  ON document_extractions (source_asset_id);

-- Owner-scoped model-adjacent identities such as cloned voices. Never a
-- global catalog entry; provider_reference never leaves an owner-scoped
-- query.
CREATE TABLE reusable_identities (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners (id),
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  display_name TEXT,
  provider_reference TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX reusable_identities_owner_kind_idx
  ON reusable_identities (owner_id, kind);

-- Idempotency ledger for external async jobs (webhooks) and, more
-- generally, any at-least-once external delivery this app must apply
-- exactly once.
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  external_job_id TEXT REFERENCES external_jobs (id),
  step_attempt_id TEXT REFERENCES step_attempts (id),
  outcome TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE UNIQUE INDEX webhook_deliveries_provider_event_idx
  ON webhook_deliveries (provider, event_key);
