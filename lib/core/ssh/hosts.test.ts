import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { listSecrets } from "../secrets"
import { deleteServer, getServer } from "../servers"
import { scratchDatabase } from "../test-db"
import { keepResult, resultOpener } from "../tool-results"
import { callServerTool, syncServerTools } from "../upstream"
import { setupVault } from "../vault"
import { startFakeSsh, type FakeSsh } from "./fake-server"
import {
  createSshServer,
  forgetSshHostKey,
  parseSshAddress,
  replaceSshKey,
  sshServerView,
  updateSshServer,
  validateLogin,
} from "./hosts"
import { fingerprint } from "./keys"

// SSH servers end to end in the core: added by the owner, PCP's key put in
// the test server's authorized_keys, read and called through upstream.ts
// like any server, against an SSH server on 127.0.0.1.

const PUBLIC = { publicUrl: "http://localhost:3000" }
/** The owner's check: the only connection that pins a host key. */
const OWNER = { ...PUBLIC, byOwner: true }

let cleanup: () => Promise<void>
let ctx: VaultContext
let fake: FakeSsh
/** The test server's authorized_keys: what the owner pasted there. */
let authorized: string | null

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  authorized = null
  fake = await startFakeSsh({
    authorizedKey: () => authorized,
    run: (command, stdin) => ({
      stdout: `${command}: ${stdin.toString()}`,
      exitCode: command === "false" ? 1 : 0,
    }),
  })
})

afterEach(async () => {
  await fake.close()
  await cleanup()
})

async function addServer() {
  const { id } = await createSshServer(ctx, {
    name: "Build box",
    host: "127.0.0.1",
    port: fake.port,
    username: "deploy",
  })
  return id
}

/** Adds the server and puts PCP's key in authorized_keys, as the owner does. */
async function readyServer() {
  const id = await addServer()
  authorized = (await getServer(ctx, id)).sshPublicKey
  return id
}

/** The owner has checked the server too, which pinned its host key. */
async function pinnedServer() {
  const id = await readyServer()
  await syncServerTools(ctx, await getServer(ctx, id), OWNER)
  return id
}

async function run(id: string, args: Record<string, unknown>) {
  return callServerTool(
    ctx,
    await getServer(ctx, id),
    "run_command",
    args,
    PUBLIC,
  )
}

describe("adding an SSH server", () => {
  it("makes PCP a key of its own, kept as a managed secret", async () => {
    const id = await addServer()
    const row = await getServer(ctx, id)
    const view = sshServerView(row)

    expect(row.kind).toBe("ssh")
    expect(row.url).toBe(`ssh://127.0.0.1:${fake.port}`)
    expect(row.authType).toBe("key")
    expect(view.publicKey).toMatch(/^ssh-ed25519 \S+ pcp-build-box$/)
    expect(view.publicKeyFingerprint).toMatch(/^SHA256:/)
    expect(view.hostKey).toBeNull()

    const secrets = await listSecrets(ctx)
    expect(secrets).toEqual([
      expect.objectContaining({
        id: row.authSecretId,
        kind: "ssh_key",
        usedBy: [{ id, name: "Build box" }],
      }),
    ])
    // The row never holds the private key.
    expect(JSON.stringify(row)).not.toContain("PRIVATE KEY")
  })

  it("refuses addresses and logins it cannot use", () => {
    expect(parseSshAddress("Example.COM")).toEqual({
      host: "example.com",
      port: 22,
    })
    expect(parseSshAddress("[::1]:2200")).toEqual({ host: "::1", port: 2200 })
    expect(parseSshAddress("ssh://host:23", "2222")).toEqual({
      host: "host",
      port: 2222,
    })
    expect(() => parseSshAddress("deploy@host")).toThrow(/login in its own/)
    expect(() => parseSshAddress("host;rm -rf")).toThrow(/host name/)
    expect(() => parseSshAddress("host:99999")).toThrow(/port/)
    expect(() => validateLogin("-oProxyCommand=x")).toThrow()
    expect(() => validateLogin("de ploy")).toThrow()
    expect(validateLogin("svc.deploy@corp")).toBe("svc.deploy@corp")
  })
})

