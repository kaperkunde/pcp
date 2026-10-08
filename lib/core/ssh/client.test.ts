import { afterEach, describe, expect, it } from "vitest"

import {
  SshAuthError,
  SshHostError,
  sshCheck,
  sshExec,
  type SshIdentity,
  type SshTarget,
} from "./client"
import {
  issueCertificate,
  makeEd25519,
  startFakeSsh,
  type FakeSsh,
  type FakeSshOptions,
} from "./fake-server"
import { generateOwnKey } from "./keys"

const hostCa = makeEd25519()
const userCa = makeEd25519()
const hostKey = makeEd25519()
const HOUR = 3600n
const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000))

function hostCertificate(
  overrides: Partial<Parameters<typeof issueCertificate>[0]> = {},
) {
  return issueCertificate({
    ca: hostCa,
    key: hostKey.publicKey,
    type: "host",
    principals: ["127.0.0.1", "localhost"],
    ...overrides,
  })
}

function identity(
  overrides: Partial<Parameters<typeof issueCertificate>[0]> = {},
): SshIdentity {
  const { key } = generateOwnKey()
  return {
    key,
    certificate: issueCertificate({
      ca: userCa,
      key: key.publicKey,
      type: "user",
      principals: ["deploy"],
      ...overrides,
    }),
  }
}

let server: FakeSsh | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

async function start(options: Partial<FakeSshOptions> = {}) {
  server = await startFakeSsh({
    hostKey,
    hostCertificate: hostCertificate(),
    userAuthority: userCa.publicKey,
    run: (command, stdin) => ({
      stdout: `ran ${command} with ${stdin.length} bytes\n`,
      stderr: "a warning\n",
      exitCode: 3,
    }),
    ...options,
  })

  const target: SshTarget = {
    host: "127.0.0.1",
    port: server.port,
    username: "deploy",
    hostAuthorities: [hostCa.publicKey],
  }
  return { server, target }
}

const run = { command: "uptime", timeoutMs: 5000, maxOutputBytes: 1 << 20 }

describe("sshExec", () => {
  it("runs a command and returns its output and exit code", async () => {
    const { server, target } = await start()
    const result = await sshExec(target, identity(), run)

    expect(result.stdout.toString()).toBe("ran uptime with 0 bytes\n")
    expect(result.stderr.toString()).toBe("a warning\n")
    expect(result.exitCode).toBe(3)
    expect(result.truncated).toBe(false)
    expect(server.logins).toEqual(["deploy"])
    expect(server.commands).toEqual(["uptime"])
  })

  it("sends standard input past the server's window", async () => {
    const { target } = await start()
    const result = await sshExec(target, identity(), {
      ...run,
      command: "wc -c",
      stdin: Buffer.alloc(300_000, 1),
    })

    expect(result.stdout.toString()).toBe("ran wc -c with 300000 bytes\n")
  })

  it("reports the signal that ended a command", async () => {
    const { target } = await start({ run: () => ({ signal: "KILL" }) })
    const result = await sshExec(target, identity(), run)

    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe("KILL")
  })

  it("stops a command that writes more than it may", async () => {
    const { target } = await start({ run: () => ({ flood: true }) })
    const result = await sshExec(target, identity(), {
      ...run,
      maxOutputBytes: 100_000,
    })

    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBe(100_000)
  })

  it("stops a command that runs out of time", async () => {
    const { target } = await start({ run: () => ({ hang: true }) })
    const result = await sshExec(target, identity(), {
      ...run,
      timeoutMs: 300,
    })

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  it("stops waiting for a server that never opens the session", async () => {
    const { target } = await start({ stallSession: true })
    const result = await sshExec(target, identity(), {
      ...run,
      timeoutMs: 300,
    })

    expect(result.timedOut).toBe(true)
  })

  it("works with a server that does not offer strict key exchange", async () => {
    const { target } = await start({ strict: false })
    const result = await sshExec(target, identity(), run)

    expect(result.exitCode).toBe(3)
  })
})

describe("the server's host certificate", () => {
  it("refuses a server with a plain host key", async () => {
    const { server, target } = await start({ hostCertificate: null })

    await expect(sshCheck(target, identity())).rejects.toThrow(
      /presents no host certificate/,
    )
    expect(server.logins).toEqual([])
  })

  it("refuses a certificate from another CA", async () => {
    const { target } = await start({
      hostCertificate: hostCertificate({ ca: makeEd25519() }),
    })

    await expect(sshCheck(target, identity())).rejects.toThrow(
      /CA you have not given PCP/,
    )
  })

  it("refuses a certificate for another host", async () => {
    const { target } = await start({
      hostCertificate: hostCertificate({ principals: ["other.example"] }),
    })

    await expect(sshCheck(target, identity())).rejects.toThrow(SshHostError)
  })

  it("refuses an expired certificate, and a user certificate", async () => {
    const expired = await start({
      hostCertificate: hostCertificate({ validBefore: nowSeconds() - HOUR }),
    })
    await expect(sshCheck(expired.target, identity())).rejects.toThrow(
      /expired/,
    )
    await expired.server.close()

    const user = await start({
      hostCertificate: hostCertificate({ type: "user" }),
    })
    await expect(sshCheck(user.target, identity())).rejects.toThrow(
      /not a host certificate/,
    )
  })

  it("refuses a server that cannot prove it holds the certified key", async () => {
    const { server, target } = await start({ wrongHostSignature: true })

    await expect(sshCheck(target, identity())).rejects.toThrow(
      /could not prove it holds the key/,
    )
    expect(server.logins).toEqual([])
  })

  it("names the host and its CA when it checks out", async () => {
    const { target } = await start({
      hostCertificate: hostCertificate({ keyId: "web-1" }),
    })

    await expect(sshCheck(target, identity())).resolves.toMatchObject({
      keyId: "web-1",
      authority: expect.stringMatching(/^SHA256:/),
    })
  })
})

describe("PCP's certificate", () => {
  it("is turned down when the server does not trust its CA", async () => {
    const { server, target } = await start()

    await expect(
      sshCheck(target, identity({ ca: makeEd25519() })),
    ).rejects.toThrow(SshAuthError)
    expect(server.logins).toEqual([])
  })

  it("is not offered when it is for another login, expired or another key", async () => {
    const { server, target } = await start()

    await expect(
      sshCheck(target, identity({ principals: ["root"] })),
    ).rejects.toThrow(/not for deploy/)
    await expect(
      sshCheck(target, identity({ validBefore: nowSeconds() - HOUR })),
    ).rejects.toThrow(/expired/)
    await expect(
      sshCheck(target, {
        key: generateOwnKey().key,
        certificate: identity().certificate,
      }),
    ).rejects.toThrow(/another key than PCP's/)
    // None of them got as far as connecting.
    expect(server.logins).toEqual([])
  })
})
