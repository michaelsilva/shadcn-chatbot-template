# Atomic executor

Issue #3 establishes the server-owned boundary for one model or endpoint invocation.

## Responsibilities

`lib/atomic-executor.ts` resolves an enabled catalog key and performs exactly one atomic call. It owns:

- catalog-key validation
- capability, artifact, representation, and declared parameter checks
- protocol selection for streaming language models
- transport selection for unified/Workers vs provider-native requests
- server-side credentials
- normalized immediate results and queued-submission handles
- stable upstream error classes and retryability hints
- Gateway/model/request provenance

It does **not** own workflow planning, persistence, polling, webhook reconciliation, retries across attempts, asset ingestion, or fallback policy.

Those remain separate:

- #24 — workflow/pipeline composition
- #10 — external async job lifecycle/reconciliation
- #6 — durable D1 execution/history ledger
- #7 — R2 asset lifecycle and resolution of durable app asset IDs to provider-ready inputs
- #13 — Gateway routing/BYOK/fallback policy
- #28 — canonical conversation context projection
- #29 — portable vs provider-native tool policy

### Asset-input boundary

The atomic executor accepts provider-ready normalized input objects and validates them against the selected catalog capability. It does not know about R2 bucket layout, signed URLs, or ownership records because those do not exist until #7/#6 are implemented.

When durable assets arrive, the caller immediately above this boundary must resolve an owner-authorized app asset reference into the provider-ready representation before invoking `executeAtomic()` or `submitAtomic()`. That resolver belongs with the asset/workflow layer, not inside the transport adapter. The executor still prevents callers from supplying arbitrary model routes, provider auth headers, or provider target URLs.

Streaming conversation attachments follow the same rule through #28: canonical owner-scoped conversation parts are projected into model-ready messages before the atomic language-model adapter is invoked.

## Protocol adapters

The language-model adapter chooses from catalog `protocol`, never from provider-name prefixes:

| Catalog protocol | Adapter |
| --- | --- |
| `workers-ai` | Workers AI Vercel provider over the `AI` binding |
| `responses` | OpenAI Responses wire format translated through `env.AI.run()` |
| `messages` | Anthropic Messages wire format translated through `env.AI.run()` |
| `chat-completions` | OpenAI Chat Completions wire format translated through `env.AI.run()` |

The provider SDK is used only as a wire-format serializer/parser. The custom fetch removes the SDK's model field and executes the canonical server-owned catalog model through the Cloudflare AI binding.

This is why `google/gemini-3.7-flash` can use the Chat Completions adapter without a Google-specific executor branch.

## Immediate atomic execution

`executeAtomic(env, request)` supports one immediate-capable catalog entry.

Workers-hosted and third-party unified entries call:

```text
env.AI.run(canonicalModelId, input, {
  gateway: { id: CLOUDFLARE_AI_GATEWAY_ID },
  returnRawResponse: true
})
```

The result is normalized as JSON, text, or binary while retaining content type, usage when returned, request IDs, model/transport/protocol, Gateway ID, and key source.

## Provider-native Fal execution

Fal remains a genuinely different transport because its broad media endpoint catalog is exposed through Cloudflare AI Gateway's provider-native proxy rather than the normalized model binding.

The executor never accepts an arbitrary target URL from callers. It joins a safe server-owned catalog route to fixed Cloudflare/Fal origins.

Synchronous calls use:

```text
https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/fal/{catalog-route}
Authorization: Key {FAL_KEY}
```

Queued calls use Cloudflare's custom-target form:

```text
POST https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/fal
Authorization: Bearer {FAL_KEY}
x-fal-target-url: https://queue.fal.run/{catalog-route}
```

`submitAtomic()` returns only the normalized external job handle (`requestId`, status/response/cancel URLs, initial state) plus execution provenance. #10 owns what happens after submission.

## Server configuration

No provider secret or Cloudflare account identifier is committed to the repository.

The existing binding/unified path needs only the configured Workers AI binding and `CLOUDFLARE_AI_GATEWAY_ID` already present in Wrangler configuration.

Provider-native Fal additionally requires runtime configuration:

- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account containing the Gateway
- `FAL_KEY` — Fal API token, stored as a Worker secret
- `CLOUDFLARE_AI_GATEWAY_TOKEN` — optional; required only when the provider-native Gateway itself has Authenticated Gateway enabled

Example secret setup:

```sh
wrangler secret put FAL_KEY
wrangler secret put CLOUDFLARE_AI_GATEWAY_TOKEN
```

Do not put either token in `wrangler.jsonc`, client environment variables, or catalog data.

`CLOUDFLARE_ACCOUNT_ID` is not a provider credential, but it should still be supplied as deployment configuration rather than hard-coded into executor logic.

## Result provenance

Immediate and submitted results expose:

- requested catalog key
- resolved catalog key
- canonical upstream model/endpoint id
- provider
- catalog source
- transport
- protocol
- Gateway ID
- upstream request id where available
- workflow/correlation ids supplied by the caller
- key source:
  - `workers-binding`
  - `unified-billing`
  - `provider-key`
- routing result with `fallbackUsed: false`

Fallback remains false in #3 by design. #13 may resolve a compatible fallback later and record that outcome through this existing metadata seam.

## Error contract

`AtomicExecutionError` provides stable application-level codes rather than leaking provider-specific error shapes:

- model/config/input errors
- upstream authentication/payment rejection
- rate limiting
- timeout
- non-retryable upstream rejection
- retryable upstream unavailability
- invalid upstream response

HTTP 429, timeout-class responses, and 5xx failures are marked retryable. Most 4xx validation/auth/payment failures are not. #10 decides whether and when a retry attempt is actually scheduled.

## Tests

`pnpm atomic:contract` executes the pure core contracts without adding a test framework dependency. It covers:

- capability/artifact/representation validation
- catalog-key mismatch rejection
- declared parameter validation
- safe provider-native route construction
- deterministic Gateway and Fal queue URLs
- metadata/request-id/usage normalization
- JSON/text/binary response handling
- malformed upstream JSON
- HTTP error classification and retryability
- queue-state normalization

`pnpm atomic:integration` executes the actual atomic executor module against mocked Cloudflare/Fal transports. The disposable harness stubs only the SDK wire serializers; the normal repository typecheck validates the real installed SDK factories and Cloudflare overloads. It covers:

- Workers AI, Responses, Anthropic Messages, and Chat Completions dispatch
- Workers-hosted execution
- one Universal Run path across raster image, SVG, ASR, TTS, and video catalog entries
- provider-native Ideogram sync execution
- provider-native Kling O3 queued submission
- Key vs Bearer Fal authentication modes and authenticated-Gateway headers
- arbitrary model/target rejection
- queue/immediate misuse
- retryable provider-native upstream failures

The dedicated `Atomic executor` GitHub Actions workflow runs full `pnpm typecheck`, `pnpm atomic:contract`, and `pnpm atomic:integration` on every relevant PR or `main` change.

Live paid-provider smoke tests remain a deployment/release concern (#16/#32). #3's CI proves the protocol/transport contracts without requiring provider secrets or incurring media-generation spend on every code change.
