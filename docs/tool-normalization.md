# Tool normalization and the ask_user HITL fix

Issue #29 asks for app-owned vs. provider-native tools to become separate typed concepts, catalog-driven rather than provider-name-conditional, and for `ask_user` continuation to be reconstructed from D1 rather than trusted from the browser. This is a partial, verified slice of #29 — see "What's deferred" below for the rest.

## Catalog-driven native tool selection (`lib/tools.ts`)

`getTools(modelId)` used to branch on `modelId.startsWith("openai/")` / `"anthropic/"`. It now takes the resolved `ModelDefinition` and consults `model.tools?.nativeTools` (already populated by #17's catalog data) plus a small adapter map keyed by `model.protocol`:

```ts
const NATIVE_WEB_SEARCH_ADAPTERS: Partial<Record<ModelProtocol, () => Tool>> = {
  responses: () => openai.tools.webSearch(),
  messages: () => anthropic.tools.webSearch_20260209(),
}
```

A model whose catalog entry doesn't declare `nativeTools: ["web-search"]`, or whose protocol has no registered adapter, simply doesn't receive `web_search` — there is no silent app-owned substitute. `components/chat-message.tsx` already rendered `tool-web_search` generically by part type (not by provider), so no UI change was needed there.

`app/api/chat/route.ts` now calls `getTools(modelDefinition)` instead of `getTools(upstreamModelId)`.

## `github_repo` demoted to an explicit example tool

Split `lib/tools.ts`'s tool object into `appTools` (`ask_user` — always available to a tool-capable model) and `exampleTools` (`github_repo` — the starter's demo lookup, not a product capability). `getTools()` only ever returns `appTools` plus any native adapters; `github_repo` is never included by default. `ChatUIMessage`'s type still covers it (`InferUITools<typeof appTools & typeof exampleTools>`) so `components/chat-message.tsx`'s existing renderer stays valid for anyone who explicitly re-adds it to a tool set.

## The ask_user HITL continuation bug (found and fixed here)

This was the substantial finding of this pass. #28 (merged just before this work started) made the server trust only the browser's *last* message and reconstruct everything else from D1 — necessary for canonical context, but it broke `ask_user`'s continuation flow, which `components/chat.tsx` already relied on:

```ts
useChat<ChatUIMessage>({
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
})
```

When the user answers an `ask_user` questionnaire, the AI SDK's `addToolOutput()` does **not** append a new message — it mutates the *existing* assistant message's tool part in place (same `id`, same `role: "assistant"`) and automatically resubmits. #28's route rejected any request whose last message wasn't `role: "user"`, so every `ask_user` continuation 400'd. Separately, `onFinish` only ever persisted final text (`if (text) { appendMessage(...) }`), so even before that rejection, the assistant's tool-call turn itself was never written to D1 — `ask_user`'s question never existed in canonical history in the first place.

### The fix

