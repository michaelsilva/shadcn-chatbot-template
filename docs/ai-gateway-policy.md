# AI Gateway routing policy

Issue #13 makes Cloudflare AI Gateway's routing/BYOK/fallback/cache/timeout/retry behavior an explicit, server-owned policy layer on top of #3's atomic executor, instead of scattered per-call defaults.

## What already existed (from #3) and is unchanged

- Every atomic call — Workers-hosted, unified `/ai/run`, and provider-native (Fal) — goes through Cloudflare AI Gateway. There is no direct-to-provider path; `env.AI.run()` always passes `gateway: { id: CLOUDFLARE_AI_GATEWAY_ID }`, and the provider-native path always builds a `gateway.ai.cloudflare.com/...` URL via `buildProviderNativeGatewayUrl()`. Bypassing the Gateway would require adding a new call path, not flipping a flag.
- Server-side allowlisting: `resolveModel()`/`findEnabledCatalogModel()` reject anything not in the curated, enabled catalog (#17). The browser supplies a catalog *key*, never an upstream model id, provider path, or Fal target URL.
- Provider credentials (`FAL_KEY`, `CLOUDFLARE_AI_GATEWAY_TOKEN`) never leave the server; see `docs/atomic-executor.md`.
- Custom provider-native target URLs are only ever built from a trusted catalog route (`assertSafeProviderRoute()`), never from caller input.

## What #13 adds

### Fallback chains (`ModelDefinition.fallbackModelKeys`)

A catalog entry may declare an ordered list of fallback catalog keys. `assertValidModelCatalog()` enforces two hard constraints on every declared fallback:

1. It must exist in the catalog and cannot be the model itself.
2. It must share the primary model's `transport` **and** `protocol`.

The second constraint is what makes fallback safe: two catalog entries with the same transport/protocol accept the same shape of `request.input` (see `docs/atomic-executor.md`'s protocol-adapter table), so `executeAtomic()` can retry the *same* request object against a different model without translating field names across incompatible wire formats. This intentionally means fallback cannot cross, say, `workers-ai` protocol to `responses` protocol, even if both ultimately produce text — that would require per-model input translation this issue does not attempt.

At runtime, `executeAtomic()`:

1. Attempts the resolved (requested) model.
2. On a **retryable** `AtomicExecutionError` (rate limit, timeout, upstream unavailable), walks `fallbackModelKeys` in order. A candidate is skipped unless it is (a) an enabled catalog entry, and (b) `fallbackCandidateSupportsRequest()` returns true — meaning it satisfies the request's declared `AtomicOperationRequirement` (capabilities/inputs/outputs/representation) **and** its own declared parameter schema against the same `request.input`. A fallback with a narrower capability set (no vision, no reasoning) or an incompatible `select`/`number` parameter is never silently used.
3. A non-retryable failure (auth, payment, invalid input/parameter, unsupported operation) is never masked by a fallback and surfaces immediately — this preserves the already-verified #28 behavior where a payment-required model failure reaches the user as a clear error rather than being silently retried against a different model.
4. If a fallback also fails retryably, the chain continues; if the chain is exhausted, the *original* primary error is thrown (the most representative failure for the request as issued).
5. `AtomicResultMetadata.routing.fallbackUsed` and `resolvedModelKey` report whichever model actually served the call.

Fallback is deliberately scoped to `executeAtomic()` only. `submitAtomic()` (provider-native queued submissions) does not fall back: a queued job's external-job/webhook/reconciliation state (#10) is tied to a specific provider, and #10's idempotency layer — the prerequisite for safely retrying a job *submission* — does not exist yet.

Two real catalog pairs currently declare fallback, both chosen because they were already the documented role pairing in #17's catalog review:

- `@cf/zai-org/glm-5.3-flash` → `@cf/zai-org/glm-4.7-flash` (Workers launch default → the already-designated legacy/dev Workers fallback).
- `openai/gpt-5.6-sol` → `openai/gpt-5.6-terra` (premium tier → balanced tier, same Responses-protocol family).

### Cache policy

Every current v0.1 execution class is either a unique conversational turn or a paid generation call — nothing is a safe, idempotent, side-effect-free lookup that Cloudflare Gateway could correctly de-duplicate by hashing the request body. `resolveAtomicGatewayPolicy()` therefore sets `skipCache: true` unconditionally (`gateway.skipCache` for binding calls, the `cf-aig-skip-cache` header for provider-native calls). This is a deliberate, documented default, not an oversight — a future genuinely cacheable execution class (e.g. a deterministic catalog/metadata lookup) should opt in explicitly rather than this default opting everything out.

### Request timeout

`resolveAtomicGatewayPolicy()` sets `requestTimeoutMs` (`gateway.requestTimeoutMs` / `cf-aig-request-timeout`) per execution class:

- Queued provider-native submissions (`execution.result === "queued"`): 15s — a submission should only need to enqueue and return a job handle.
- Everything else (immediate binding/unified calls, including streaming chat): 60s.

This is intentionally conservative and separate from #10's job-level polling/reconciliation timeouts, which apply to the external job *after* submission, not to the atomic submit call itself.

### Retry policy — deliberately off

`GatewayOptions.retries` (and the equivalent `cf-aig-max-attempts`/`cf-aig-retry-delay`/`cf-aig-backoff` headers) exist and are threaded through `AtomicGatewayPolicy`, but `resolveAtomicGatewayPolicy()` always returns `retries: undefined` in v0.1.

This is not an oversight: Cloudflare Gateway's automatic retry re-sends the *same* request to the *same* model when the upstream call fails, but the Gateway cannot know whether the provider already started billable generation work before returning an error. Turning this on for a paid generation call risks exactly the "unbounded duplicate paid generation" failure #10 exists to prevent — the same reasoning #10 applies to Cloudflare Workflow step retries applies equally here. #10's submission idempotency (an app-owned idempotency key the provider can de-duplicate against) is the prerequisite for enabling Gateway-level retries for the execution classes it covers. The field stays typed and wired through now so that turning it on later is a policy change in one function, not a new mechanism.

### Request attribution metadata

Every atomic call now attaches a small, trusted `metadata` object — never prompt/media content:

- `resolved_model_key` — always present.
- `owner_id` — the D1 owner id (#6), when the caller has one. Sourced from `AtomicRequestContext.ownerId`, never a browser-supplied value.
- `correlation_id` / `workflow_step_id` — as already threaded through #3.

This reaches Cloudflare Gateway as `gateway.metadata` for binding calls and as the `cf-aig-metadata` header (JSON-stringified) for provider-native calls, and is the seam #14 (observability) and #15 (per-owner spend policy) are expected to key off later.

`getAtomicLanguageModel()` (the interactive streaming chat path, #28) now accepts an optional `AtomicRequestContext` so this metadata is attached there too — previously the chat route's calls carried no Gateway-level attribution at all. `app/api/chat/route.ts` passes `{ ownerId: owner.id, correlationId: execution.id }`. The Workflow Worker's `model.execute` step (#24) passes `ownerId: ctx.ownerId` into `executeAtomic()`/`submitAtomic()`.

## Non-goals for this pass

- Per-owner/global spend limits and abuse rate limiting — #15.
- Turning on Gateway retries for any execution class — blocked on #10's submission idempotency.
- A cacheable execution class — none exists yet in the v0.1 catalog.
- Translating `request.input` across incompatible protocols so fallback could cross, e.g., `workers-ai` to `messages` — not attempted; fallback stays same-transport/same-protocol only.

## Tests

`pnpm atomic:contract` covers `resolveAtomicGatewayPolicy()` (cache/timeout/metadata shape, retries staying `undefined`) and `fallbackCandidateSupportsRequest()` (capability rejection, parameter-schema rejection, acceptance) as pure logic.

`pnpm atomic:integration` covers, against the real catalog: a compatible fallback succeeding after a retryable primary failure, an incompatible fallback being skipped so the original error surfaces, a non-retryable primary failure never attempting fallback, Gateway policy options reaching `env.AI.run()`'s `gateway` argument, and the `cf-aig-*` policy headers reaching a provider-native call.
