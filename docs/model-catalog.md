# Model catalog authority

The application owns a **curated atomic model/endpoint catalog**. It is not a mirror of every model reachable through Cloudflare AI Gateway.

## Source of truth

`lib/model-catalog-data.ts` contains the enabled catalog data and uses the contract from `lib/model-catalog.ts`.

Each entry separates:

- stable application key
- upstream model/endpoint id
- provider
- catalog source
- transport
- protocol
- lifecycle (`launch`, `experimental`, `legacy`, `disabled`, `deprecated`)
- product roles
- input/output artifact kinds
- atomic capabilities
- output representation
- execution behavior
- reviewed parameters/limits
- verification date and authoritative documentation

Product workflows are separate and are composed in #24. Platform services such as Workers AI `toMarkdown` are workflow steps, **not fake catalog models**.

## Catalog sources

### Workers AI

`catalogSource: "workers-ai"`

Workers-hosted models are executed through the Workers AI binding. Launch Workers entries receive automated freshness checks through Cloudflare's Model Search and Model Schema APIs.

### Unified Cloudflare catalog

`catalogSource: "unified"`

These are third-party or Cloudflare-normalized models available through the unified Cloudflare AI surface. Their verification metadata points to the current Cloudflare model documentation.

Workers Model Search / Model Schema **do not validate these entries**.

### Provider-native AI Gateway

`catalogSource: "gateway-provider-native"`

These use a provider-native endpoint through Cloudflare AI Gateway, currently including Fal endpoints. Launch entries carry both:

1. the Cloudflare Gateway provider reference, and
2. the provider's exact endpoint/model documentation.

Provider-native paths are server-owned trusted catalog constants. The browser must never supply an arbitrary provider route.

## Launch vs experimental

`launch` means the endpoint is part of the reviewed supported product baseline. It does **not** mean every launch entry is visible in the current starter model dropdown.

Until #3 replaces the starter executor, `lib/models.ts` exposes a deliberately smaller compatibility projection containing only chat models that the existing executor can actually run.

For example:

- Gemini 3.7 Flash may be `launch` catalog data while waiting for the Chat Completions adapter in #3.
- image/SVG/audio/video launch entries remain inaccessible through `/api/chat`.
- 3D, music/SFX, dubbing, and reusable voice cloning remain `experimental` according to #31.

## Workers AI freshness baseline

`catalog/workers-ai-baseline.json` is intentionally **Workers-launch-only**.

It must stay in lockstep with the launch entries where:

```text
catalogSource === "workers-ai"
```

The baseline stores:

- reviewed model id
- expected lifecycle
- reviewed documentation URL
- normalized input/output schema fingerprint

The schema fingerprint starts as `null` until an authenticated review/refresh is performed. A fake fingerprint must never be committed merely to make CI green.

## Validation commands

### Static / opportunistic remote validation

```bash
pnpm catalog:validate-workers
```

Without Cloudflare credentials this validates the checked-in baseline structure and exits successfully after reporting that remote validation was skipped.

With both credentials below, it also validates current Workers availability/lifecycle and schema drift:

```bash
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
pnpm catalog:validate-workers
```

If only one credential is present the command fails rather than silently downgrading to a static check.

### Require remote validation

```bash
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
pnpm catalog:validate-workers:remote
```

This fails if credentials are missing.

### Refresh reviewed Workers schema fingerprints

After reviewing an intentional upstream schema change:

```bash
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
pnpm catalog:refresh-workers
```

`--refresh` verifies that every baseline model still exists, is not deprecated, and is not experimental before updating the schema fingerprints and `reviewedAt` date.

Review the resulting diff before committing it. Refreshing is an explicit approval step; schema drift never rewrites product parameter controls automatically.

## Lifecycle detection

Cloudflare currently documents the default Model Search response body as an unknown model shape. The validator therefore avoids relying on undocumented fields such as `deprecated`.

For each launch Workers model it checks exact model presence across three documented search policies:

1. deprecated included / experimental visible
2. deprecated excluded / experimental visible
3. deprecated excluded / experimental hidden

This distinguishes missing, deprecated, and experimental states using documented query semantics.

The exact model match is conservative and never accepts a partial id.

## Schema fingerprint

The validator retrieves the Workers model's `input` and `output` JSON Schemas, recursively sorts object keys, preserves array order, serializes the pair, and stores:

```text
sha256:<64 hex characters>
```

Any later mismatch is a review failure. It does not automatically mutate `parameters`, limits, workflow definitions, or UI controls.

## GitHub Actions

`.github/workflows/model-catalog.yml` runs on catalog changes, `main`, a weekly schedule, and manual dispatch.

It always:

- installs the locked dependencies
- runs the repository TypeScript check
- validates the Workers baseline

If repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are configured, the same validation command automatically performs the remote Workers lifecycle/schema checks. If neither secret is configured, the workflow remains a static catalog gate.

## Adding or replacing a model

A normal model/endpoint addition should be a catalog-data change when the existing contract can describe it.

Before promoting an entry to `launch`:

1. verify the exact current id/path against its authoritative source,
2. record current capabilities, representation, protocol/transport, lifecycle, and useful limits,
3. attach current documentation references and `lastVerifiedAt`,
4. ensure it fills a real product role rather than duplicating the normal picker,
5. for Workers AI, update the Workers baseline and perform an authenticated fingerprint refresh,
6. run the relevant #32 empirical smoke before hardening quality/cost-sensitive defaults.

Do not silently alias a stale model id to a replacement. Change the catalog entry explicitly and preserve history through lifecycle state when useful.
