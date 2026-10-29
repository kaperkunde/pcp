import { describe, expect, it } from "vitest"

import type {
  EndpointDocument,
  ServerDocument,
  ServiceDocument,
  SkillDocument,
  WrapperDocument,
} from "./documents"
import { reviewItem, type FlagKind } from "./review"
import { parseServiceDefinition } from "../services/definition"
import { DOCLING } from "./test-vault"

// What the owner is shown before an item from a repository is applied: one
// case for each thing that would reach further, and the text-only change
// sync may make by itself.

const SKILL: SkillDocument = {
  kind: "skill",
  name: "release-notes",
  version: 3,
  description: "Write release notes.",
  body: "1. List the changes.",
  tools: ["github/list_pull_requests"],
  extra: { license: "MIT" },
  files: [{ path: "style.md", text: "Short sentences." }],
}

const WRAPPER: WrapperDocument = {
  kind: "wrapper",
  name: "pet-tools",
  version: 1,
  displayName: "Pet tools",
  description: "Pets, simpler.",
  callLevels: "token",
  tools: [
    {
      name: "dogs",
      title: null,
      description: "Lists the dogs.",
      inputSchema: { type: "object" },
      annotations: null,
      calls: ["pets/list_pets"],
      replaces: [],
      program: "return 1",
    },
  ],
  secrets: [
    {
      secret: "Pets key",
      tool: "pets/list_pets",
      argument: "/key",
      template: "{{secret}}",
    },
  ],
}

const ENDPOINT: EndpointDocument = {
  kind: "endpoint",
  name: "pets",
  version: 1,
  displayName: "Pets",
  description: "The pet shop.",
  instance: null,
  spec: { format: "json", text: '{"openapi": "3.0.3"}' },
  patches: [],
  toolDescriptions: {},
  auth: {
    kind: "header",
    header: "X-Api-Key",
    template: "{{secret}}",
    secret: "Pets key",
    headers: [],
  },
}

const SERVER: ServerDocument = {
  kind: "server",
  name: "docs",
  version: 1,
  displayName: "Docs",
  description: "Documents.",
  instance: null,
  auth: { kind: "none" },
}

function kinds(flags: Array<{ kind: FlagKind }>): FlagKind[] {
  return flags.map((flag) => flag.kind)
}

