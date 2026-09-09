# D1 product ledger

Issue #6 defines the canonical D1 schema and a repository layer (`lib/db/`) that both the OpenNext app Worker and the sibling Workflow Worker (#25) share. D1 is durable application truth; R2 (#25/#7) owns bytes; Cloudflare Workflow instance state (#25) is a bounded-retention execution detail, not the permanent record.

## Schema (`migrations/0002_product_ledger.sql`)

| Table | Owns |
| --- | --- |
| `owners` | Identity/ownership. One row is enough for a personal deployment, but every other table is owner-scoped from day one. |
| `conversations` | Title/summary/archive state. |
| `messages` | Role + a monotonic `sequence` per conversation (never assumed from timestamps). |
| `message_parts` | The full canonical #4 `ConversationPart` as `data_json`, plus denormalized `asset_id`/`identity_id` query columns for parts that carry one. |
| `workflow_executions` | The durable logical user request — one row per request, however many steps/attempts/retries it takes. Carries `parent_execution_id`/`parent_relationship` for replay/regenerate lineage and `cf_workflow_name`/`cf_workflow_instance_id` for durable executions. |
| `workflow_steps` | Application-domain step ledger, distinct from Cloudflare Workflow's own transient runtime state. Unique on `(workflow_execution_id, step_key)`. |
| `step_attempts` | Append-only attempt/provenance record. Unique on `(workflow_step_id, attempt_no)`. |
| `external_jobs` | Provider/Gateway async correlation, server-only. Unique on `(provider, provider_job_id)` — a provider id is a lookup key, never a primary key. |
| `assets` | Metadata only (kind, MIME, size, checksum, source) plus the R2 object key. Unique on `r2_object_key`. |
| `asset_relations` | Graph-style lineage (`derived-from`, `preview-of`, `thumbnail-of`, `localized-from`, `edited-from`, `animation-of`) instead of one nullable parent column. |
| `document_extractions` | Small extractions inline; large ones reference an R2-backed `content_asset_id` instead (enforced in code — see below). |
| `reusable_identities` | Owner-scoped voice/reference identities. `provider_reference` is only ever read through an owner-scoped query. |
| `webhook_deliveries` | Idempotency ledger for at-least-once external deliveries. Unique on `(provider, event_key)`. |

`#25`'s `runtime_probe_executions`/`runtime_probe_webhook_events` tables (migration `0001`) are untouched and unrelated — they exist solely to prove the Workflow/D1/R2 platform primitives work, not as product data.

## Repository layer (`lib/db/`)

Every function takes an `env: { DB: D1Database }` and is plain, typed SQL — no ORM. Modules:

- `owners.ts` — `getOrCreateOwner`, `getOwner`
- `conversations.ts` — `createConversation`, `getConversation`, `listConversations` (cursor-paginated), `updateConversationTitle`, `archiveConversation`, `appendMessage`, `getConversationMessages`
- `workflow-executions.ts` — `createWorkflowExecution`, `createReplayExecution`, `mapCloudflareWorkflowInstance`, `updateWorkflowExecutionState`, `recordStepAttempt`, `createExternalJob`, `updateExternalJobState`, `finalizeWorkflowExecution`
- `assets.ts` — `createAsset`, `getAsset`, `addAssetRelation`, `listDerivedAssets`, `listSourceAssets`
- `document-extractions.ts` — `createDocumentExtraction`, `listDocumentExtractions`
- `reusable-identities.ts` — `createReusableIdentity`, `listReusableIdentities`, `getReusableIdentity`, `deleteReusableIdentity`
- `webhooks.ts` — `claimWebhookDelivery`, `recordWebhookOutcome`

### Conversation reconstruction