- **`lib/conversation-adapters.ts`**: new `assistantContentToConversationParts(messageId, content)` builds `ConversationPart[]` from `streamText()`'s `onFinish` `content` array (AI SDK core generation output — distinct from the UI message parts `chatUIMessageToConversationMessage()` already handled). A `tool-call` with no matching `tool-result` in the same array (exactly `ask_user`'s shape — it has no server-side `execute`) persists as one `ToolPart` in `state: "input-ready"`; a later `tool-result`/`tool-error` for the same `toolCallId` merges into that same part rather than creating a second history entry.
- **`app/api/chat/route.ts`**: `onFinish` now persists this full turn (text *and* tool calls), not just text. The route also recognizes an **answered tool continuation** (`role: "assistant"` last message with at least one `output-available`/`output-error` tool part) as a second valid request shape alongside a new `role: "user"` turn, and updates the existing assistant message's parts instead of appending a new user turn.
- **`lib/db/conversations.ts`**: new `replaceMessageParts(env, { conversationId, messageId, parts })` — the mechanism for "update this message's parts in place." Scoped by an explicit `conversationId` join: replacing a message id that doesn't belong to that conversation is a no-op (returns `false`), which is #29's "HITL continuation cannot be forged by replaying a browser-crafted historical tool result" boundary — the route turns a `false` into a `422`, never a silent write. `appendMessage()` couldn't be reused here: it always `INSERT`s, and calling it twice with the same message id would hit `message_parts`' primary key (the same class of bug #28's docs already called out for client-supplied part ids).
- **`lib/context/project.ts`**: `describePartAsText()`'s generic `[Tool ask_user succeeded]` history/current-turn projection lost the actual questions and answers — useless to a model trying to continue the conversation coherently. Added `describeAskUserTool()`, which renders the real Q&A (`[Asked the user and got an answer: "Which city?" → "SF"]`) when the input/output match `ask_user`'s known shape, falling back to the generic description otherwise (e.g. a tool with no matching shape, or historical data from before this fix).

### Verified live, end to end

Ran `pnpm preview` and drove the actual route with real requests against the deployed AI Gateway (GLM 5.3 Flash):

1. "Help me plan a trip." — the model organically called `ask_user` with four real questions. D1 confirmed the assistant message was persisted with a `text` part *and* a `tool` part (`state: "input-ready"`, full `input`), in the same message, at the same sequence — the turn `onFinish` used to drop entirely.
2. Resubmitted the exact continuation payload `useChat`'s automatic trigger would send (same message id, same role, tool part now `output-available` with real answers) — **200**, not the previous **400**. The model's reply directly referenced the supplied answers ("a week-long nature trip for two at mid-range comfort"), proving `describeAskUserTool()`'s D1-reconstructed projection reached the model correctly — not a browser-resent value.
3. D1 confirmed the original assistant message stayed at `sequence: 2` (updated in place via `replaceMessageParts`, not duplicated) with its tool part now `state: "succeeded"` and the real answers in `output`; the model's follow-up turn landed as a new `sequence: 3` message.
4. A forged continuation (an assistant message id that was never persisted) → `422 "Unknown tool continuation."` A malformed continuation (assistant last message with no answered tool part) → `400`, same as before.

## Tests

- `test/tools.test.ts`: catalog-driven native tool selection across two protocol families, `github_repo` excluded by default, `ask_user` always present.
- `test/conversation-adapters.test.ts`: pending tool-call persists as `input-ready`, a later `tool-result`/`tool-error` merges into the same part, an orphan `tool-result` is ignored, and the UI-part round trip for an answered `ask_user`.
- `test/db/conversations.test.ts`: `replaceMessageParts()` updates an existing message's parts without changing its sequence, and is a no-op (not a cross-conversation write) for a message id that belongs to a different conversation.
- `pnpm context:contract` covers `describeAskUserTool()`'s shape-matching/fallback behavior offline.

## What's deferred

This is a slice of #29, not the whole issue. Explicitly not attempted here:

- **`propose_workflow`** — the chat → non-chat-workflow handoff tool. This depends on #24's workflow registry being reachable/validated from chat and on #15's policy boundary (spend/access) for the "Run" action; wiring a tool that can't yet safely execute anything felt worse than not building it.
- **A formal app-tool registry** (stable key/version, execution class, timeout/step-loop policy, renderer key per tool) — `appTools`/`exampleTools` remain plain objects. Worth building once there's a second stateful/continuation-style tool beyond `ask_user` to generalize from.
- **Tool loop/step count as workflow policy** — `stopWhen: isStepCount(5)` in `app/api/chat/route.ts` is still a hard-coded constant, not a per-workflow policy.
- **Portable source/citation normalization for native web search** — `assistantContentToConversationParts()` now persists a `web_search` tool call/result generically (previously it was dropped exactly like `ask_user` was), but its `output` is whatever raw shape the provider returned, not normalized into `SourcePart`s. Data is no longer lost; it isn't fully portable yet.
- **`ask_user` across a second protocol family, live** — verified against GLM 5.3 Flash (`workers-ai` protocol) end to end; the fix is protocol-agnostic (it doesn't touch protocol dispatch at all — the bug and fix are both in D1 persistence, not model calling), but a second live provider run wasn't repeated in this pass.
