import { describe, expect, it } from "vitest"

import {
  findPersonalData,
  hitId,
  NO_FACTS,
  ownerFactsFrom,
  type OwnerFacts,
  type PersonalKind,
} from "./personal-data"
import { PETS_SPEC } from "./test-vault"

// The personal-data check on what is about to be pushed: each detector,
// the owner's own domains and hosts read from the vault, and quiet on
// ordinary prose, schemas and programs.

const FACTS: OwnerFacts = ownerFactsFrom({
  publicUrl: "https://pcp.kaperkun.de",
  serverAddresses: [
    "https://gaaf.kaperkun.de/api/v1",
    "https://cool.de.plek.je/api/v1",
    "https://plek.je/mcp",
    "https://api.hetzner.cloud/v1",
    "https://api.githubcopilot.com/mcp/",
    "imaps://imap.gmail.com:993",
    "http://bazzite:8080/mcp",
    "http://localhost:3000/mcp",
  ],
  ownAddresses: ["ssh://bob.example-hosting.net:22"],
  emails: ["badpirate@kaperkun.de", "kevin.jones@gmail.com"],
  ownerName: "Kevin Jones",
})

function found(text: string, facts: OwnerFacts = FACTS) {
  return findPersonalData({ "skills/x/SKILL.md": text }, facts).map((hit) => [
    hit.kind,
    hit.match,
  ])
}

function kinds(text: string, facts: OwnerFacts = FACTS): PersonalKind[] {
  return found(text, facts).map(([kind]) => kind as PersonalKind)
}

describe("the owner's facts", () => {
  it("takes their domains from the public address, their mail and servers that share one", () => {
    expect(FACTS.domains).toEqual(["kaperkun.de", "plek.je"])
  })

  it("takes their hosts, and never a vendor's API they merely use", () => {
    expect(FACTS.hosts).toEqual([
      "bazzite",
      "bob.example-hosting.net",
      "cool.de.plek.je",
      "gaaf.kaperkun.de",
      "pcp.kaperkun.de",
      "plek.je",
    ])
    expect(FACTS.hosts).not.toContain("api.hetzner.cloud")
    expect(FACTS.hosts).not.toContain("imap.gmail.com")
    expect(FACTS.hosts).not.toContain("localhost")
  })

  it("takes a host's own name as a label, never a word like api, mail or cool", () => {
    expect(FACTS.labels).toEqual(["bazzite", "gaaf", "plek"])
  })

  it("takes their name and user names, never a mail provider's domain", () => {
    expect(FACTS.names).toEqual(["Jones", "Kevin", "badpirate", "kevin.jones"])
    expect(FACTS.domains).not.toContain("gmail.com")
  })
})