`appendMessage` validates every part through `ConversationPartSchema` (#4) before writing, and inserts the message row plus all of its parts in one `env.DB.batch()` call — the "create user message" atomicity example from #6. `getConversationMessages` does the reverse with a single joined query, parsing each part's `data_json` back through `ConversationPartSchema`: this is a real persistence round-trip, not just the in-memory one `lib/conversation.contract.ts` already covers.

### Step retry vs. user replay

These are deliberately two different functions, because they're two different domain concepts:

- `recordStepAttempt(env, { workflowExecutionId, stepKey, ... })` — called once per Cloudflare Workflow `step.do()` attempt. The first call creates the `workflow_steps` row (unique on `(workflow_execution_id, step_key)`); every call after that — including retries of the same step — increments `attempt_no` on the *same* step and execution.
- `createReplayExecution(env, { parentExecutionId, relationship })` — always creates a **new** `workflow_executions` row linked via `parent_execution_id`/`parent_relationship`. A user clicking "regenerate" is a new logical request, not a retried attempt of the old one, and the old execution's step ledger is untouched.

### Finalization

`finalizeWorkflowExecution` updates the execution's terminal state and appends its result message/parts in one batch when there's a conversation to project into (`#6`: "finalize workflow + result message/parts"). With no conversation (e.g. a background job), it just updates execution state.

### Idempotency as a D1 constraint, not application logic

Three places rely on a unique index plus `ON CONFLICT ... DO NOTHING` (checking `meta.changes`) rather than a `SELECT`-then-`INSERT` race:

- `createExternalJob` — `(provider, provider_job_id)`
- `addAssetRelation` — `(source_asset_id, target_asset_id, relation_kind)`
- `claimWebhookDelivery` — `(provider, event_key)`

This is the same pattern #25 proved at the infrastructure level (`lib/runtime-probe-webhook.ts`), now applied to the real ledger.

### The large-extraction boundary is enforced, not just documented

`createDocumentExtraction` throws if `content` is supplied and exceeds `INLINE_EXTRACTION_CONTENT_LIMIT` (100,000 characters — far below D1's 2 MiB row limit, but a real, tested boundary): callers must extract to R2 and pass `contentAssetId` instead. It also throws if neither `content` nor `contentAssetId` is given.

## Testing

`pnpm db:test` runs `test/db/*.test.ts` against a Miniflare-simulated D1 database (`test/wrangler.jsonc` — a trivial standalone Worker config, since the real app `wrangler.jsonc` points at the OpenNext build output, which doesn't exist without a full `next build`; this mirrors how `workflow-worker/` already tests independently of the Next.js app). Same `@cloudflare/vitest-plugin` + `readD1Migrations`/`applyD1Migrations` pattern established in #25 — D1 only exists inside workerd, so this can't be a plain `tsc`+`node` contract script.

Coverage, mapped to #6's acceptance criteria:

- **conversation reconstruction** — `test/db/conversations.test.ts`: a multimodal message (text, SVG image, owner-scoped identity reference) round-trips through `appendMessage` → D1 → `getConversationMessages` and back through `ConversationMessageSchema` unchanged; message `sequence` stays monotonic across appends.
- **transactional creation/finalization** — the same test's atomic append, plus `test/db/workflow-executions.test.ts`'s finalize test asserting the execution row and its result message/parts land together.
- **Cloudflare Workflow mapping** — `mapCloudflareWorkflowInstance` + `getWorkflowExecutionByCloudflareInstance` round-trip.
- **step retry** — retrying the same `step_key` increments `attempt_no` on the same `workflow_step_id`/`workflow_execution_id` rather than creating a new one.
- **user replay** — `createReplayExecution` produces a new execution id linked via `parent_execution_id`, and its own step ledger starts empty while the original's is untouched.
- **webhook dedupe** — `test/db/webhooks.test.ts`: a duplicate `(provider, event_key)` is rejected; a different provider with the same key is accepted.
- **identity ownership** — `test/db/reusable-identities.test.ts`: an identity created under one owner is invisible to `getReusableIdentity`/`listReusableIdentities` under a different owner id.
- **asset lineage** — `test/db/assets.test.ts`: a `derived-from`/`preview-of` chain queries correctly in both directions, and a duplicate relation is a no-op.
- **large-extraction boundary** — `test/db/document-extractions.test.ts`: content at/under the limit stores inline; over the limit throws and requires `contentAssetId`; neither given also throws.

`test/db/**` (like `workflow-worker/test/**`) is excluded from the root `pnpm typecheck` — `cloudflare:test`/`cloudflare:workers` are ambient modules only meaningful inside the Vitest Workers pool. `lib/db/**` itself has no such exclusion and is covered by the ordinary root typecheck.

The `Cloudflare runtime` GitHub Actions workflow now runs `pnpm workflow:test` and `pnpm db:test` alongside `pnpm typecheck` on every relevant change.

## What #6 deliberately does not do

- No API routes wired up yet (conversation history UI, chat persistence) — that's #26/#28's job, now that the repository layer they'll call exists and is tested.
- No soft-delete/tombstone retention policy beyond `reusable_identities` (needed so a deleted identity can't silently resurrect in a listing) and `conversations.archived_at`. The fuller deletion/retention semantics #6 describes narratively (R2 cleanup coordination, conversation deletion cascades) are not implemented — nothing in the acceptance-criteria checklist requires them yet, and building them now would be speculative.
- No D1 Sessions API/read-replica bookmarks — read replication is off by default per #6, and this repository layer uses ordinary binding queries accordingly.
- Existing inline chat (`app/api/chat/route.ts`) does not yet write through this ledger. Wiring that up is #28's job (canonical server-side context assembly) — #6 only needed to prove the ledger itself works correctly under real, tested operations.
