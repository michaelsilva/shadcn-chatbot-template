# Cloudflare-native runtime

Issue #25 locks the runtime architecture and proves it actually works: Cloudflare Workflows as the durable execution engine, D1 as the canonical product database, R2 as the canonical binary store, and the existing OpenNext app Worker for inline streaming chat and the API/web boundary.

## Topology

```text
shadcn-chatbot                shadcn-chatbot-workflows
(OpenNext app Worker)          (sibling Worker)
├── web/API boundary           ├── WorkflowEntrypoint classes
├── inline streaming chat      ├── own D1 + R2 bindings
├── binds: DB, ASSETS_BUCKET   └── (not publicly routable —
├── binds: RUNTIME_PROBE_          workers_dev: false)
│   WORKFLOW (script_name:
│   "shadcn-chatbot-workflows")
```

Two Worker scripts, one repository. The app Worker stays the simple OpenNext-generated entrypoint (`main: ".open-next/worker.js"`); `workflow-worker/` is a second, independently deployed Worker script (`main: "src/index.ts"`) that exports `WorkflowEntrypoint` classes. The app Worker binds to those classes across scripts via `workflows[].script_name` in `wrangler.jsonc`. Both scripts import shared domain code from `lib/` — see `lib/runtime-probe.ts` and `lib/runtime-probe-webhook.ts`.

`workflow-worker` sets `workers_dev: false` because nothing calls it over HTTP directly; it's reached only through the Workflow binding (and, in its own test suite, through a self-binding — see below).

## Provisioned Cloudflare resources

- AI Gateway: `shadcn-chatbot` (dedicated to this project — replaces the placeholder `"default"` gateway id that didn't correspond to any real gateway)
- D1 database: `shadcn-chatbot-db`
- R2 bucket: `shadcn-chatbot-assets`

These are real account resources, not local-only config. `wrangler types` and `wrangler deploy --dry-run` (run from `workflow-worker/`) both resolve them successfully, proving the bindings are reproducible rather than aspirational.

## Inline vs. durable

Ordinary text/tool chat (`app/api/chat/route.ts`) is unchanged by this issue: it keeps executing inline through the atomic executor (#3), with no Workflow instance involved. That's deliberate — per #25, only work with multiple meaningful steps, persisted media, external provider queues, webhook waits, or long-running generation should pay for a durable Workflow instance. Writing an inline chat turn into a durable D1 conversation ledger is #6/#28's job, not #25's.

## The representative durable workflow

`RuntimeProbeWorkflow` (`workflow-worker/src/runtime-probe-workflow.ts`) is not a product workflow — #24 owns those. It exists to prove the primitives every real durable workflow will need, in a way that's actually exercised by CI rather than asserted by inspection:

1. `step.do("record-start")` — idempotent D1 upsert (`lib/runtime-probe.ts`), keyed by the Workflow instance id via `INSERT ... ON CONFLICT DO UPDATE`, so a retried step can't create duplicate or inconsistent rows.
2. `step.sleep("settle", "2 seconds")` — a durable suspend/resume point.
3. `step.do("await-confirmation-setup")` — marks the row `awaiting-confirmation`.
4. `step.waitForEvent("external-confirmation", { type: "runtime-probe.confirm" })` — blocks until an external event arrives.
5. `step.do("finalize")` — marks the row `succeeded`, writes the confirmation payload to R2 (`runtime-probe/<id>.json`), and returns the Workflow's output.

## The webhook → sendEvent → waiting Workflow path

`lib/runtime-probe-webhook.ts` (`processRuntimeProbeWebhook`) is what a real provider webhook handler will look like once #10 exists: it claims a D1-backed idempotency key on `event_id` (`INSERT ... ON CONFLICT DO NOTHING`, then checks `meta.changes`), and only calls `instance.sendEvent()` if this delivery actually claimed a new row. A retried/duplicate webhook delivery — which providers do send — never calls `sendEvent()` twice.

`app/api/workflows/runtime-probe/webhook/route.ts` is the Next.js route wrapper; it validates the payload with Zod and delegates to the shared function. `app/api/workflows/runtime-probe/route.ts` shows the other half of the app-Worker-creates-and-inspects-a-cross-script-Workflow-instance story (`POST` creates an instance, `GET ?instanceId=` returns its status).

This is a controllable stand-in for a live provider webhook (e.g. Fal), not a real paid provider integration — #10 will apply the identical shape to actual providers.

## D1 schema

`migrations/0001_runtime_probe.sql` creates exactly two tables: `runtime_probe_executions` and `runtime_probe_webhook_events`. Both exist solely to prove this issue's infrastructure claims — that D1 outlives Cloudflare Workflow instance retention, and that D1 unique constraints are what make retried/duplicate effects safe. **They are not the product ledger.** #6 owns and will introduce the real `workflow_executions` / `workflow_steps` / `step_attempts` / `external_jobs` / `webhook_deliveries` schema; nothing here should be treated as a precedent to extend.

## Testing

Nothing about `WorkflowEntrypoint`, `step.do()/sleep()/waitForEvent()`, or the D1/R2 bindings can be exercised by a plain `tsc`-then-`node` contract script (the pattern used elsewhere in this repo, e.g. `pnpm atomic:contract` / `pnpm conversation:contract`) — those primitives only exist inside the actual Workers runtime (workerd). Cloudflare ships `@cloudflare/vitest-plugin` specifically to test them, including purpose-built Workflow introspection APIs (`introspectWorkflowInstance`, `disableSleeps`, `mockEvent`, `mockStepError`, `waitForStatus`, `getOutput`) and D1 migration helpers (`readD1Migrations`, `applyD1Migrations`). Adding this dependency (scoped to `workflow-worker/`) is a deliberate, narrow exception to this repository's "don't add a test framework casually" default — there is no dependency-light alternative that can drive a real Workflow instance.

`pnpm workflow:test` runs `workflow-worker`'s Vitest suite (`workflow-worker/test/runtime-probe-workflow.test.ts`) against Miniflare-simulated D1/R2/Workflow bindings. It proves:

- the full step sequence (`record-start` → sleep → `await-confirmation-setup` → `waitForEvent` → `finalize`) completes and the instance's output and D1 row match
- a step forced to fail once (`mockStepError`, then retried) still leaves exactly one, consistent D1 row — the idempotent-under-retry requirement
- `processRuntimeProbeWebhook()` delivers a real `sendEvent()` to a running instance and lets that instance complete, while a duplicate delivery of the same `event_id` is rejected before a second `sendEvent()` is attempted

`workflow-worker/test/` is excluded from the root `pnpm typecheck` (see `tsconfig.json`) because `cloudflare:test`/`cloudflare:workers` are ambient modules only meaningful inside the Vitest Workers pool; `workflow-worker/test/tsconfig.json` exists for editor support. `workflow-worker/src/**` (the actual Workflow class) has no such restriction and is covered by the root `pnpm typecheck` like any other file in the repository.

## What #25 deliberately does not do

- No `wrangler deploy` was run as part of this work. Both `wrangler.jsonc` configs are validated (`wrangler types`, and `wrangler deploy --dry-run` from `workflow-worker/`), but publishing a live, publicly reachable Worker is a separate, explicit action for whoever runs `pnpm deploy` / `wrangler deploy` (from `workflow-worker/`) when ready.
- No product D1 ledger (#6), no R2 asset lifecycle (#7), no workflow registry (#24), no inline-chat-writes-to-D1 wiring (#6/#28). This issue proves the platform primitives work; it does not build the product on top of them.
- No Durable Objects, no Queues — neither is needed yet, per #25's explicit deferral.
