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
import {
  issueCertificate,
  makeEd25519,
  startFakeSsh,
  type FakeSsh,
  type TestCa,
} from "./fake-server"
import {
  createSshServer,
  parseSshAddress,
  replaceSshKey,
  setSshCertificate,
  sshServerView,
  updateSshServer,
  validateLogin,
} from "./hosts"
import { certificateLine, parsePublicKeyLine, publicKeyLine } from "./keys"

// SSH servers end to end in the core: added by the owner, given a
// certificate, read and called through upstream.ts like any server, against
// the test SSH server on 127.0.0.1.

const PUBLIC = { publicUrl: "http://localhost:3000" }

let cleanup: () => Promise<void>
let ctx: VaultContext
let fake: FakeSsh
let hostCa: TestCa
let userCa: TestCa

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  hostCa = makeEd25519()
  userCa = makeEd25519()
  const hostKey = makeEd25519()
  fake = await startFakeSsh({
    hostKey,
    hostCertificate: issueCertificate({
      ca: hostCa,
      key: hostKey.publicKey,
      type: "host",
      principals: ["127.0.0.1"],
    }),
    userAuthority: userCa.publicKey,
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

async function addServer(overrides: { hostCas?: string } = {}) {
  const { id } = await createSshServer(ctx, {
    name: "Build box",
    host: "127.0.0.1",
    port: fake.port,
    username: "deploy",
    hostCas: overrides.hostCas ?? publicKeyLine(hostCa.publicKey, "host CA"),
  })
  return id
}

/** What the owner does with ssh-keygen -s: sign the key the page shows. */
async function certify(
  id: string,
  overrides: Partial<Parameters<typeof issueCertificate>[0]> = {},
) {
  const view = sshServerView(await getServer(ctx, id))
  const certificate = issueCertificate({
    ca: userCa,
    key: parsePublicKeyLine(view.publicKey),
    type: "user",
    principals: ["deploy"],
    keyId: "pcp",
    ...overrides,
  })
  return certificateLine(certificate, "pcp-cert")
}

describe("adding an SSH server", () => {
  it("makes PCP a key of its own, kept as a managed secret", async () => {
    const id = await addServer()
    const row = await getServer(ctx, id)
    const view = sshServerView(row)

    expect(row.kind).toBe("ssh")
    expect(row.url).toBe(`ssh://127.0.0.1:${fake.port}`)
    expect(row.authType).toBe("certificate")
    expect(row.status).toBe("auth_required")
    expect(view.publicKey).toMatch(/^ssh-ed25519 \S+ pcp-build-box$/)
    expect(view.publicKeyFingerprint).toMatch(/^SHA256:/)
    expect(view.certificate).toBeNull()

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

  it("refuses addresses, logins and CA keys it cannot use", async () => {
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

    await expect(addServer({ hostCas: "" })).rejects.toThrow(
      /Paste the public key/,
    )
    const cert = issueCertificate({
      ca: hostCa,
      key: makeEd25519().publicKey,
      type: "host",
      principals: ["x"],
    })
    await expect(addServer({ hostCas: certificateLine(cert) })).rejects.toThrow(
      /cannot be read/,
    )
  })

  it("rechecks the server when its address, login or CAs change", async () => {
    const id = await addServer()
    const input = {
      name: "Build box, renamed",
      host: "127.0.0.1",
      port: fake.port,
      username: "deploy",
      hostCas: publicKeyLine(hostCa.publicKey),
    }

    expect(await updateSshServer(ctx, id, input)).toEqual({ reconnect: false })
    expect(
      await updateSshServer(ctx, id, { ...input, username: "root" }),
    ).toEqual({ reconnect: true })
  })
})

describe("the certificate", () => {
  it("is taken only for PCP's key, this login, as a user certificate that has not expired", async () => {
    const id = await addServer()
    const other = makeEd25519().publicKey
    const otherKey = certificateLine(
      issueCertificate({
        ca: userCa,
        key: other,
        type: "user",
        principals: ["deploy"],
      }),
    )

    await expect(setSshCertificate(ctx, id, otherKey)).rejects.toThrow(
      /another key/,
    )
    await expect(
      setSshCertificate(ctx, id, await certify(id, { principals: ["root"] })),
    ).rejects.toThrow(/not for deploy/)
    await expect(
      setSshCertificate(ctx, id, await certify(id, { type: "host" })),
    ).rejects.toThrow(/not a user certificate/)
    await expect(
      setSshCertificate(
        ctx,
        id,
        await certify(id, {
          validBefore: BigInt(Math.floor(Date.now() / 1000) - 60),
        }),
      ),
    ).rejects.toThrow(/expired/)
    await expect(setSshCertificate(ctx, id, "garbage")).rejects.toThrow(
      /cannot be read/,
    )

    // One that starts tomorrow is kept, and shown as not valid yet.
    const tomorrow = BigInt(Math.floor(Date.now() / 1000) + 86_400)
    await setSshCertificate(
      ctx,
      id,
      await certify(id, { validAfter: tomorrow }),
    )
    const view = sshServerView(await getServer(ctx, id))
    expect(view.certificate?.problem).toMatch(/not valid until/)
    expect(view.certificate?.principals).toEqual(["deploy"])
    // Stored without its comment.
    expect(view.certificate?.line).not.toContain("pcp-cert")
  })

  it("is dropped with the key when PCP makes a new one", async () => {
    const id = await addServer()
    await setSshCertificate(ctx, id, await certify(id))
    const before = await getServer(ctx, id)

    await replaceSshKey(ctx, id)
    const after = await getServer(ctx, id)

    expect(after.sshPublicKey).not.toBe(before.sshPublicKey)
    expect(after.sshCertificate).toBeNull()
    expect(after.authSecretId).toBe(before.authSecretId)
    expect(after.status).toBe("auth_required")
  })
})

describe("running commands", () => {
  it("answers with the owner's page until there is a certificate, after checking the arguments", async () => {
    const id = await addServer()
    const server = await getServer(ctx, id)
    const sync = await syncServerTools(ctx, server, PUBLIC)

    expect(sync).toMatchObject({ status: "auth_required", toolCount: 1 })
    await expect(
      callServerTool(ctx, server, "run_command", {}, PUBLIC),
    ).rejects.toThrow(/Give the command/)

    const result = await callServerTool(
      ctx,
      server,
      "run_command",
      { command: "uptime" },
      PUBLIC,
    )
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain(
      `http://localhost:3000/servers/${id}`,
    )
    expect(fake.commands).toEqual([])
  })

  it("signs in, runs the command and returns what it wrote", async () => {
    const id = await addServer()
    await setSshCertificate(ctx, id, await certify(id))
    const sync = await syncServerTools(ctx, await getServer(ctx, id), PUBLIC)

    expect(sync).toEqual({ status: "ok", message: "", toolCount: 1 })

    const result = await callServerTool(
      ctx,
      await getServer(ctx, id),
      "run_command",
      { command: "cat", stdin: "hello", timeout_seconds: 5 },
      PUBLIC,
    )

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
    const id = await addServer()
    await setSshCertificate(ctx, id, await certify(id))
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

  it("refuses arguments it does not know and timeouts out of range", async () => {
    const id = await addServer()
    await setSshCertificate(ctx, id, await certify(id))
    const server = await getServer(ctx, id)

    await expect(
      callServerTool(
        ctx,
        server,
        "run_command",
        { command: "ls", pty: true },
        PUBLIC,
      ),
    ).rejects.toThrow(/no argument "pty"/)
    await expect(
      callServerTool(
        ctx,
        server,
        "run_command",
        { command: "ls", timeout_seconds: 3600 },
        PUBLIC,
      ),
    ).rejects.toThrow(/timeout_seconds/)
    await expect(
      callServerTool(ctx, server, "run_command", { command: "a\0b" }, PUBLIC),
    ).rejects.toThrow(/NUL/)
    await expect(
      callServerTool(ctx, server, "shell", { command: "ls" }, PUBLIC),
    ).rejects.toThrow(/no tool called shell/)
    expect(fake.commands).toEqual([])
  })

  it("does not connect to a host whose certificate is from another CA", async () => {
    const id = await addServer({
      hostCas: publicKeyLine(makeEd25519().publicKey),
    })
    await setSshCertificate(ctx, id, await certify(id))

    const result = await callServerTool(
      ctx,
      await getServer(ctx, id),
      "run_command",
      { command: "uptime" },
      PUBLIC,
    )

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/CA you have not given PCP/)
    expect((await getServer(ctx, id)).status).toBe("error")
    expect(fake.logins).toEqual([])
  })

  it("asks the owner for a new certificate when the server turns it down", async () => {
    const id = await addServer()
    await setSshCertificate(ctx, id, await certify(id, { ca: makeEd25519() }))

    const result = await callServerTool(
      ctx,
      await getServer(ctx, id),
      "run_command",
      { command: "uptime" },
      PUBLIC,
    )

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain(`/servers/${id}`)
    expect((await getServer(ctx, id)).status).toBe("auth_required")
  })

  it("reports a server it cannot reach as an error", async () => {
    const id = await addServer()
    await setSshCertificate(ctx, id, await certify(id))
    await fake.close()

    await expect(
      callServerTool(
        ctx,
        await getServer(ctx, id),
        "run_command",
        { command: "uptime" },
        PUBLIC,
      ),
    ).rejects.toThrow(/could not be reached/)
  })
})

describe("deleting an SSH server", () => {
  it("deletes PCP's key with it", async () => {
    const id = await addServer()
    await deleteServer(ctx, id)

    expect(await listSecrets(ctx)).toEqual([])
  })
})
