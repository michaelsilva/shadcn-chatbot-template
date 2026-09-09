-- #25: minimal infrastructure-proof schema.
--
-- This table exists only to demonstrate that D1 retains durable
-- workflow/provenance records independently of Cloudflare Workflow
-- instance retention, and that Cloudflare Workflow steps can perform
-- idempotent D1 writes safely under retry.
--
-- It is NOT the canonical product ledger. #6 owns the real
-- `workflow_executions` / `workflow_steps` / `step_attempts` /
-- `external_jobs` schema and will supersede this table.

CREATE TABLE runtime_probe_executions (
  id TEXT PRIMARY KEY,
  cf_workflow_instance_id TEXT NOT NULL,
  status TEXT NOT NULL,
  confirmation_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX runtime_probe_executions_cf_instance_idx
  ON runtime_probe_executions (cf_workflow_instance_id);

CREATE TABLE runtime_probe_webhook_events (
  event_id TEXT PRIMARY KEY,
  runtime_probe_execution_id TEXT NOT NULL,
  received_at TEXT NOT NULL
);
