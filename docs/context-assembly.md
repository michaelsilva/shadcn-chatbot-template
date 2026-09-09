# Server-owned context assembly

Issue #28 makes the server, not the browser, authoritative for conversation context. The chat API no longer trusts a browser-supplied prior transcript — every atomic model call is built from owner-scoped D1 state (#6) via one server-owned assembler.

## The request-boundary change

Before this issue, `app/api/chat/route.ts` passed the browser's entire `messages` array straight into `convertToModelMessages()`. Now:

1. The browser still sends its full local transcript (`useChat`'s default transport does this — there is no frontend rewrite), but the route reads **only the last message** from it: the new turn.
2. That new turn is converted through #4's `chatUIMessageToConversationMessage()` and persisted to D1 via `appendMessage()` — with **freshly generated part ids**, never the client-supplied ones (see "A real bug this caught" below).
3. `assembleModelContext()` reconstructs everything else — prior turns, tool history, media — from D1. The rest of the browser's array is never read again.
4. The model is called with the assembled context, not the browser's transcript.
5. On finish, the assistant's response is persisted back to D1 the same way.

The one frontend change: `components/chat.tsx` generates a stable `conversationId` (`crypto.randomUUID()`) once per mount and sends it with every `sendMessage()` call, resetting it on "New chat." This is *not* #26's durable conversation history/navigation — it only keeps one open tab's turns associated with one D1 conversation row while the tab stays open. Reloading the page starts a new conversation, exactly like today; it's just durably recorded now instead of purely client-side state.

## `assembleModelContext()` (`lib/context/assemble.ts`)

```ts
assembleModelContext(env, { ownerId, conversationId, modelKey, bucketName, explicitSourceAssetIds? })
  → { ok: true, messages, budget, explicitSources } | { ok: false, reason }
```

There is no parameter through which a caller can supply history — only ids. Every message in the result was read from D1 inside this call. The **last** message in the conversation is always the "current turn" (required, never trimmed); everything before it is history, subject to budgeting.

### Capability-aware projection

- **Historical parts** (`lib/context/project.ts`'s `projectHistoricalPart`) are *always* textual — "the event happened," never bytes. An image from 40 turns ago becomes `[Assistant image]`, never a resent file. Tool calls become compact summaries (`[Tool github_repo succeeded]`), never the provider-specific tool-call protocol shape. `provenance`/`identity` parts contribute nothing (they're audit trail, not model input).
- **Explicit current sources** (`explicitSourceAssetIds` — #27's "use as reference") are validated and authorized before being projected as real content:
  - Ownership is checked via `getAsset()` (#6/#7) — an asset belonging to a different owner is `unauthorized`, not silently included.
  - An image is only sent as real content (a `file`-typed part with a presigned GET URL, #7) when the selected model's catalog entry declares `inputs.includes("image")`; otherwise it's `incompatible-capability` — rejected, never silently dropped *or* misattached to an incompatible model.
  - Audio/video/file/3D sources are never sent as raw bytes through this generic path — only an existing transcript (matched by `sourceAssetId`) if one exists, or a plain textual reference if not.

### Budgeting (v0.1 policy — deliberately simple)

- Token estimate is `Math.ceil(text.length / 4)` — a documented heuristic, not a real tokenizer (#28 explicitly scopes a precise per-model tokenizer out of v0.1).
- Context budget = `model.limits.contextTokens (or a 32k default) − reserved output (25%, floor 1024, capped at the model's maxOutputTokens)`.
- The current turn is required: if it alone exceeds the budget, the call fails explicitly (`ok: false`) rather than truncating required content.
- History is trimmed deterministically, oldest-first: walk newest-to-oldest, keep what fits, stop (and omit everything older) at the first message that doesn't. `budget.truncated`/`omittedMessageCount` make this observable without duplicating content.

### To the AI SDK

`lib/context/to-model-messages.ts`'s `toModelMessages()` is a thin, mechanical conversion from the portable `PortableMessage[]` into the AI SDK's `ModelMessage[]`. `PortableContentPart`'s media variant is deliberately modeled on the AI SDK's *current* `FilePart` (`{type:"file", data, mediaType}`), not the deprecated `ImagePart` — the same content model works for today's image case and stays extensible if audio/video/file input paths are wired up later.

## A real bug this caught, live

Unit tests always used unique part ids per test case, so they never exercised this: `chatUIMessageToConversationMessage()` (#4) derives a part id deterministically from the *client-supplied* message id (`` `${messageId}:part:${index}` ``). Persisting that id verbatim means a resent/retried request carrying the same client message id collides with `message_parts`' primary key (D1_ERROR: UNIQUE constraint failed).

This was caught by actually running the app (`pnpm preview`) and sending real chat requests — not by the test suite — exactly the scenario the "run the app, don't just typecheck" discipline exists for. The fix: the route always assigns fresh, server-generated ids to persisted parts (`part.id = crypto.randomUUID()`), never trusting client-supplied identity, consistent with the same principle #6/#7/#24 already applied to asset ids and R2 keys.

The same live run also surfaced an operational gap (not a code bug): local D1 migrations had only ever been applied with `--remote` this session, so the local Miniflare-simulated database Cloudflare's own tooling would use for a Worker restart had no tables at all. Fixed with `wrangler d1 migrations apply shadcn-chatbot-db --local`.

## Verified live, end to end

With the fixes above, a real multi-turn conversation against the actual deployed AI Gateway confirmed:

- A conversation row, both turns' messages/parts (with unique ids), and an inline `workflow_execution` row (#24) are all correctly persisted to D1.
- Asking "what word did you just say?" in a second, independent HTTP request — with the *browser* resending its full local transcript but the *server* only reading the new turn — correctly answered from **D1-reconstructed** context, not from anything the client sent.
- Switching to a model that failed (a payment-required error) correctly recorded `workflow_executions.state = 'failed'` and returned the same graceful, pre-existing user-facing error message — unaffected by this rewrite.

## Testing

`test/context/assemble.test.ts` (10 tests, Miniflare-backed D1) covers #28's acceptance-criteria list directly: no-injection (there is no parameter to inject through — verified even with a client-shaped payload cast past the type system), historical-image-doesn't-break-text-only-model, explicit-image-to-vision-model, explicit-image-rejected-for-text-only-model, explicit-source-ownership rejection, existing-transcript-instead-of-resending-audio, current-turn-overflow-fails-explicitly, deterministic-oldest-first-trimming, tool-history-portability, and unknown-model rejection.

`pnpm context:contract` covers the pure projection/estimation logic (`lib/context/project.ts`) offline, no workerd needed — same dependency-light pattern as the repo's other contract tests.

## What #28 deliberately does not do

- No vector database / corpus RAG, no autonomous long-term memory, no automatic semantic summarization — #28's explicit non-goals. The assembler's contract allows a future summary/retrieval source behind the same interface; none is implemented.
- No full assistant tool-call/result persistence yet — only the final text is persisted on `onFinish`. The portable `ToolPart` shape to persist them already exists (#4); wiring the full round-trip is a follow-on, not required for #28's context-assembly acceptance criteria.
- No provider-side continuation/state optimization — every call rebuilds fully from D1, which is simpler and already satisfies "switching models never requires provider-side history."
- No durable, cross-reload conversation history/navigation — that's #26. This issue only needed the server to *stop trusting the browser* for context; making conversations navigable/resumable across page loads is separate.
