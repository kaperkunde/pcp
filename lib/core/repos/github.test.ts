import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { db } from "../db"
import { revealSecret } from "../secrets"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"

import { scriptDevice, startFakeGitHub, type FakeGitHub } from "./fake-github"
import {
  blobSha,
  branchHead,
  checkBranch,
  githubEndpoints,
  parseRepoName,
  readBlob,
  readTree,
  repoInfo,
  type GitHub,
} from "./github"
import { GITHUB_OAUTH_CLIENT_ID, GITHUB_SIGNIN_SECRET } from "./limits"
import {
  forgetGitHubSignIns,
  pollGitHubSignIn,
  startGitHubSignIn,
} from "./signin"

// PCP's GitHub client against a fake GitHub on this machine: no redirect
// followed, every answer bounded and read against a schema, a file checked
// against its git id, and the device flow's every answer.

let fake: FakeGitHub

beforeEach(async () => {
  fake = await startFakeGitHub()
})

afterEach(async () => {
  await fake.close()
})

function client(credential: GitHub["credential"] = null): GitHub {
  return {
    endpoints: { api: fake.url, web: fake.url, publicOnly: false },
    credential,
  }
}

describe("names", () => {
  it("reads owner/name and refuses what is not one", () => {
    expect(parseRepoName("anthropics/skills")).toEqual({
      owner: "anthropics",
      name: "skills",
    })
    expect(parseRepoName("https://github.com/ada/notes.git")).toEqual({
      owner: "ada",
      name: "notes",
    })
    expect(() => parseRepoName("ada")).toThrow(/owner\/name/)
    expect(() => parseRepoName("ada/../x")).toThrow()
    expect(() => parseRepoName("-ada/x")).toThrow(/not a GitHub owner/)
    expect(checkBranch("release/1.0")).toBe("release/1.0")
    expect(() => checkBranch("../main")).toThrow()
    expect(() => checkBranch("main.lock")).toThrow()
  })

  it("calls GitHub itself in production, whatever the environment says", () => {
    const before = {
      env: process.env.NODE_ENV,
      api: process.env.PCP_GITHUB_API_URL,
    }
    try {
      process.env.PCP_GITHUB_API_URL = "http://127.0.0.1:1"
      ;(process.env as Record<string, string>).NODE_ENV = "production"
      expect(githubEndpoints()).toEqual({
        api: "https://api.github.com",
        web: "https://github.com",
        publicOnly: true,
      })
    } finally {
      ;(process.env as Record<string, string | undefined>).NODE_ENV = before.env
      if (before.api === undefined) delete process.env.PCP_GITHUB_API_URL
      else process.env.PCP_GITHUB_API_URL = before.api
    }
  })
})

