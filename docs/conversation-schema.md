# Canonical multimodal conversation schema

Issue #4 establishes the durable, typed conversation contract used for persistence, cross-modality rendering, and long-running generation state. It does not implement storage, workflows, or polished per-modality UI.

## Live message vs. canonical message

Two message shapes exist, deliberately, for different jobs:

```text
live Vercel UIMessage  →  canonical ConversationMessage  →  D1 persistence (future)
   (transport state)          (application truth)
```

- **`ChatUIMessage`** (`lib/tools.ts`) is the Vercel AI SDK `UIMessage` used for streaming, in-flight tool calls, and the current React chat transport. Its shape is defined by the SDK and by `InferUITools<...>`, so it evolves with SDK versions and current tool wiring.
- **`ConversationMessage`** (`lib/conversation.ts`) is our own serializable discriminated union. It is provider-independent, versionable, and safe to reload after a refresh. This is the shape a future D1 row will store — never a provider or SDK response shape.

`lib/conversation-adapters.ts` provides `chatUIMessageToConversationMessage()`, a **one-way** adapter from the live SDK message into the canonical shape. It is one-way on purpose: canonical parts persist across sessions, while live `UIMessage` parts are transient transport state that gets rebuilt every stream. There is no adapter in the other direction — the current chat UI keeps rendering `ChatUIMessage` directly (`components/chat-message.tsx`), and canonical parts are additive, not a replacement, until a later issue wires D1-backed history through this boundary.

The adapter today covers exactly what the live starter produces: `text`, `source-url`, and `tool-*` parts. It intentionally does not invent handling for part shapes (file attachments, reasoning, provider-specific tool metadata) the current UI doesn't yet emit — extending it is scoped to whichever issue adds that live capability.

## Canonical part union

`ConversationPartSchema` (`lib/conversation.ts`) is a Zod discriminated union on `type`, covering:

| Part | Purpose |
| --- | --- |
| `text` | Streaming or complete text, with `state: "streaming" \| "complete"` |
| `image` | Raster **or** SVG output/input, distinguished by `representation` |
| `audio` | Input, speech, music, sound-effect, or transformed audio |
| `transcript` | Normalized structured transcript (see below) |
| `video` | Input, output, or derived video |
| `model3d` | Experimental 3D asset (GLB/GLTF/OBJ/etc.) |
| `derived-media` | Source → operation → output lineage for transformations |
| `file` | Generic attachment/document reference |
| `source` | Web source reference (existing tool/search behavior) |
| `tool` | Existing tool call/result, compatible with current tool UI |
| `generation` | Long-running job placeholder/status (resolves into another part type) |
| `provenance` | Standalone model/provider/usage/execution reference |
| `identity` | Owner-scoped voice/reference identity reference |
| `error` | Structured, retryable-aware error |

Every part carries an optional `provenance` (execution/model/protocol/usage metadata) and `generatedBy` (job/workflow linkage) so any part — not just `generation` — can record how it came to exist.

### Raster vs. SVG

`ImagePart.representation` is `"raster" | "svg"`. This is a mandatory, type-level distinction, not a MIME-type convention: an SVG image can never be mistaken for a raster asset by a consumer that only branches on `representation`. Rendering SVG markup as trusted HTML is explicitly out of scope here — sanitization/isolation is a rendering-layer concern for the later polished SVG UI.

### Structured transcripts

`TranscriptPart` never stores provider-shaped transcript JSON (Deepgram/OpenAI/Eleven/etc.). It normalizes into: full `text`, optional `language`, optional `speakers` list, `segments` (each with optional `speakerId`, timestamps, and per-word timestamps/confidence), and optional non-speech `events` (music, laughter, applause, noise, silence, other). Every timestamp/confidence field is optional — a transcript from a model that only returns full text is still valid.

### Derived-media lineage

`DerivedMediaPart` never overwrites a source asset. It records `sourceAssetIds` → `operation` (`image-edit`, `background-removal`, `upscale`, `video-edit`, `video-extension`, `audio-isolation`, `voice-conversion`, `dubbing`, `model3d-rigging`, `model3d-animation`, `other`) → `outputAssetIds`, plus a free-form `settings` bag for reconstructing what happened. It intentionally does not persist an entire workflow graph — that remains #6/#24's job.

