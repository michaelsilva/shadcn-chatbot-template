import { describe, expect, it } from "vitest"

import { getTools } from "../lib/tools"

describe("getTools (#29: catalog-driven, not provider-name conditionals)", () => {
  it("attaches the OpenAI Responses web-search adapter for a model declaring native web search over the responses protocol", () => {
    const tools = getTools({
      protocol: "responses",
      tools: { appTools: true, nativeTools: ["web-search"] },
    })
    expect(tools.web_search).toBeDefined()
  })

  it("attaches the Anthropic Messages web-search adapter for a model declaring native web search over the messages protocol", () => {
    const tools = getTools({
      protocol: "messages",
      tools: { appTools: true, nativeTools: ["web-search"] },
    })
    expect(tools.web_search).toBeDefined()
  })

  it("never attaches web_search for a model that doesn't declare native web search, even over a protocol with a registered adapter", () => {
    const tools = getTools({
      protocol: "responses",
      tools: { appTools: true },
    })
    expect(tools.web_search).toBeUndefined()
  })

  it("never attaches web_search for a protocol with no registered native adapter, even if the catalog declares the capability", () => {
    const tools = getTools({
      protocol: "workers-ai",
      tools: { appTools: true, nativeTools: ["web-search"] },
    })
    expect(tools.web_search).toBeUndefined()
  })

  it("always includes the app-owned ask_user tool", () => {
    const tools = getTools({ protocol: "workers-ai", tools: { appTools: true } })
    expect(tools.ask_user).toBeDefined()
  })

  it("never includes the starter's github_repo demo tool by default", () => {
    const tools = getTools({
      protocol: "responses",
      tools: { appTools: true, nativeTools: ["web-search"] },
    })
    expect(tools.github_repo).toBeUndefined()
  })
})