describe("each detector", () => {
  it("finds an email address, but not an example one or a no-reply", () => {
    expect(found("Write to ada.l@lovelace.org for access.", NO_FACTS)).toEqual([
      ["email", "ada.l@lovelace.org"],
    ])
    expect(
      kinds(
        "Send to someone@example.com, noreply@github.com or git@github.com:x/y.",
        NO_FACTS,
      ),
    ).toEqual([])
  })

  it("finds the owner's hosts, anything under their domains, and their machines' names", () => {
    expect(
      found(
        "Runs on https://gaaf.kaperkun.de/api and pay.kaperkun.de; the bazzite box; coolify-gaaf-api.",
      ),
    ).toEqual([
      ["host", "gaaf.kaperkun.de"],
      ["host", "pay.kaperkun.de"],
      ["host", "bazzite"],
      ["host", "gaaf"],
    ])
    expect(kinds("Calls https://api.hetzner.cloud/v1/servers.")).toEqual([])
  })

  it("finds an IP address, but not loopback, documentation ranges, resolvers or versions", () => {
    expect(
      found("The NAS is at 192.168.1.20, the VPS at 49.12.33.7.", NO_FACTS),
    ).toEqual([
      ["ip", "192.168.1.20"],
      ["ip", "49.12.33.7"],
    ])
    expect(
      found(
        "localhost is 127.0.0.1, bind 0.0.0.0, e.g. 192.0.2.10 or 8.8.8.8; release v1.2.3.4 and 1.2.3.4.5.",
        NO_FACTS,
      ),
    ).toEqual([])
    expect(found("Reach it at 2a01:4f8:c17:1a2b::1.", NO_FACTS)).toEqual([
      ["ip", "2a01:4f8:c17:1a2b::1"],
    ])
    expect(kinds("At 12:30:45 every day; ::1 is loopback.", NO_FACTS)).toEqual(
      [],
    )
  })

  it("finds a UUID and a Coolify-style id, but not a nil or textbook example", () => {
    expect(
      found(
        'uuid: "9b2d6c4e-3f1a-4d8e-a7b2-5c9e1f0d3a6b", app ug0ws8kk8w0wkcgsg4wg08cc',
        NO_FACTS,
      ),
    ).toEqual([
      ["id", "9b2d6c4e-3f1a-4d8e-a7b2-5c9e1f0d3a6b"],
      ["id", "ug0ws8kk8w0wkcgsg4wg08cc"],
    ])
    expect(
      kinds(
        "00000000-0000-0000-0000-000000000000 or 123e4567-e89b-12d3-a456-426614174000; internationalizations",
        NO_FACTS,
      ),
    ).toEqual([])
  })

  it("finds a phone number, but not a plain long number", () => {
    expect(found("Call +31 6 1234 5678 or (555) 123-4567.", NO_FACTS)).toEqual([
      ["phone", "+31 6 1234 5678"],
      ["phone", "(555) 123-4567"],
    ])
    expect(
      kinds("maximum: 2147483647, timeout 1234567890 ms, +5 more", NO_FACTS),
    ).toEqual([])
  })

  it("finds a path with a user name in it, but not a generic one", () => {
    expect(
      found(
        "Keys in /home/kevin/.ssh and C:\\Users\\kjones\\Documents; /Users/ada/notes.",
        NO_FACTS,
      ),
    ).toEqual([
      ["home_path", "/home/kevin"],
      ["home_path", "C:\\Users\\kjones"],
      ["home_path", "/Users/ada"],
    ])
    expect(
      kinds("Clone to /home/user/app or /Users/you/code or /root.", NO_FACTS),
    ).toEqual([])
  })

  it("finds what looks like a token", () => {
    expect(
      kinds(
        [
          "ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z",
          "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
          "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
          "Qm9Zx7Lp2Wv8Rt4Yk6Hn3Jd5Fs1Ga0Bc9Ue",
        ].join("\n"),
        NO_FACTS,
      ),
    ).toEqual(["token", "token", "token", "token", "token"])
  })

  it("finds the owner's name, a short one only as written", () => {
    const [kevin, ...others] = findPersonalData(
      { "SKILL.md": "Ask Kevin, or KEVIN; kevinsson is someone else." },
      FACTS,
    )
    expect(others).toEqual([])
    expect(kevin).toMatchObject({ kind: "name", match: "Kevin" })
    expect(kevin!.locations.map((place) => place.column)).toEqual([5, 15])

    const ada = ownerFactsFrom({
      serverAddresses: [],
      emails: [],
      ownerName: "Ada",
    })
    const [hit] = findPersonalData(
      { "SKILL.md": "Ada wrote it; ada is a language." },
      ada,
    )
    expect(hit!.locations).toHaveLength(1)
  })
})

describe("the hits", () => {
  it("are one per text, with every place it is, and an id that stays", () => {
    const hits = findPersonalData(
      {
        "endpoints/x/pcp.yaml": "description: On gaaf.kaperkun.de.\n",
        "endpoints/x/openapi.json":
          '{\n  "servers": [{"url": "https://gaaf.kaperkun.de/api"}]\n}',
      },
      FACTS,
    )

    expect(hits).toEqual([
      {
        id: hitId("host", "gaaf.kaperkun.de"),
        kind: "host",
        match: "gaaf.kaperkun.de",
        label: "One of your own addresses",
        locations: [
          { path: "endpoints/x/openapi.json", line: 2, column: 32 },
          { path: "endpoints/x/pcp.yaml", line: 1, column: 17 },
        ],
      },
    ])
  })

  it("are none in ordinary prose, a schema or a program", () => {
    const files = {
      "skills/release-notes/SKILL.md": [
        "---",
        "name: release-notes",
        "description: Write the release notes for a version.",
        "pcp_format: 2",
        "version: 3",
        "---",
        "",
        "1. List the merged pull requests since the last tag (v1.4.2).",
        "2. Group them by what changed for people: features, fixes, docs.",
        "3. Keep each line under 80 characters, and link the pull request.",
        "Use https://github.com/owner/repo/pulls and the GitHub API.",
        "Times are UTC, e.g. 2026-10-22T09:30:00Z. Retry after 30 seconds.",
      ].join("\n"),
      "endpoints/pets/openapi.json": PETS_SPEC,
      "endpoints/pets/pcp.yaml": [
        "pcp_format: 2",
        "version: 1",
        "name: Pets",
        "description: The pet shop's API.",
        "auth:",
        "  kind: header",
        "  header: X-Api-Key",
        '  template: "{{secret}}"',
      ].join("\n"),
      "wrappers/pet-tools/dogs.js": [
        "// dogs: a tool of the PCP wrapper pet-tools.",
        'const answer = await pcp.call("pets/list_pets", { key: { $secret: "Pets key" }, kind: "dog" })',
        "const getApplicationEnvironmentVariablesByUuid = answer.items.filter((pet) => pet.age > 3)",
        "return { count: getApplicationEnvironmentVariablesByUuid.length, version: '2.10.3' }",
      ].join("\n"),
    }

    expect(findPersonalData(files, FACTS)).toEqual([])
  })
})
