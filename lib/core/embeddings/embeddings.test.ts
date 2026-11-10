import http from "node:http"
import type { AddressInfo } from "node:net"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { defaultEmbedded, looksSelfHosted } from "../constants"
import type { VaultContext } from "../context"
import { db } from "../db"
import { searchEverything, semanticBoosts, semanticKey } from "../search"
import { createSecret } from "../secrets"
import { scratchDatabase } from "../test-db"
import { embeddingProvider } from "../upstream"
import { setupVault } from "../vault"
import {
  checkEmbeddingsConfig,
  embeddingsUrl,
  readEmbeddingsConfig,
  writeEmbeddingsConfig,
  type EmbeddingsConfig,
} from "./config"
import {
  cosine,
  itemsToEmbed,
  pruneEmbeddingVectors,
  searchSimilarities,
  semanticScores,
  type SearchItems,
} from "./index"
import { readVectors, type EmbeddingProvider } from "./provider"

// Search's embeddings (#61): what is sent, the encrypted cache, the blend
// with keywords, and keywords alone whenever the provider fails.

const WORDS = [
  "file",
  "store",
  "upload",
  "container",
  "launch",
  "service",
  "mail",
  "issue",
  "note",
  "release",
]

/**
 * A provider that embeds by the words a text has from WORDS (and their
 * near forms), counting every call. `fail` makes the next calls of a
 * kind throw; `hang` makes them wait for their signal.
 */
function fakeProvider(fingerprint = "fake\nmodel") {
  const calls: Array<{ texts: string[]; input: string }> = []
  const state = { fail: null as null | "query" | "document" | "all" }
  const state2 = { hang: false }
  const provider: EmbeddingProvider = {
    fingerprint,
    async embed(texts, input, signal) {
      calls.push({ texts, input })

      if (state.fail === "all" || state.fail === input) {
        throw new Error("provider down")
      }

      if (state2.hang) {
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        )
      }

      return texts.map((text) => {
        const lower = text.toLowerCase()
        return Float32Array.from([
          ...WORDS.map((word) => (lower.includes(word.slice(0, 4)) ? 1 : 0)),
          0.01,
        ])
      })
    },
  }

  return { provider, calls, state, state2 }
}

const ITEMS: SearchItems = {
  tools: [
    {
      server: "files",
      serverName: "Files",
      serverDescription: "A file store.",
      name: "put",
      title: null,
      description: "Upload a file to keep it.",
    },
    {
      server: "github",
      serverName: "GitHub",
      serverDescription: "",
      name: "create_issue",
      title: "Create an issue",
      description: "Open a new issue.",
    },
  ],
  pcp: [
    {
      name: "register_server",
      title: "Add a server",
      description: "Propose a new server, or a service to launch.",
    },
  ],
  skills: [{ name: "release-notes", description: "Write release notes." }],
  memories: [{ path: "/memories/notes.md", text: "Private note on mail." }],
}

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
})

describe("what is embedded", () => {
  it("sends only the kinds the owner chose", () => {
    const toolsOnly = itemsToEmbed(ITEMS, {
      tools: true,
      skills: false,
      memories: false,
    })

    expect(toolsOnly.map((item) => item.key)).toEqual([
      "tool files/put",
      "tool github/create_issue",
      "pcp register_server",
    ])
    expect(toolsOnly.map((item) => item.text).join("\n")).not.toMatch(
      /release notes|Private note/,
    )
    // A server's description is not sent with its tools.
    expect(toolsOnly[0]!.text).toBe(
      "put (files/put): Upload a file to keep it.",
    )

    const everything = itemsToEmbed(ITEMS, {
      tools: true,
      skills: true,
      memories: true,
    })
    expect(everything.map((item) => item.key)).toContain(
      "skill skill:release-notes",
    )
    expect(everything.map((item) => item.key)).toContain(
      "memory /memories/notes.md",
    )
  })

  it("defaults to tools alone for a provider elsewhere, everything for the owner's own", () => {
    expect(defaultEmbedded("voyage")).toEqual({
      tools: true,
      skills: false,
      memories: false,
    })
    expect(defaultEmbedded("openai", "https://api.openai.com/v1")).toEqual({
      tools: true,
      skills: false,
      memories: false,
    })
    expect(defaultEmbedded("openai", "http://192.168.1.20:8080")).toEqual({
      tools: true,
      skills: true,
      memories: true,
    })
    expect(defaultEmbedded("endpoint")).toEqual({
      tools: true,
      skills: true,
      memories: true,
    })
    expect(looksSelfHosted("http://ollama.local:11434")).toBe(true)
    expect(looksSelfHosted("http://localhost:8080")).toBe(true)
    expect(looksSelfHosted("http://100.101.1.2")).toBe(true)
    expect(looksSelfHosted("https://example.com")).toBe(false)
    expect(looksSelfHosted("not a url")).toBe(false)
  })
})

