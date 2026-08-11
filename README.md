# Chatbot Template

A minimal chatbot template built with Next.js, the [AI SDK](https://ai-sdk.dev), [shadcn/ui](https://ui.shadcn.com), [shadcn/react](https://ui.shadcn.com/docs/react/message-scroller), and [shadcn/typeset](https://ui.shadcn.com/docs/typeset), powered by [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) on [Cloudflare Workers](https://developers.cloudflare.com/workers/).

## Features

- Streaming chat with markdown rendering and shadcn/typeset
- Tool calling example
- Cloudflare AI Gateway routing for Workers AI, Anthropic, and OpenAI models
- Human-in-the-loop questionnaire. The model can ask clarifying questions, answered with the shadcn questionnaire component

## Deploy to Cloudflare

The project uses the [OpenNext Cloudflare adapter](https://opennext.js.org/cloudflare) and a pre-authenticated Workers AI binding, so no Cloudflare API token or provider key is stored in the application.

Authenticate Wrangler once, then install, generate binding types, and deploy:

```bash
pnpm exec wrangler login
pnpm install
pnpm cf-typegen
pnpm deploy
```

Wrangler prints the deployed `workers.dev` URL. The configured `default` gateway is created automatically on its first AI request. GLM 4.7 Flash runs through Workers AI within the account's Workers AI allocation. The included OpenAI and Anthropic models use [Cloudflare Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) and require AI Gateway credits.

## Local development

```bash
pnpm install
```

Start the dev server:

```bash
pnpm dev
```

The AI binding is configured as a remote binding, so local chat requests use the Cloudflare account selected by Wrangler and may incur model charges. Use `pnpm preview` for a production build running in the local Workers runtime.

## Configuration

Non-secret Cloudflare configuration lives in [wrangler.jsonc](wrangler.jsonc). `CLOUDFLARE_AI_GATEWAY_ID` defaults to `default`, and the model allowlist lives in [lib/models.ts](lib/models.ts), where the first entry is the default model.

After changing Wrangler bindings or variables, run `pnpm cf-typegen` to refresh [cloudflare-env.d.ts](cloudflare-env.d.ts).

## How it works

- [app/page.tsx](app/page.tsx) renders the configured model allowlist.
- [app/api/chat/route.ts](app/api/chat/route.ts) reads the Workers AI binding and streams responses with `streamText`.
- [lib/ai.ts](lib/ai.ts) routes Workers AI and provider-native OpenAI or Anthropic requests through Cloudflare AI Gateway's pre-authenticated binding.
- [components/chat.tsx](components/chat.tsx) renders the conversation with `useChat` and shadcn chat primitives.
- [lib/tools.ts](lib/tools.ts) defines the tools: a server-executed GitHub repo lookup, the interactive `ask_user` questionnaire, and provider-native web search.

## Tool parts

Assistant messages are a list of typed parts. [components/chat-message.tsx](components/chat-message.tsx) switches on `part.type` and delegates each one to a component in [components/parts/](components/parts):

| Part type          | Component                                                          | Renders                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`             | [text-part.tsx](components/parts/text-part.tsx)                   | Markdown via react-markdown and shadcn/typeset.                                                                                                |
| `tool-github_repo` | [github-repo-part.tsx](components/parts/github-repo-part.tsx)     | A spinner while the lookup runs, then a linked stat line (stars, forks, language).                                                             |
| `tool-web_search`  | [web-search-part.tsx](components/parts/web-search-part.tsx)       | A "Searching the web…" status while the search runs, then a persistent "Searched the web" line per search.                                     |
| `tool-ask_user`    | [ask-user-part.tsx](components/parts/ask-user-part.tsx)           | The answered questions inline. Pending questions render in [question-card.tsx](components/question-card.tsx), pinned to the scroller bottom.   |
| `source-url`       | [sources-part.tsx](components/parts/sources-part.tsx)             | Web search citations, deduped into a "Searched N websites" drawer once the message finishes streaming.                                         |

Tool parts move through states as the stream progresses — `input-streaming` → `input-available` → `output-available` (or `output-error`) — and each component switches on `part.state` to show progress, results, and failures.

### Adding your own tool

1. Define the tool in [lib/tools.ts](lib/tools.ts) with a `description`, an `inputSchema`, and an `execute` function (omit `execute` for tools the user answers in the UI, like `ask_user`).
2. Add a part component in [components/parts/](components/parts) and a `case "tool-<name>"` in [chat-message.tsx](components/chat-message.tsx).

Message types are inferred from the tool definitions via `InferUITools`, so `part.input` and `part.output` are fully typed in your part component — renaming a tool field is a build error, not a silent `undefined`.

## Adding components

```bash
pnpm dlx shadcn@latest add button
```

## License

MIT — see [LICENSE](LICENSE).