### Asset references

`AssetReferenceSchema` is the conversation-facing contract for a durable asset: `assetId`, `kind`, and optional `mimeType`, `fileName`, `byteSize`, `format`, `width`/`height`, `durationMs`, `previewAssetId`, `checksum`. It deliberately has no bytes, signed URL, or bucket path — #7 owns resolving an `assetId` to an actual R2 object. Large media payloads must never be embedded into message JSON.

### Owner-scoped identities

`OwnerScopedIdentityLinkSchema` references an app-owned identity record (`identityId`, `kind`) — never a raw provider voice/embedding id. The schema is `.strict()`: any attempt to smuggle a provider-specific field (e.g. a raw `providerVoiceId`) onto the reference fails validation instead of silently passing through. This keeps user-specific provider identifiers out of globally visible/catalog-adjacent message metadata by construction, not by convention.

## Generation lifecycle

Long-running generation updates one logical part in place instead of appending a new message per state change. `GenerationPart.state` is one of `queued | submitted | running | succeeded | failed | cancelled | expired`. Valid transitions are enforced by `canTransitionGeneration()` — every non-terminal state can reach any terminal state directly (a job can fail or be cancelled at any point), but terminal states (`succeeded`, `failed`, `cancelled`, `expired`) never transition further.

`applyConversationEvent(message, event)` is the reducer. Supported events:

- `text.delta` — appends to a `text` part's `text`, flips `state` to `"complete"` when `final: true`
- `part.upsert` — inserts or replaces a part by id
- `generation.transition` — moves a `generation` part's `state` forward (rejects invalid transitions)
- `generation.resolve` — replaces a `generation` part **in place** (same `id`) with its terminal resolved part (e.g. a finished `video` or `image` part), preserving `generatedBy` job/workflow linkage

Provider-specific queue states (Fal's queue statuses, etc.) never reach this contract directly — normalizing an upstream job into `queued | submitted | running | succeeded | failed | cancelled | expired` is #10's job before it emits a `generation.transition`/`generation.resolve` event.

## Rendering boundary

`components/conversation-part.tsx` exports `ConversationPartView`, a `switch` over every `ConversationPart["type"]` ending in `assertNever(part)` instead of a `default: return null`. Adding a new part variant to the union without adding a matching `case` is a compile-time error, not a silent no-op at render time. Cards here are intentionally minimal (a label, an asset id/filename, a state string) — polished per-modality UI is later work.

## Tests

`pnpm conversation:contract` compiles `lib/conversation.ts` and `lib/conversation.contract.ts` in isolation (no test framework dependency, matching the `atomic:contract` pattern) and runs the assertions. It covers:

- every part type parses and round-trips through the runtime schema unchanged (structural, order-independent comparison — `JSON.stringify` alone is not safe here because Zod re-emits object keys in schema-declaration order)
- a full multimodal message serializes and parses back to an equivalent object
- a `generation.transition` event serializes/parses and updates the same logical part
- a `generation.resolve` event replaces a `generation` part with its resolved output part while preserving job/workflow lineage
- streaming `text.delta` resolves an existing text part instead of creating a new one
- valid/invalid generation state transitions (`canTransitionGeneration` plus a rejected `applyConversationEvent` transition)
- an asset `kind` mismatch (e.g. an `image` part pointing at a `video`-kind asset) is rejected
- an owner-scoped identity reference carrying a raw provider identifier is rejected

The `Conversation schema` GitHub Actions workflow runs `pnpm typecheck` and `pnpm conversation:contract` on every relevant PR or `main` change.

## Non-goals (explicitly deferred)

- No D1 tables (persistence wiring is a later issue)
- No R2 implementation (#7 owns asset storage/access)
- No Cloudflare Workflow implementation (#24 owns composition, #10 owns async job reconciliation)
- No WebGL 3D viewer/editor
- No polished modality-specific rendering (only the exhaustive base boundary)
- No redesign of the tool architecture (#29)
