import { describe, expect, it } from "vitest"

import {
  listTools,
  searchEverything,
  searchTools,
  summarize,
  tokenize,
  type ListedTool,
  type ToolCandidate,
} from "./search"

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

describe("listTools", () => {
  const many: ListedTool[] = Array.from({ length: 5 }, (_, index) => ({
    name: `tool_${5 - index}`,
    title: null,
    description: `Does thing ${5 - index}.`,
    access: index === 0 ? "allowed" : "ask",
  }))

  it("names every tool by name order, with its level", () => {
    expect(listTools("porkbun", many).split("\n")).toEqual([
      "porkbun: 5 tools, 1 allowed and 4 ask the owner first.",
      "porkbun/tool_1 [ask] — Does thing 1.",
      "porkbun/tool_2 [ask] — Does thing 2.",
      "porkbun/tool_3 [ask] — Does thing 3.",
      "porkbun/tool_4 [ask] — Does thing 4.",
      "porkbun/tool_5 [allowed] — Does thing 5.",
    ])
  })

  it("pages through a long list without losing a tool", () => {
    const first = listTools("porkbun", many, { size: 2 }).split("\n")
    expect(first[0]).toContain("These are 1–2.")
    expect(first.at(-1)).toBe("More: call list_tools again with offset 2.")

    const seen = [0, 2, 4].flatMap((offset) =>
      listTools("porkbun", many, { offset, size: 2 })
        .split("\n")
        .filter((line) => line.startsWith("porkbun/")),
    )
    expect(seen).toHaveLength(5)
    expect(listTools("porkbun", many, { offset: 4, size: 2 })).not.toContain(
      "More:",
    )
  })

  it("says so for an empty server or an offset past the end", () => {
    expect(listTools("porkbun", [])).toBe("porkbun has no tools you can see.")
    expect(listTools("porkbun", many, { offset: 5 })).toContain(
      "nothing from offset 5",
    )
  })
})

describe("searchEverything", () => {
  const skills = [
    {
      name: "release-notes",
      description: "Write release notes from the merged pull requests.",
    },
    {
      name: "weekly-review",
      description: "Go through the week with the owner.",
    },
  ]
  const memories = [
    {
      path: "/memories/shared/releases.md",
      text: "# Releases\nWe release on Tuesdays.\nRelease notes go in CHANGELOG.md.",
    },
    { path: "/memories/units.md", text: "Metric units." },
  ]

  it("ranks tools, skills and memories by one score, each with its ref", () => {
    const results = searchEverything(
      { tools, skills, memories },
      "release notes",
    )

    expect(results.map((result) => result.ref).slice(0, 2)).toEqual([
      "skill:release-notes",
      "/memories/shared/releases.md",
    ])
    expect(results[0]).toMatchObject({
      kind: "skill",
      description: "Write release notes from the merged pull requests.",
    })
    // A memory's line is the one that says most of what was asked about.
    expect(results[1]).toMatchObject({
      kind: "memory",
      description: "Release notes go in CHANGELOG.md.",
    })

    const pulls = searchEverything(
      { tools, skills, memories },
      "pull requests",
    ).map((result) => `${result.kind} ${result.ref}`)
    expect(pulls.slice(0, 2)).toEqual([
      "tool github/list_pull_requests",
      "skill skill:release-notes",
    ])
  })

  it("keeps to one kind, or to one server's tools", () => {
    const query = "release notes pull requests"

    expect(
      searchEverything({ tools, skills, memories }, query, {
        kind: "skill",
      }).map((result) => result.kind),
    ).toEqual(["skill"])
    expect(
      searchEverything({ tools, skills, memories }, query, {
        server: "github",
      }).every((result) => result.ref.startsWith("github/")),
    ).toBe(true)
  })

  it("lists the skills, then the tools, for a query with nothing to rank by", () => {
    const results = searchEverything({ tools, skills, memories }, "the", {
      limit: 3,
    })

    expect(results.map((result) => result.ref)).toEqual([
      "skill:release-notes",
      "skill:weekly-review",
      "github/create_issue",
    ])
  })
})