describe("reviewing an item", () => {
  it("finds nothing in an item that is the same, and calls it text", () => {
    const review = reviewItem(SKILL, SKILL)
    expect(review).toMatchObject({ same: true, flags: [], textOnly: true })
    expect(review.files.every((file) => file.change === "same")).toBe(true)
  })

  it("diffs every file line by line, a new file all added", () => {
    const review = reviewItem(SKILL, {
      ...SKILL,
      version: 4,
      body: "1. List the changes.\n2. Say why.",
      files: [
        { path: "style.md", text: "Short sentences." },
        { path: "words.md", text: "Plain words." },
      ],
    })
    const md = review.files.find((file) => file.path.endsWith("SKILL.md"))!
    expect(md.change).toBe("changed")
    expect(md.diff).toContainEqual({ kind: "added", text: "2. Say why." })
    expect(md.diff).toContainEqual({ kind: "removed", text: "version: 3" })
    expect(review.files.find((file) => file.path.endsWith("words.md"))).toEqual(
      {
        path: "skills/release-notes/words.md",
        change: "added",
        diff: [{ kind: "added", text: "Plain words." }],
      },
    )
  })

  it("lets a skill's description, steps and files through as text", () => {
    expect(
      reviewItem(SKILL, {
        ...SKILL,
        version: 4,
        description: "Write the release notes.",
        body: "Other steps.",
        files: [],
      }),
    ).toMatchObject({ flags: [], textOnly: true, same: false })
  })

  it("does not call text a new skill, other tools' keys, fewer tools, or a new name", () => {
    expect(reviewItem(null, { ...SKILL, tools: [] }).textOnly).toBe(false)
    expect(
      reviewItem(SKILL, { ...SKILL, extra: { license: "GPL" } }).textOnly,
    ).toBe(false)
    expect(reviewItem(SKILL, { ...SKILL, tools: [] }).textOnly).toBe(false)
    expect(reviewItem(SKILL, { ...SKILL, name: "other-notes" }).textOnly).toBe(
      false,
    )
  })

  it("flags a skill's new tools", () => {
    const review = reviewItem(SKILL, {
      ...SKILL,
      tools: [...SKILL.tools, "github/merge_pull_request"],
    })
    expect(kinds(review.flags)).toEqual(["skill_tools"])
    expect(review.flags[0]!.message).toContain("github/merge_pull_request")
    expect(review.textOnly).toBe(false)
  })

  it("flags a changed program, and a new tool's", () => {
    const changed = reviewItem(WRAPPER, {
      ...WRAPPER,
      tools: [{ ...WRAPPER.tools[0]!, program: "return 2" }],
    })
    expect(kinds(changed.flags)).toEqual(["program"])
    expect(changed.flags[0]!.path).toBe("wrappers/pet-tools/dogs.js")

    const added = reviewItem(WRAPPER, {
      ...WRAPPER,
      tools: [
        ...WRAPPER.tools,
        { ...WRAPPER.tools[0]!, name: "cats", calls: ["pets/list_pets"] },
      ],
    })
    expect(kinds(added.flags)).toEqual(["program", "calls"])
  })

  it("flags new calls", () => {
    const review = reviewItem(WRAPPER, {
      ...WRAPPER,
      tools: [
        { ...WRAPPER.tools[0]!, calls: ["pets/list_pets", "pets/add_pet"] },
      ],
    })
    expect(kinds(review.flags)).toEqual(["calls"])
    expect(review.flags[0]!.message).toContain("pets/add_pet")
    // Fewer calls reach less.
    expect(
      reviewItem(
        {
          ...WRAPPER,
          tools: [{ ...WRAPPER.tools[0]!, calls: ["a/b", "c/d"] }],
        },
        { ...WRAPPER, tools: [{ ...WRAPPER.tools[0]!, calls: ["a/b"] }] },
      ).flags,
    ).toEqual([])
  })

  it("flags calls that stop following the token's levels", () => {
    expect(
      kinds(reviewItem(WRAPPER, { ...WRAPPER, callLevels: "approved" }).flags),
    ).toEqual(["call_levels"])
  })

  it("flags a new or changed secret binding", () => {
    expect(
      kinds(
        reviewItem(WRAPPER, {
          ...WRAPPER,
          secrets: [{ ...WRAPPER.secrets[0]!, argument: "/other" }],
        }).flags,
      ),
    ).toEqual(["secret_binding"])
    expect(
      kinds(
        reviewItem(WRAPPER, {
          ...WRAPPER,
          secrets: [
            ...WRAPPER.secrets,
            { ...WRAPPER.secrets[0]!, secret: "Other key", argument: "/x" },
          ],
        }).flags,
      ),
    ).toEqual(["secret_binding"])
  })

  it("flags everything a new wrapper can do", () => {
    expect(kinds(reviewItem(null, WRAPPER).flags)).toEqual([
      "program",
      "calls",
      "secret_binding",
    ])
  })

  it("never flags an instance's own address, switches or sign-in on a server the vault has", () => {
    // What a format-1 document says of its instance is never written over
    // the vault's server, so it reaches nothing further.
    const endpoint = reviewItem(ENDPOINT, {
      ...ENDPOINT,
      instance: {
        url: "https://evil.example",
        readOnly: false,
        publicOnly: false,
      },
      auth: { kind: "basic", username: "ada", secret: "Other key" },
    })
    expect(endpoint.flags).toEqual([])
    const server = reviewItem(SERVER, {
      ...SERVER,
      instance: { url: "https://evil.example/mcp", publicOnly: false },
      auth: {
        kind: "oauth",
        clientId: "theirs",
        clientSecret: null,
        scope: null,
        authorizeParams: null,
      },
    })
    expect(server.flags).toEqual([])
  })

  it("flags a changed OpenAPI document, or changed edits to it", () => {
    expect(
      kinds(
        reviewItem(ENDPOINT, {
          ...ENDPOINT,
          spec: { format: "json", text: '{"openapi": "3.1.0"}' },
        }).flags,
      ),
    ).toEqual(["spec"])
    expect(
      kinds(
        reviewItem(ENDPOINT, {
          ...ENDPOINT,
          patches: [{ op: "remove", path: "/servers" }],
        }).flags,
      ),
    ).toEqual(["spec"])
  })

  it("flags how a new endpoint or MCP server signs in", () => {
    expect(kinds(reviewItem(null, ENDPOINT).flags)).toEqual(["spec", "auth"])
    expect(
      reviewItem(null, ENDPOINT).flags.find((flag) => flag.kind === "auth")
        ?.message,
    ).toBe("It signs in with a secret in X-Api-Key.")
    expect(kinds(reviewItem(null, SERVER).flags)).toEqual([])
    expect(
      kinds(
        reviewItem(null, {
          ...SERVER,
          auth: {
            kind: "oauth",
            clientId: null,
            clientSecret: null,
            scope: "docs",
            authorizeParams: null,
          },
        }).flags,
      ),
    ).toEqual(["server_auth"])
  })
  it("flags characters that do not show on screen anywhere", () => {
    const review = reviewItem(ENDPOINT, {
      ...ENDPOINT,
      spec: {
        format: "json",
        text: '{"openapi": "3.0.3", "info": {"description": "ok​"}}',
      },
    })
    expect(kinds(review.flags)).toEqual(["spec", "hidden_characters"])
    expect(review.flags[1]!.path).toBe("endpoints/pets/openapi.json")
  })

  it("refuses to compare items of different kinds", () => {
    expect(() =>
      reviewItem(SKILL, { ...SERVER, name: "release-notes" }),
    ).toThrow(/is a server/)
    // A wrapper that becomes a flow is still a wrapper.
    expect(() =>
      reviewItem(WRAPPER, { ...WRAPPER, kind: "flow" }),
    ).not.toThrow()
  })
})