describe("the client", () => {
  it("reads a repository, its branch, its tree and a file checked against its id", async () => {
    fake.addRepo("ada", "shared", {
      files: {
        "skills/notes/SKILL.md": "---\nname: notes\n---\nHi",
        "README.md": "x",
      },
    })
    const gh = client()

    expect(await repoInfo(gh, { owner: "ada", name: "shared" })).toEqual({
      defaultBranch: "main",
      private: false,
      push: null,
    })
    const head = await branchHead(gh, { owner: "ada", name: "shared" }, "main")
    const tree = await readTree(gh, { owner: "ada", name: "shared" }, head.tree)
    const file = tree.find((entry) => entry.path === "skills/notes/SKILL.md")!

    expect(file.sha).toBe(blobSha("---\nname: notes\n---\nHi"))
    expect(
      await readBlob(
        gh,
        { owner: "ada", name: "shared" },
        file.sha,
        1000,
        file.path,
      ),
    ).toBe("---\nname: notes\n---\nHi")
    // A file larger than PCP takes is refused before it is decoded.
    await expect(
      readBlob(gh, { owner: "ada", name: "shared" }, file.sha, 5, file.path),
    ).rejects.toThrow(/at most 5/)
  })

  it("follows no redirect", async () => {
    fake.addRepo("ada", "shared")
    fake.redirectAll = true

    await expect(
      repoInfo(client(), { owner: "ada", name: "shared" }),
    ).rejects.toThrow(/somewhere else/)
    expect(fake.requests).toHaveLength(1)
  })

  it("reads an answer only up to its bound", async () => {
    fake.addRepo("ada", "shared")
    fake.hugeAnswers = true

    await expect(
      repoInfo(client(), { owner: "ada", name: "shared" }),
    ).rejects.toThrow(/larger than PCP reads/)
  })

  it("reads an answer as untrusted: what is not the shape, or not the file named, is refused", async () => {
    const odd = (body: unknown): GitHub => ({
      ...client(),
      fetchFn: async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    })
    const coords = { owner: "ada", name: "shared" }

    await expect(repoInfo(odd("not json"), coords)).rejects.toThrow(
      /could not read/,
    )
    await expect(
      repoInfo(odd({ default_branch: 5, private: false }), coords),
    ).rejects.toThrow(/could not read/)
    await expect(
      repoInfo(odd({ default_branch: "../x", private: false }), coords),
    ).rejects.toThrow(/branch name/)

    const sha = blobSha("the real file")
    await expect(
      readBlob(
        odd({
          sha,
          size: 13,
          encoding: "base64",
          content: Buffer.from("a forged file").toString("base64"),
        }),
        coords,
        sha,
        1000,
        "SKILL.md",
      ),
    ).rejects.toThrow(/not the file it named/)
  })

  it("sends the credential to the API only, and keeps it out of what it repeats", async () => {
    fake.addRepo("ada", "secret", { private: true })
    const credential = {
      headers: { Authorization: "Bearer ghp_wrong" },
      redact: ["ghp_wrong", "Bearer ghp_wrong"],
    }

    const error = await repoInfo(client(credential), {
      owner: "ada",
      name: "secret",
    }).catch((caught: Error) => caught)

    expect(String(error)).toMatch(/did not take PCP's sign-in/)
    expect(String(error)).not.toContain("ghp_wrong")
    expect(fake.requests[0]!.authorization).toBe("Bearer ghp_wrong")
  })
})

describe("the device flow", () => {
  let ctx: VaultContext
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ cleanup } = await scratchDatabase())
    ctx = await setupVault({
      name: "Ada",
      password: "correct horse battery staple",
    })
    process.env.PCP_GITHUB_CLIENT_ID = fake.clientId
    forgetGitHubSignIns()
  })

  afterEach(async () => {
    delete process.env.PCP_GITHUB_CLIENT_ID
    await cleanup()
  })

  const endpoints = () => ({ api: fake.url, web: fake.url, publicOnly: false })

  it("waits while the owner has not approved, then saves the token as PCP's sign-in", async () => {
    const code = await startGitHubSignIn(ctx, {
      endpoints: endpoints(),
      now: 0,
    })

    expect(code.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    // PCP's own address for the page, never the one the answer named.
    expect(code.verificationUri).toBe(`${fake.url}/login/device`)

    // Asked too soon: GitHub is not asked at all.
    expect(
      (await pollGitHubSignIn(ctx, { endpoints: endpoints(), now: 1000 }))
        .status,
    ).toBe("waiting")
    expect(
      fake.requests.filter((r) => r.path === "/login/oauth/access_token"),
    ).toHaveLength(0)

    expect(
      (await pollGitHubSignIn(ctx, { endpoints: endpoints(), now: 6000 }))
        .status,
    ).toBe("waiting")

    fake.approve(code.userCode, "gho_DEVICETOKEN")
    const done = await pollGitHubSignIn(ctx, {
      endpoints: endpoints(),
      now: 12_000,
    })

    expect(done.status).toBe("done")
    const secret = await db().secret.findFirstOrThrow({
      where: { name: GITHUB_SIGNIN_SECRET },
    })
    expect(secret.kind).toBe("oauth")
    expect(JSON.parse(await revealSecret(ctx, secret.id))).toMatchObject({
      access_token: "gho_DEVICETOKEN",
    })
    // No credential went to github.com along the way.
    expect(
      fake.requests.every((request) => request.authorization === null),
    ).toBe(true)
  })

  it("slows down when GitHub says so", async () => {
    await startGitHubSignIn(ctx, { endpoints: endpoints(), now: 0 })
    scriptDevice(fake, ["slow_down"])

    expect(
      (await pollGitHubSignIn(ctx, { endpoints: endpoints(), now: 5000 }))
        .status,
    ).toBe("waiting")
    // The interval grew past 10 seconds: at 12 seconds GitHub is not asked.
    const before = fake.requests.length
    await pollGitHubSignIn(ctx, { endpoints: endpoints(), now: 12_000 })
    expect(fake.requests.length).toBe(before)
    await pollGitHubSignIn(ctx, { endpoints: endpoints(), now: 16_000 })
    expect(fake.requests.length).toBe(before + 1)
  })

  it("ends when the code expires, or the owner says no", async () => {
    await startGitHubSignIn(ctx, { endpoints: endpoints(), now: 0 })
    scriptDevice(fake, ["expired"])
    expect(
      (await pollGitHubSignIn(ctx, { endpoints: endpoints(), now: 5000 }))
        .status,
    ).toBe("expired")
    expect(
      (await pollGitHubSignIn(ctx, { endpoints: endpoints(), now: 6000 }))
        .status,
    ).toBe("none")

    await startGitHubSignIn(ctx, { endpoints: endpoints(), now: 0 })
    // Past its lifetime, PCP stops without asking.
    expect(
      (await pollGitHubSignIn(ctx, { endpoints: endpoints(), now: 901_000 }))
        .status,
    ).toBe("expired")

    await startGitHubSignIn(ctx, { endpoints: endpoints(), now: 0 })
    scriptDevice(fake, ["denied"])
    expect(
      (await pollGitHubSignIn(ctx, { endpoints: endpoints(), now: 5000 }))
        .status,
    ).toBe("denied")
    expect(
      await db().secret.count({ where: { name: GITHUB_SIGNIN_SECRET } }),
    ).toBe(0)
  })

  it("asks for no more than the owner chose, and ships PCP's client id", async () => {
    expect(GITHUB_OAUTH_CLIENT_ID).toMatch(/^Ov23/)
    await startGitHubSignIn(ctx, { endpoints: endpoints() })
    await startGitHubSignIn(ctx, { endpoints: endpoints(), scope: "repo" })

    const asked = fake.requests
      .filter((request) => request.path === "/login/device/code")
      .map((request) => new URLSearchParams(request.body).get("scope"))
    expect(asked).toEqual(["public_repo", "repo"])
    await expect(
      startGitHubSignIn(ctx, {
        endpoints: endpoints(),
        scope: "admin:org" as "repo",
      }),
    ).rejects.toThrow(/public repositories/)
  })
})
