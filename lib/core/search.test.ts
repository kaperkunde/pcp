import { describe, expect, it } from "vitest"

import {
  clientPrefixed,
  describeOwnTool,
  listTools,
  normalName,
  PCP_TOOL_NOTE,
  searchEverything,
  searchTools,
  summarize,
  tokenize,
  type ListedTool,
  type PcpToolCandidate,
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

describe("PCP's own tools in search (#41)", () => {
  // As the field report had them: a server whose description says it hosts
  // PCP, tools named like PCP's on other servers, and PCP's own.
  const upstream: ToolCandidate[] = [
    {
      server: "bazzite",
      serverName: "Bazzite",
      serverDescription:
        "My local gaming machine runs my arr stack, as well as hosts this PCP server",
      name: "run_command",
      title: "Run a command",
      description: "Run one command on the machine and answer its output.",
    },
    {
      server: "coolify",
      serverName: "Coolify",
      serverDescription: "Deployments.",
      name: "check-server-registry-login",
      title: null,
      description: "Check whether a server is logged in to a registry.",
    },
    {
      server: "porkbun",
      serverName: "Porkbun",
      serverDescription: "Domains.",
      name: "check_domain",
      title: "Check a domain",
      description: "Check whether a domain is free, and its price.",
    },
  ]
  const pcp: PcpToolCandidate[] = [
    {
      name: "check_permission",
      title: "Check a permission request",
      description:
        "Whether the owner has answered a request, and its answer once they have.",
    },
    {
      name: "withdraw_request",
      title: "Withdraw a request",
      description: "Take back a request you no longer need.",
    },
    {
      name: "run_code",
      title: "Run code",
      description: "Run a program that calls the owner's tools.",
    },
    {
      name: "delete_wrapper",
      title: "Delete a wrapper",
      description:
        "Propose deleting a wrapper on PCP's page; call check_permission once the owner says they answered.",
    },
  ]
  const refs = (query: string, options = {}) =>
    searchEverything({ tools: upstream, pcp }, query, options).map(
      (result) => `${result.kind} ${result.ref}`,
    )

  it("ranks an exact name first, PCP's own tools included", () => {
    expect(refs("check_permission PCP")[0]).toBe("pcp check_permission")
    expect(refs("run_code")[0]).toBe("pcp run_code")
    expect(refs("withdraw")[0]).toBe("pcp withdraw_request")
    expect(refs("porkbun/check_domain")[0]).toBe("tool porkbun/check_domain")
  })

  it("matches a name whatever its case and separators", () => {
    expect(normalName("Check-Permission")).toBe("check_permission")
    expect(normalName("checkPermission")).toBe("check_permission")
    expect(refs("Check permission")[0]).toBe("pcp check_permission")
    expect(refs("check server registry login")[0]).toBe(
      "tool coolify/check-server-registry-login",
    )
    expect(refs("coolify/check_server_registry_login")[0]).toBe(
      "tool coolify/check-server-registry-login",
    )
  })

  it("takes an app's prefix off a name", () => {
    expect(refs("mcp__PCP_Bazzite__run_code")[0]).toBe("pcp run_code")
    expect(refs("mcp__claude_ai_PCP__withdraw_request")[0]).toBe(
      "pcp withdraw_request",
    )
    expect(
      clientPrefixed("mcp__PCP_Bazzite__run_code", ["run_code", "search"]),
    ).toEqual({ prefix: "mcp__PCP_Bazzite__", name: "run_code" })
    expect(clientPrefixed("run_code", ["run_code"])).toBeNull()
    expect(clientPrefixed("mcp__PCP__nothing", ["run_code"])).toBeNull()
  })

  it("does not let a server described as PCP outrank the tools a word names", () => {
    const pcpRun = refs("PCP run")
    expect(pcpRun[0]).toBe("pcp run_code")
    expect(pcpRun.indexOf("tool bazzite/run_command")).toBeGreaterThan(0)

    // Words only a server's description has still find its tools.
    expect(refs("arr stack")).toEqual(["tool bazzite/run_command"])
    expect(searchTools(upstream, "PCP")[0]?.name).toBe("run_command")
  })

  it("says how to call one of PCP's own tools, and finds it by name, not its description", () => {
    const [first] = searchEverything(
      { tools: upstream, pcp },
      "check_permission",
    )
    expect(first).toMatchObject({
      kind: "pcp",
      ref: "check_permission",
      title: "Check a permission request",
    })
    expect(first!.description.endsWith(PCP_TOOL_NOTE)).toBe(true)

    // delete_wrapper's description names check_permission; its name does not.
    expect(refs("owner answered")).not.toContain("pcp delete_wrapper")
    expect(refs("check_permission PCP")).not.toContain("pcp delete_wrapper")
  })

  it("keeps to kind pcp, and leaves PCP's tools out of kind tool and of a server", () => {
    expect(refs("check", { kind: "pcp" })).toEqual(["pcp check_permission"])
    expect(
      refs("check", { kind: "tool" }).every((ref) => ref.startsWith("tool ")),
    ).toBe(true)
    expect(refs("run_code", { server: "bazzite" })).toEqual([
      "tool bazzite/run_command",
    ])
    // With nothing to rank by, PCP's tools are listed only when asked for.
    expect(refs("")).not.toContain("pcp run_code")
    expect(refs("", { kind: "pcp" })).toHaveLength(4)
  })

  it("describes one of PCP's tools with its schemas and no call_handle", () => {
    const said = JSON.parse(
      describeOwnTool(
        {
          ...pcp[0]!,
          inputSchema: { type: "object", additionalProperties: false },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        "a note",
      ),
    )

    expect(Object.keys(said)[0]).toBe("note")
    expect(said).toMatchObject({
      tool: "check_permission",
      kind: "pcp",
      inputSchema: { type: "object" },
    })
    expect(said.call).toContain("not through call_tool")
    expect(said.call_handle).toBeUndefined()
    expect(said.outputSchema).toBeUndefined()
  })
})