describe("the host key", () => {
  it("is pinned on the first connection, even before PCP's key is added", async () => {
    const id = await addServer()
    const sync = await syncServerTools(ctx, await getServer(ctx, id), OWNER)

    expect(sync).toMatchObject({ status: "auth_required", toolCount: 1 })
    expect(sync.message).toMatch(/deploy's ~\/.ssh\/authorized_keys/)
    const row = await getServer(ctx, id)
    expect(row.sshHostKey).toBe(fake.hostKey)
    expect(sshServerView(row).hostKey).toEqual({
      type: "ssh-ed25519",
      fingerprint: fingerprint(fake.hostKey),
    })
  })

  it("is never pinned by an assistant: its call refuses a server the owner has not checked", async () => {
    const id = await readyServer()

    const result = await run(id, { command: "uptime" })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/only the owner pins/)
    expect(JSON.stringify(result.content)).toContain(`/servers/${id}`)
    expect(fake.logins).toEqual([])
    expect(fake.commands).toEqual([])
    const row = await getServer(ctx, id)
    expect(row.sshHostKey).toBeNull()
    expect(row.status).toBe("unknown")
  })

  it("is not pinned by the gateway reading the tools again, which does not connect", async () => {
    const id = await readyServer()

    const sync = await syncServerTools(ctx, await getServer(ctx, id), PUBLIC)

    expect(sync).toMatchObject({ status: "error", toolCount: 1 })
    expect(sync.message).toContain(`/servers/${id}`)
    expect(fake.logins).toEqual([])
    const row = await getServer(ctx, id)
    expect(row.sshHostKey).toBeNull()
    expect(row.status).toBe("unknown")

    // Once the owner has pinned it, a reading for an assistant signs in.
    await syncServerTools(ctx, row, OWNER)
    expect(
      await syncServerTools(ctx, await getServer(ctx, id), PUBLIC),
    ).toMatchObject({ status: "ok" })
    expect(fake.logins).toEqual(["deploy", "deploy"])
  })

  it("is not pinned again by an assistant's call once the owner forgot it", async () => {
    const id = await pinnedServer()
    await forgetSshHostKey(ctx, id)
    const logins = fake.logins.length

    const result = await run(id, { command: "uptime" })

    expect(result.isError).toBe(true)
    expect(fake.logins.length).toBe(logins)
    expect((await getServer(ctx, id)).sshHostKey).toBeNull()

    await syncServerTools(ctx, await getServer(ctx, id), OWNER)
    expect((await getServer(ctx, id)).sshHostKey).toBe(fake.hostKey)
    expect((await run(id, { command: "uptime" })).isError).toBeFalsy()
  })

  it("refuses a server that shows another key, until the owner forgets it", async () => {
    const id = await readyServer()
    await syncServerTools(ctx, await getServer(ctx, id), OWNER)
    // As if the server had been swapped for another since.
    await db().mcpServer.update({
      where: { id },
      data: {
        sshHostKey: `ssh-ed25519 ${Buffer.alloc(51).toString("base64")}`,
      },
    })
    const logins = fake.logins.length

    const refused = await run(id, { command: "uptime" })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toMatch(/not the one PCP pinned/)
    expect(JSON.stringify(refused.content)).toContain(`/servers/${id}`)
    expect((await getServer(ctx, id)).status).toBe("error")
    expect(fake.logins.length).toBe(logins)
    expect(fake.commands).toEqual([])

    // The owner forgets it, and their next check pins what the server shows.
    await forgetSshHostKey(ctx, id)
    await syncServerTools(ctx, await getServer(ctx, id), OWNER)
    expect((await getServer(ctx, id)).sshHostKey).toBe(fake.hostKey)
    expect((await run(id, { command: "uptime" })).isError).toBeFalsy()
  })

  it("is pinned afresh when the address changes", async () => {
    const id = await pinnedServer()
    const input = {
      name: "Build box, renamed",
      host: "127.0.0.1",
      port: fake.port,
      username: "deploy",
    }

    expect(await updateSshServer(ctx, id, input)).toEqual({ reconnect: false })
    expect((await getServer(ctx, id)).sshHostKey).toBe(fake.hostKey)

    expect(
      await updateSshServer(ctx, id, { ...input, host: "localhost" }),
    ).toEqual({ reconnect: true })
    expect((await getServer(ctx, id)).sshHostKey).toBeNull()
  })
})