describe("the cache", () => {
  const items = itemsToEmbed(ITEMS, {
    tools: true,
    skills: true,
    memories: true,
  })

  it("embeds each text once, keeps it encrypted, and ranks by nearness", async () => {
    const { provider, calls } = fakeProvider()

    const first = await semanticScores(ctx, provider, items, "store a file")
    expect(first?.get("tool files/put")).toBeGreaterThan(
      first!.get("tool github/create_issue")!,
    )
    expect(calls.filter((call) => call.input === "document")).toHaveLength(1)
    expect(await db().embeddingVector.count()).toBe(items.length)

    const rows = await db().embeddingVector.findMany()
    for (const row of rows) {
      const stored = Buffer.from(row.ciphertext).toString("latin1")
      expect(stored).not.toContain("Upload")
      // The hash is keyed: not a plain SHA-256 of anything sent.
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/)
    }

    calls.length = 0
    const again = await semanticScores(ctx, provider, items, "launch")
    expect(again?.size).toBe(items.length)
    expect(calls.map((call) => call.input)).toEqual(["query"])
  })

  it("embeds a changed text again, and another provider's apart", async () => {
    const { provider, calls } = fakeProvider()
    await semanticScores(ctx, provider, items, "file")

    calls.length = 0
    const changed = items.map((item) =>
      item.key === "tool files/put"
        ? { ...item, text: "put: Upload a container image." }
        : item,
    )
    await semanticScores(ctx, provider, changed, "file")
    expect(calls.find((call) => call.input === "document")?.texts).toEqual([
      "put: Upload a container image.",
    ])

    const other = fakeProvider("other\nmodel")
    await semanticScores(ctx, other.provider, items, "file")
    expect(
      other.calls.find((call) => call.input === "document")?.texts,
    ).toHaveLength(items.length)
  })

  it("goes on with what it has when the items cannot be embedded", async () => {
    const { provider, state } = fakeProvider()
    state.fail = "document"

    const scores = await semanticScores(ctx, provider, items, "file")
    expect(scores?.size).toBe(0)
    expect(await db().embeddingVector.count()).toBe(0)
  })

  it("answers null, for keywords alone, when the query fails or takes too long", async () => {
    const { provider, state, state2 } = fakeProvider()
    state.fail = "query"
    expect(await semanticScores(ctx, provider, items, "file")).toBeNull()

    state.fail = null
    state2.hang = true
    expect(
      await semanticScores(ctx, provider, items, "file", {
        queryTimeoutMs: 20,
        itemsTimeoutMs: 20,
      }),
    ).toBeNull()
  })

  it("is removed by the cleanup once unused, and with a new provider", async () => {
    const { provider } = fakeProvider()
    await semanticScores(ctx, provider, items, "file")
    const count = items.length

    expect(await pruneEmbeddingVectors(new Date())).toBe(0)
    expect(
      await pruneEmbeddingVectors(new Date(Date.now() + 31 * 86_400_000)),
    ).toBe(count)

    await semanticScores(ctx, provider, items, "file")
    const secret = await createSecret(ctx, { name: "voyage", value: "k" })
    await writeEmbeddingsConfig(ctx, {
      provider: "voyage",
      model: "voyage-3.5-lite",
      secretId: secret.id,
      embed: { tools: true, skills: false, memories: false },
    })
    expect(await db().embeddingVector.count()).toBe(0)
  })
})

