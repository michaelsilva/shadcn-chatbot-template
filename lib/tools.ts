import { anthropic } from "@ai-sdk/anthropic"
import { openai } from "@ai-sdk/openai"
import { tool, type InferUITools, type Tool, type UIDataTypes, type UIMessage } from "ai"
import { z } from "zod"

import type { ModelDefinition, ModelProtocol } from "@/lib/model-catalog"

const githubRepositorySchema = z.object({
  full_name: z.string(),
  description: z.string().nullable(),
  stargazers_count: z.number(),
  forks_count: z.number(),
  open_issues_count: z.number(),
  language: z.string().nullable(),
  html_url: z.string().url(),
})

/**
 * #29: app-owned tools — executed and rendered by this application, with
 * stable app-owned schemas/ids, regardless of which model/provider is
 * selected. `getTools()` always includes these for a tool-capable model.
 */
const appTools = {
  ask_user: tool({
    description:
      "Ask the user clarifying questions when their request is ambiguous. Provide one or more questions, each with exactly 3 short, distinct answer choices. The user can also answer in their own words.",
    inputSchema: z.object({
      questions: z
        .array(
          z.object({
            question: z.string().describe("The question to ask"),
            choices: z
              .array(z.string())
              .length(3)
              .describe("Exactly three short answer choices"),
          })
        )
        .min(1)
        .describe("The questions to ask the user"),
    }),
    outputSchema: z
      .array(z.object({ question: z.string(), answer: z.string() }))
      .describe("The user's answer to each question"),
  }),
}

/**
 * The starter's demo GitHub lookup tool. Not a core product capability
 * (#29) — kept only as an explicit, opt-in example tool, never included
 * in `getTools()`'s default result. `ChatUIMessage`'s type still covers
 * it so `components/chat-message.tsx`'s renderer stays valid for anyone
 * who deliberately enables it.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for `typeof exampleTools` below, deliberately not spread into getTools()'s runtime result.
const exampleTools = {
  github_repo: tool({
    description:
      "Get public stats for a GitHub repository: stars, forks, open issues, language, and description.",
    inputSchema: z.object({
      repo: z
        .string()
        .describe(
          'The repository in "owner/name" format, e.g. "cloudflare/workers-sdk"'
        ),
    }),
    execute: async ({ repo }) => {
      const res = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: { accept: "application/vnd.github+json" },
      })
      if (!res.ok) {
        return { error: `Could not find repository ${repo}.` }
      }
      const data = githubRepositorySchema.parse(await res.json())

      return {
        repo: data.full_name,
        description: data.description ?? "",
        stars: data.stargazers_count,
        forks: data.forks_count,
        openIssues: data.open_issues_count,
        language: data.language ?? "Unknown",
        url: data.html_url,
      }
    },
  }),
}

/**
 * #29: provider-native tool adapters, selected by catalog `protocol` —
 * never by a `modelId.startsWith("openai/")`-style provider-name check.
 * A model whose catalog entry doesn't declare a given native tool class,
 * or whose protocol has no registered adapter, simply doesn't receive
 * that native tool; there is no silent app-owned substitute.
 */
const NATIVE_WEB_SEARCH_ADAPTERS: Partial<Record<ModelProtocol, () => Tool>> = {
  responses: () => openai.tools.webSearch(),
  messages: () => anthropic.tools.webSearch_20260209(),
}

export function getTools(model: Pick<ModelDefinition, "protocol" | "tools">) {
  const tools: Record<string, Tool> = { ...appTools }

  if (model.tools?.nativeTools?.includes("web-search")) {
    const buildWebSearch = NATIVE_WEB_SEARCH_ADAPTERS[model.protocol]
    if (buildWebSearch) tools.web_search = buildWebSearch()
  }

  return tools
}

export type ChatUIMessage = UIMessage<
  unknown,
  UIDataTypes,
  InferUITools<typeof appTools & typeof exampleTools> & {
    web_search: {
      input: { query?: string }
      output: unknown
    }
  }
>

export type ChatMessagePart = ChatUIMessage["parts"][number]

export type TextMessagePart = Extract<ChatMessagePart, { type: "text" }>

export type SourceUrlPart = Extract<ChatMessagePart, { type: "source-url" }>

export type GithubRepoToolPart = Extract<
  ChatMessagePart,
  { type: "tool-github_repo" }
>

export type AskUserToolPart = Extract<
  ChatMessagePart,
  { type: "tool-ask_user" }
>

export type WebSearchToolPart = Extract<
  ChatMessagePart,
  { type: "tool-web_search" }
>