describe("reviewing a service", () => {
  const SERVICE: ServiceDocument = {
    kind: "service",
    name: "docling",
    version: 1,
    displayName: "Docling",
    description: "Documents to Markdown.",
    definition: parseServiceDefinition(DOCLING),
  }

  it("lists all of a new service: its image, ports, variables, health and what it registers", () => {
    const review = reviewItem(null, SERVICE)
    const messages = review.flags.map((flag) => flag.message)

    expect(review.isNew).toBe(true)
    expect(review.textOnly).toBe(false)
    expect(review.files.map((file) => file.path)).toEqual([
      "services/docling.yaml",
    ])
    expect(messages).toEqual(
      expect.arrayContaining([
        `It runs the image ${DOCLING.image}.`,
        "An update pulls ghcr.io/docling-project/docling-serve-cpu:latest.",
        "It listens on port 5001.",
        "Its variables: DOCLING_SERVE_API_KEY (needed), DOCLING_SERVE_ENABLE_UI=false.",
        "Its health check is GET /health on port 5001.",
        "PCP adds an API endpoint from /openapi.json on port 5001, sending DOCLING_SERVE_API_KEY's secret in X-Api-Key.",
      ]),
    )
  })

  it("flags only what changes, and never calls a service's change text", () => {
    expect(reviewItem(SERVICE, SERVICE)).toMatchObject({
      same: true,
      flags: [],
    })

    const image = `ghcr.io/docling-project/docling-serve-cpu@sha256:${"d".repeat(64)}`
    const newer = reviewItem(SERVICE, {
      ...SERVICE,
      version: 2,
      definition: { ...SERVICE.definition, image },
    })
    expect(kinds(newer.flags)).toEqual(["service_image"])
    expect(newer.flags[0]!.message).toContain(`(was ${DOCLING.image})`)
    expect(newer.textOnly).toBe(false)

    const volumes = reviewItem(SERVICE, {
      ...SERVICE,
      definition: {
        ...SERVICE.definition,
        volumes: [{ name: "cache", path: "/opt/cache" }],
      },
    })
    expect(volumes.flags.map((flag) => flag.message)).toEqual([
      "It keeps data in named volumes: cache at /opt/cache.",
    ])

    const described = reviewItem(SERVICE, {
      ...SERVICE,
      description: "Other words.",
    })
    expect(described.flags).toEqual([])
    expect(described.textOnly).toBe(false)
  })
})