describe("blending with keywords", () => {
  it("lifts what is near and brings in what no keyword found", () => {
    const similarities = new Map([
      [semanticKey("pcp", "register_server"), 0.9],
      [semanticKey("tool", "files/put"), 0.3],
      [semanticKey("tool", "github/create_issue"), 0.2],
    ])
    const results = searchEverything(ITEMS, "spin a vm", { similarities })

    expect(results.map((result) => result.ref)).toEqual(["register_server"])
    // Without the provider: nothing.
    expect(searchEverything(ITEMS, "spin a vm")).toEqual([])
  })

  it("keeps a name given exactly first", () => {
    const similarities = new Map([
      [semanticKey("pcp", "register_server"), 0.95],
      [semanticKey("tool", "github/create_issue"), 0.1],
    ])

    expect(
      searchEverything(ITEMS, "github/create_issue", { similarities })[0]?.ref,
    ).toBe("github/create_issue")
  })

  it("scores nearness relative to the others, whatever the model's scale", () => {
    const low = semanticBoosts(
      new Map([
        ["a", 0.31],
        ["b", 0.2],
        ["c", 0.19],
      ]),
    )
    const high = semanticBoosts(
      new Map([
        ["a", 0.81],
        ["b", 0.7],
        ["c", 0.69],
      ]),
    )

    expect(low.get("a")).toBe(high.get("a"))
    expect(low.has("c")).toBe(false)
    expect(semanticBoosts(new Map())).toEqual(new Map())
  })

  it("reads the provider's vectors strictly", () => {
    expect(
      readVectors(
        JSON.stringify({
          data: [
            { embedding: [0, 1], index: 1 },
            { embedding: [1, 0], index: 0 },
          ],
        }),
        2,
      ).map((vector) => [...vector]),
    ).toEqual([
      [1, 0],
      [0, 1],
    ])
    expect(() => readVectors(JSON.stringify({ data: [] }), 1)).toThrow()
    expect(() =>
      readVectors(JSON.stringify({ data: [{ embedding: ["x"] }] }), 1),
    ).toThrow()
    expect(() =>
      readVectors(
        JSON.stringify({ data: [{ embedding: [1] }, { embedding: [1, 2] }] }),
        2,
      ),
    ).toThrow()
    expect(() => readVectors("<html>", 1)).toThrow()
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBe(1)
    expect(cosine(Float32Array.from([1]), Float32Array.from([1, 0]))).toBeNull()
  })
})

