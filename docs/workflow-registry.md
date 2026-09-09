# Workflow registry and execution plans

Issue #24 defines the application-owned layer between the atomic model catalog (#2/#17) and Cloudflare Workflows as a durable runtime (#25): what a user is trying to accomplish, what a compatible execution plan looks like, and how that plan is carried out durably.

## Three questions, three owners

- **Model catalog (#2/#17)** — "What can this atomic model/endpoint do, and how do we call it?"
- **Workflow registry (`lib/workflows/registry.ts`, this issue)** — "What is the user trying to accomplish, and what plan satisfies it?"
- **Cloudflare Workflows (#25)** — "How do we durably execute/retry/wait/resume the selected plan?"

## Registry (`lib/workflows/registry.ts`)

`WorkflowDefinition` and `ExecutionPlan` are plain, fixed TypeScript data — a small, closed set of `PlanStepKind`s (`asset.resolve`, `service.toMarkdown`, `service.svgPreview`, `model.execute`, `external.await`, `asset.persist`, `result.normalize`), each carrying a stable `key` that becomes the deterministic Cloudflare Workflow step name. This is deliberately **not** a generic, user-programmable DAG engine (#24's explicit non-goal): the plan is compiled into the bundle and reviewed as code, and the dispatcher that walks it (`PlanExecutionWorkflow`) is a small, bounded `switch` over that closed kind set — adding a new step kind is a code change, not a runtime capability.

Five workflows are registered:

| id | class | plan |
| --- | --- | --- |
| `chat` | inline | describes the compatible capability (`chat`) for model-override validation; actual execution stays in `app/api/chat/route.ts` via #3 directly |
| `ask-document` | durable | resolve → convert-to-markdown → (conditional) OCR fallback → answer → normalize |
| `generate-svg` | durable | generate → persist original → sanitize preview → persist preview → normalize |
| `remove-background` | durable, contextual action | resolve → transform → persist derived → normalize |
| `generate-video-clip` | durable | submit (queued) → await external event → persist ingested result → normalize |

`lib/workflows/registry.contract.ts` validates registry integrity against the *real* catalog (not a fixture): every `model.execute` step's `requiredCapability` must be satisfiable by at least one real, enabled catalog model, and every step's `inputRef` must point at an earlier step in the same plan — a plan can never reference a step that doesn't exist yet or reference itself forward.

## Plan/model selection (`lib/workflows/plan-selection.ts`)

`selectPlan({ workflowId, modelOverride? })` is server-owned policy, run **before** any durable Workflow instance is created:

- No override → the workflow's default plan.
- An override → found only on the plan's designated `overridable` `model.execute` step; rejected (not silently ignored) if the model doesn't exist, isn't enabled, or doesn't have the step's required capability (or isn't in its `compatibleModelKeys` allowlist, when one is declared).

`resolveModelKeysForPlan(plan, selection)` then resolves **every** `model.execute` step in the plan to a concrete catalog key — the overridden step gets the validated override; every other step gets `selectDefaultModelForStep()`'s pick. The result (`Record<stepKey, modelKey>`) is what actually gets passed into the durable Workflow instance as `resolvedModelKeys`.

This split matters: **the durable execution never re-derives or re-validates a model choice.** `PlanExecutionWorkflow` only ever looks up `resolvedModelKeys[stepKey]` — if plan-selection rejected an incompatible override, that decision was already made and enforced before `env.PLAN_EXECUTION_WORKFLOW.create()` was ever called.

## `PlanExecutionWorkflow` (`workflow-worker/src/plan-execution-workflow.ts`)

The durable executor for every `durable`-class workflow. Per plan step:

- `asset.resolve` — owner-scoped D1 lookup of the workflow's input asset.
- `service.toMarkdown` — reads the R2 object, calls `env.AI.toMarkdown()` (real Workers AI utility).
- `model.execute` — looks up the resolved model, calls `executeAtomic()` (immediate) or `submitAtomic()` + `createExternalJob()` (queued), and records a `step_attempts` row (#6) either way — including on failure, before rethrowing.
- `external.await` — `step.waitForEvent()` on a plan-declared event type/timeout.
- `service.svgPreview` — sanitizes the persisted SVG original (see below).
- `asset.persist` — writes whatever the upstream step produced to a newly generated, server-owned R2 key, finalizes the D1 asset, and records lineage.
- `result.normalize` — pure in-memory aliasing to whatever step it references (no external side effect, so no `step.do()` wrapper); `collectResultParts()` resolves the *actual* producing step (which may be an `asset.persist` or a `model.execute` step) to build the right `ConversationPart` rather than assuming one fixed shape.

**ask-document's OCR fallback is ordinary Workflow control flow**, not part of the generic dispatch: the main loop inspects the (already-completed) `convert-to-markdown` result and skips `ocr-fallback` outright when the conversion looks sufficient (non-error, ≥40 characters). #24 explicitly allows real code here — the non-goal is a user-programmable DAG, not all control flow.

### `step.do()` results must be genuinely serializable

Cloudflare Workflows durably persists every `step.do()` result and enforces a `Serializable<T>` constraint on it at the type level. `AtomicImmediateResult`/`AtomicSubmissionHandle` (#3) embed a full `ModelDefinition` and `unknown`-typed JSON payloads — neither type-checks as serializable, and `finalizeWorkflowExecution()`'s return type (a full canonical `ConversationMessage`, #4) is too deep a discriminated union for TypeScript to check without hitting an instantiation-depth limit. Real compile errors caught these before any of this ran once:

- `model.execute` normalizes into a small local `SerializableModelResult` (a JSON payload is carried as a `JSON.stringify`'d string, never `unknown`) instead of returning the raw atomic-executor result.
- `finalize`/`finalize-failed` steps discard `finalizeWorkflowExecution()`'s return value (typed `Promise<void>`) rather than returning it — consistent with #25's "keep step results small" guidance anyway.
- `external.await` unwraps `step.waitForEvent()`'s `{ type, payload, timestamp }` wrapper to store just the `payload` in the step context — a real bug caught while writing the first end-to-end test, not from the type checker (the wrapper is still valid `Serializable<T>`, just the wrong shape for downstream code).

### Cross-script env coupling was a real bug

`executeAtomic()`/`submitAtomic()`/`getAtomicLanguageModel()` (#3) were typed against the literal global `CloudflareEnv` — the *app* Worker's exact binding set (including `ASSETS`, a static-asset binding the Workflow Worker has no reason to declare). That would have made it impossible for `workflow-worker`'s `model.execute` step to call them at all. Fixed by exporting a structural `AtomicExecutorEnv` type (just `AI`, `CLOUDFLARE_AI_GATEWAY_ID`, and the existing optional fields) instead of intersecting with `CloudflareEnv` — the real `CloudflareEnv` still satisfies it, so the app Worker's existing call sites are unaffected.

### The R2 key placeholder bug, twice

`asset.persist`'s asset id (and therefore its `UNIQUE r2_object_key`) is generated *before* the D1 row is created — the same fix #7 needed in `lib/storage/uploads.ts`. Skipping this and inserting a placeholder key first would break the moment a plan has more than one `asset.persist` step (`generate-svg` has two): the second insert would collide with the first's still-placeholder key.

## SVG sanitization (`lib/workflows/svg-sanitize.ts`)

Workers (workerd) has no DOM/XML parser, so `service.svgPreview` is a regex-based stripper covering the well-known SVG XSS vectors: `<script>`/`<foreignObject>`/`<iframe>`/`<embed>`/`<object>`/`<use>` tags, `on*` event-handler attributes, `javascript:`-scheme and external-http(s) `href`/`src`/`xlink:href` references (same-document `#fragment` and inline `data:` URIs are preserved), and `@import`/`expression()` inside `<style>` blocks. This is a reasonable baseline for a durable "safe preview" asset — not a substitute for a real sanitizer/isolated-render pipeline; #18 owns evaluating whether a full sanitizer belongs in the eventual inline-rendering path. The original and its sanitized preview are always distinct R2 objects/D1 assets, linked via #6's `asset_relations` (`preview-of`) — never an overwrite.

## Inline chat provenance (`lib/workflows/inline.ts`)

"Inline" doesn't mean untracked (#24). `app/api/chat/route.ts` now creates a `workflow_execution` row (`workflowId: "chat"`, `executionClass: "inline"`, no Cloudflare Workflow instance) before streaming and finalizes it to `succeeded`/`failed` from `streamText()`'s `onFinish`/`onError` callbacks. Full conversation/message persistence for chat (the D1 rows for the actual messages) is #28's job — this issue only needed the execution/provenance record to exist.

## Triggering and resuming a durable plan

- `POST /api/workflows/plan-execution` — runs `selectPlan()` + `resolveModelKeysForPlan()`, creates the D1 `workflow_execution` row, then `env.PLAN_EXECUTION_WORKFLOW.create({ params })`. Plan/model selection happens here, synchronously, before the (potentially billable) durable instance exists.
- `GET /api/workflows/plan-execution?executionId=` — D1 row plus live Cloudflare Workflow status when mapped.
- `POST /api/workflows/plan-execution/webhook` — the same idempotency-claim-then-`sendEvent()` pattern #25 established (`claimWebhookDelivery`, #6's real ledger table this time, not #25's demo one), looked up via the execution's `cf_workflow_name`/`cf_workflow_instance_id` mapping. #10 will own real per-provider payload validation/signatures; this is the shared mechanics every provider webhook will need.

## Testing

- `pnpm workflows:contract` — registry integrity against the real catalog, plan/model-selection compatibility (including a rejected incompatible override and an override applied to the correct step), and the SVG sanitizer — all offline, no workerd needed (mirrors `atomic:contract`/`conversation:contract`/`storage:contract`).
- `pnpm workflow:test` (`workflow-worker/test/plan-execution-workflow.test.ts`, 10 tests) exercises the actual `PlanExecutionWorkflow` class via `@cloudflare/vitest-plugin`'s Workflow introspection:
  - ask-document's happy path (Markdown sufficient, OCR skipped) and its OCR-fallback path (Markdown insufficient, OCR actually runs) — proving the one real conditional branch goes both ways.
  - generate-svg's original + sanitized-preview persistence and lineage (`preview-of`), including a real, feed-in `<script>` tag that the persisted preview object genuinely does not contain.
  - generate-svg's step-retry idempotency (`mockStepError` on `persist-original`, same pattern #25 proved): exactly one asset row survives a retried step.
  - remove-background as the contextual raster transform, proving `derived-from` lineage.
  - generate-video-clip's queued submission + `external.await` + ingestion into a video result part, and the webhook route's D1 idempotency claim in isolation.

  Every `model.execute`/`service.toMarkdown` step is intercepted with `mockStepResult` — Cloudflare's own tooling warns "AI bindings always access remote resources," and there is no safe, deterministic way to exercise a live Workers AI/Gateway call from CI. `workflow-worker/wrangler.jsonc`'s `ai` binding deliberately omits `remote: true` (unlike the main app's) for exactly this reason: that config is what `pnpm workflow:test` points Miniflare at.
- `pnpm db:test`'s existing inline-chat test (`test/workflows/inline.test.ts`) proves the D1 provenance record without ever creating a Cloudflare Workflow instance.

## What #24 deliberately does not do

- No generic, user-programmable DAG engine or homegrown scheduler — the plan is fixed TypeScript data; the dispatcher is a small, closed `switch`.
- No real per-provider webhook signature validation (#10) — the webhook route here proves the idempotency + resume mechanism, matching #25's precedent.
- No composer/UI wiring (#5) — the composer will call `selectPlan()`-shaped logic to render compatible model/strategy choices once a workflow is selected, but no UI exists yet.
- No document/SVG/video *feature* polish (#23/#18/#12/#9) — `ask-document`/`generate-svg`/`remove-background`/`generate-video-clip` are real, workable plans proving the registry/executor layer, not the final feature implementations those issues own.
