import { describe, expect, it } from "vitest"

import { searchTools, summarize, tokenize, type ToolCandidate } from "./search"

const tools: ToolCandidate[] = [
  {
    server: "github",
    serverName: "GitHub",
    serverDescription: "Code hosting: repositories, issues and pull requests.",
    name: "create_issue",
    title: "Create an issue",
    description: "Open a new issue in a repository.",
  },
  {
    server: "github",
    serverName: "GitHub",
    serverDescription: "Code hosting: repositories, issues and pull requests.",
    name: "list_pull_requests",
    title: null,
    description: "List pull requests in a repository, newest first.",
  },
  {
    server: "notion",
    serverName: "Notion",
    serverDescription: "Notes and databases.",
    name: "searchPages",
    title: "Search pages",
    description: "Full-text search over the workspace's pages.",
  },
  {
    server: "mail",
    serverName: "Mail",
    serverDescription: "The owner's mailbox.",
    name: "send",
    title: "Send an email",
    description:
      "Sends an email. Asks for confirmation on large recipient lists.",
  },
]

describe("searchTools", () => {
  it("finds a tool by what it does, not only by its name", () => {
    expect(searchTools(tools, "open a github issue")[0]?.name).toBe(
      "create_issue",
    )
    expect(searchTools(tools, "send email")[0]?.name).toBe("send")
    expect(searchTools(tools, "pull requests")[0]?.name).toBe(
      "list_pull_requests",
    )
  })

  it("splits camelCase names and stems plurals", () => {
    expect(searchTools(tools, "page search")[0]?.name).toBe("searchPages")
    expect(searchTools(tools, "issues")[0]?.name).toBe("create_issue")
  })

  it("ranks an exact name first and scopes to a server", () => {
    expect(searchTools(tools, "github/create_issue")[0]?.name).toBe(
      "create_issue",
    )
    const scoped = searchTools(tools, "list", { server: "notion" })
    expect(scoped.every((match) => match.server === "notion")).toBe(true)
  })

  it("lists everything, in order, for an empty query", () => {
    const all = searchTools(tools, "  ", { limit: 10 })
    expect(all.map((match) => `${match.server}/${match.name}`)).toEqual([
      "github/create_issue",
      "github/list_pull_requests",
      "mail/send",
      "notion/searchPages",
    ])
    expect(searchTools(tools, "", { limit: 2 })).toHaveLength(2)
  })

  it("drops tools that match nothing", () => {
    expect(searchTools(tools, "kubernetes")).toEqual([])
  })
})

describe("helpers", () => {
  it("tokenizes names the way people type them", () => {
    expect(tokenize("listPullRequests")).toEqual(["list", "pull", "requests"])
    expect(tokenize("create_issue v2")).toEqual(["create", "issue", "v2"])
  })

  it("summarizes to one sentence within the limit", () => {
    expect(summarize("Sends an email. Asks for confirmation.")).toBe(
      "Sends an email.",
    )
    expect(summarize("x".repeat(200), 50)).toHaveLength(50)
    expect(summarize("First line\nSecond line")).toBe("First line")
  })
})
