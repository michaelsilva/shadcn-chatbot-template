import { anthropic } from "@ai-sdk/anthropic"
import { openai } from "@ai-sdk/openai"
import { tool, type InferUITools, type UIDataTypes, type UIMessage } from "ai"
import { z } from "zod"

const githubRepositorySchema = z.object({
  full_name: z.string(),
  description: z.string().nullable(),
  stargazers_count: z.number(),
  forks_count: z.number(),
  open_issues_count: z.number(),
  language: z.string().nullable(),
  html_url: z.string().url(),
})

const baseTools = {
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

export function getTools(modelId: string) {
  if (modelId.startsWith("openai/")) {
    return { ...baseTools, web_search: openai.tools.webSearch() }
  }
  if (modelId.startsWith("anthropic/")) {
    return { ...baseTools, web_search: anthropic.tools.webSearch_20260209() }
  }
  return baseTools
}

export type ChatUIMessage = UIMessage<
  unknown,
  UIDataTypes,
  InferUITools<typeof baseTools> & {
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