describe("the provider", () => {
  let server: http.Server
  let received: Array<{ url: string; auth?: string; body: unknown }>
  let base: string
  let answer: (body: { input: string[] }) => unknown

  beforeEach(async () => {
    received = []
    answer = (body) => ({
      data: body.input.map((_, index) => ({ embedding: [1, index], index })),
    })
    server = http.createServer((request, response) => {
      let text = ""
      request.on("data", (chunk) => (text += chunk))
      request.on("end", () => {
        const body = JSON.parse(text) as { input: string[] }
        received.push({
          url: request.url ?? "",
          auth: request.headers.authorization,
          body,
        })
        response.setHeader("Content-Type", "application/json")
        response.end(JSON.stringify(answer(body)))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it("sends an OpenAI-compatible request with the secret as the header", async () => {
    const secret = await createSecret(ctx, { name: "embed-key", value: "sk-1" })
    const provider = await embeddingProvider(ctx, {
      provider: "openai",
      url: `${base}/v1`,
      model: "nomic-embed-text",
      secretId: secret.id,
      embed: { tools: true, skills: true, memories: true },
    })

    const vectors = await provider.embed(
      ["a", "b"],
      "document",
      AbortSignal.timeout(5_000),
    )

    expect(vectors.map((vector) => [...vector])).toEqual([
      [1, 0],
      [1, 1],
    ])
    expect(received).toEqual([
      {
        url: "/v1/embeddings",
        auth: "Bearer sk-1",
        body: { input: ["a", "b"], model: "nomic-embed-text" },
      },
    ])
    expect(provider.fingerprint).not.toContain("sk-1")
  })

  it("takes an API endpoint's address and credential", async () => {
    const secret = await createSecret(ctx, { name: "tei", value: "tei-key" })
    await db().mcpServer.create({
      data: {
        id: "tei",
        vaultId: ctx.vaultId,
        kind: "openapi",
        name: "Text embeddings",
        slug: "text-embeddings",
        url: base,
        authType: "header",
        authHeaderName: "Authorization",
        authValueTemplate: "Bearer {{secret}}",
        authSecretId: secret.id,
      },
    })
    const config: EmbeddingsConfig = {
      provider: "endpoint",
      serverId: "tei",
      model: "",
      embed: { tools: true, skills: true, memories: true },
    }

    expect(await checkEmbeddingsConfig(ctx, config)).toEqual(config)
    const provider = await embeddingProvider(ctx, config)
    await provider.embed(["x"], "query", AbortSignal.timeout(5_000))

    expect(received).toEqual([
      {
        url: "/v1/embeddings",
        auth: "Bearer tei-key",
        body: { input: ["x"] },
      },
    ])

    // The endpoint only for public addresses: refused, never sent.
    await db().mcpServer.update({
      where: { id: "tei" },
      data: { publicOnly: true },
    })
    const publicOnly = await embeddingProvider(ctx, config)
    await expect(
      publicOnly.embed(["x"], "query", AbortSignal.timeout(5_000)),
    ).rejects.toThrow()
    expect(received).toHaveLength(1)
  })

  it("keeps search to keywords when the provider answers nonsense", async () => {
    answer = () => ({ data: "nope" })
    await writeEmbeddingsConfig(ctx, {
      provider: "openai",
      url: base,
      model: "m",
      secretId: null,
      embed: { tools: true, skills: false, memories: false },
    })
    vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(
      await searchSimilarities(ctx, ITEMS, "file", embeddingProvider),
    ).toBeNull()
    // The query was asked for; no vector was stored.
    expect(received.length).toBeGreaterThan(0)
    expect(await db().embeddingVector.count()).toBe(0)
  })

  it("asks nothing without a provider", async () => {
    const open = vi.fn(embeddingProvider)

    expect(await searchSimilarities(ctx, ITEMS, "file", open)).toBeNull()
    expect(open).not.toHaveBeenCalled()
    expect(received).toHaveLength(0)
  })
})

describe("the setting", () => {
  it("is checked against the vault's own secrets and endpoints", async () => {
    const embed = { tools: true, skills: false, memories: false }

    await expect(
      checkEmbeddingsConfig(ctx, {
        provider: "voyage",
        model: "voyage-3.5-lite",
        secretId: "nope",
        embed,
      }),
    ).rejects.toThrow(/Voyage AI API key/)
    await expect(
      checkEmbeddingsConfig(ctx, {
        provider: "endpoint",
        serverId: "nope",
        model: "",
        embed,
      }),
    ).rejects.toThrow(/API endpoints/)
    await expect(
      checkEmbeddingsConfig(ctx, {
        provider: "openai",
        url: "ftp://x.example",
        model: "m",
        secretId: null,
        embed,
      }),
    ).rejects.toThrow(/http/)
    await expect(
      checkEmbeddingsConfig(ctx, {
        provider: "openai",
        url: "https://x.example",
        model: "m",
        secretId: null,
        embed: { tools: false, skills: false, memories: false },
      }),
    ).rejects.toThrow(/at least one/)
  })

  it("is stored as the vault's setting and read back, nonsense as none", async () => {
    const config: EmbeddingsConfig = {
      provider: "openai",
      url: "https://api.example.com/v1",
      model: "m",
      secretId: null,
      embed: { tools: true, skills: false, memories: false },
    }

    await writeEmbeddingsConfig(ctx, config)
    expect(await readEmbeddingsConfig(ctx)).toEqual(config)
    expect(
      await db().setting.findFirst({ where: { key: "embeddings" } }),
    ).toBeTruthy()

    await db().setting.update({
      where: { vaultId_key: { vaultId: ctx.vaultId, key: "embeddings" } },
      data: { value: "{" },
    })
    expect(await readEmbeddingsConfig(ctx)).toBeNull()

    await writeEmbeddingsConfig(ctx, null)
    expect(await readEmbeddingsConfig(ctx)).toBeNull()
  })

  it("finds the /embeddings address from a base address", () => {
    expect(embeddingsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/embeddings",
    )
    expect(embeddingsUrl("http://tei:8080")).toBe(
      "http://tei:8080/v1/embeddings",
    )
    expect(embeddingsUrl("http://x/v1/embeddings")).toBe(
      "http://x/v1/embeddings",
    )
  })
})