describe("running commands", () => {
  it("signs in with PCP's key, runs the command and returns what it wrote", async () => {
    const id = await readyServer()
    const sync = await syncServerTools(ctx, await getServer(ctx, id), OWNER)

    expect(sync).toEqual({ status: "ok", message: "", toolCount: 1 })

    const result = await run(id, {
      command: "cat",
      stdin: "hello",
      timeout_seconds: 5,
    })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({
      exit_code: 0,
      stdout: "cat: hello",
      stderr: "",
    })
    expect(fake.logins).toEqual(["deploy", "deploy"])
    expect(fake.commands).toEqual(["cat"])

    const tool = await db().mcpTool.findFirstOrThrow({
      where: { serverId: id },
    })
    expect(JSON.parse(tool.annotations ?? "{}")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    })
  })

  it("feeds a kept result's text to standard input", async () => {
    const id = await pinnedServer()
    const { id: tokenId } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
      serverIds: [],
    })
    const kept = await keepResult(ctx, {
      tokenId,
      serverId: null,
      toolName: "read_result",
      text: "kept text",
      mediaType: "text/plain",
    })

    const result = await callServerTool(
      ctx,
      await getServer(ctx, id),
      "run_command",
      { command: "wc", stdin: { $result: kept.id } },
      { ...PUBLIC, open: resultOpener(ctx, tokenId) },
    )

    expect(result.structuredContent).toMatchObject({ stdout: "wc: kept text" })
  })

  it("refuses arguments it does not know before connecting", async () => {
    const id = await readyServer()

    await expect(run(id, { command: "ls", pty: true })).rejects.toThrow(
      /no argument "pty"/,
    )
    await expect(
      run(id, { command: "ls", timeout_seconds: 3600 }),
    ).rejects.toThrow(/timeout_seconds/)
    await expect(run(id, { command: "a\0b" })).rejects.toThrow(/NUL/)
    await expect(
      callServerTool(
        ctx,
        await getServer(ctx, id),
        "shell",
        { command: "ls" },
        PUBLIC,
      ),
    ).rejects.toThrow(/no tool called shell/)
    expect(fake.logins).toEqual([])
  })

  it("answers with the owner's page when the server turns PCP's key down", async () => {
    const id = await addServer()
    await syncServerTools(ctx, await getServer(ctx, id), OWNER)

    const result = await run(id, { command: "uptime" })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain(`/servers/${id}`)
    expect((await getServer(ctx, id)).status).toBe("auth_required")
    expect(fake.commands).toEqual([])
  })

  it("stops working with the old key once PCP makes a new one", async () => {
    const id = await pinnedServer()
    const before = await getServer(ctx, id)

    await replaceSshKey(ctx, id)
    const after = await getServer(ctx, id)

    expect(after.sshPublicKey).not.toBe(before.sshPublicKey)
    expect(after.authSecretId).toBe(before.authSecretId)
    expect((await run(id, { command: "uptime" })).isError).toBe(true)

    authorized = after.sshPublicKey
    expect((await run(id, { command: "uptime" })).isError).toBeFalsy()
  })

  it("reports a server it cannot reach as an error", async () => {
    const id = await pinnedServer()
    await fake.close()

    await expect(run(id, { command: "uptime" })).rejects.toThrow(
      /could not be reached/,
    )
  })
})

describe("deleting an SSH server", () => {
  it("deletes PCP's key with it", async () => {
    const id = await addServer()
    await deleteServer(ctx, id)

    expect(await listSecrets(ctx)).toEqual([])
  })
})
