import { readdirSync, readFileSync, statSync } from "node:fs"
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"

import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { dataDir } from "../data-dir"
import { db } from "../db"
import { buildGatewayServer, loadGatewayServers } from "../gateway"
import { getServer } from "../servers"
import { closeAllSshConnections } from "../ssh/client"
import { startFakeSsh, type FakeSsh } from "../ssh/fake-server"
import { createSshServer } from "../ssh/hosts"
import { scratchDatabase } from "../test-db"
import { entryCall, withCallHandle } from "../test-handles"
import { activityLog } from "../activity"
import { setToolAccess } from "../tool-access"
import { setToolTier } from "../tool-tiers"
import {
  finishServiceSignin,
  launchService,
  readServiceSignin,
  startServiceSignin,
  syncServerTools,
} from "../upstream"
import { setupVault } from "../vault"
import type { ServiceDefinitionInput } from "./definition"
import { startFakeDocker, type FakeDocker } from "./fake-docker"
import { checkSigninUrl, readExpiry, signinCheck, signinResult } from "./signin"

const signedIn = vi.hoisted(() => ({ ctx: null as unknown }))

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/server/session", () => ({
  requireContext: async () => signedIn.ctx,
}))
vi.mock("@/lib/server/public-url", () => ({
  publicUrlFor: async () => "http://localhost:3000",
}))

const { finishSigninAction, signinStatusAction, startSigninAction } =
  await import("@/lib/actions/service-sign-in")

// A service that signs in to an account (#163): its definition declares
// the sign-in, PCP's own page starts it and takes the owner's code, and an
// assistant gets a link to that page, from connect_account or from a call
// that failed signed out. The service runs in the fake engine on the fake
// SSH server; what it serves is an MCP server of the test's own with the
// three sign-in tools and one that works only signed in.

const PUBLIC = { publicUrl: "http://localhost:3000" }
const FAST = { ...PUBLIC, timing: { waitMs: 1500, intervalMs: 50 } }
const DIGEST = `sha256:${"b".repeat(64)}`
const GOOD_CODE = "good-code-7f3a9c41e2"
const BAD_CODE = "bad-code-55d01b7e93"
const PROVIDER = "https://claude.ai/oauth/authorize?code=true&state=s1"

let cleanup: () => Promise<void>
let ctx: VaultContext
let ssh: FakeSsh
let docker: FakeDocker
let authorized: string | null
let http: Server
let httpPort: number
/** The account the MCP server is signed in as; null: signed out. */
let account: string | null
/** What login_start answers with as its url. */
let startUrl: string
/** What login_start answers with as its expires_at; by default 15 minutes on. */
let startExpires: unknown
/** The Authorization each request came with, and each call's arguments. */
let seen: Array<{ authorization: string | null; body: string }>

const TOOLS = [
  { name: "login_status", annotations: { readOnlyHint: true } },
  { name: "login_start", annotations: { readOnlyHint: false } },
  { name: "login_finish", annotations: { readOnlyHint: false } },
  { name: "list_sessions", annotations: { readOnlyHint: true } },
  { name: "fail_always", annotations: { readOnlyHint: true } },
]

function toolAnswer(name: string, args: Record<string, unknown>) {
  const json = (value: unknown, isError = false) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  })

  switch (name) {
    case "login_status":
      return json({
        signed_in: account !== null,
        email: account,
        login_pending: false,
      })
    case "login_start":
      return json({
        url: startUrl,
        expires_at:
          startExpires === undefined
            ? new Date(Date.now() + 15 * 60_000).toISOString()
            : startExpires,
        next: "Have the owner paste the code into login_finish.",
      })
    case "fail_always":
      return {
        content: [{ type: "text", text: "Boom: the service failed." }],
        isError: true,
      }
    case "login_finish":
      if (args.code === GOOD_CODE) {
        account = "ada@example.com"
        return json({ signed_in: true, email: account })
      }
      // A service that quotes what it was given: PCP takes it out.
      return {
        content: [
          {
            type: "text",
            text: `The code ${String(args.code)} did not work.`,
          },
        ],
        isError: true,
      }
    default:
      return account
        ? json({ sessions: [] })
        : {
            content: [{ type: "text", text: "Not signed in to Claude." }],
            isError: true,
          }
  }
}

function answerMcp(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") {
    response.writeHead(405).end()
    return
  }

  let body = ""
  request.on("data", (chunk: Buffer) => (body += chunk.toString()))
  request.on("end", () => {
    seen.push({ authorization: request.headers.authorization ?? null, body })
    const message = JSON.parse(body) as {
      id?: number
      method: string
      params?: {
        protocolVersion?: string
        name?: string
        arguments?: Record<string, unknown>
      }
    }

    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }

    // A sign-in tool that fails as the protocol does, quoting its input.
    if (
      message.method === "tools/call" &&
      typeof message.params?.arguments?.code === "string" &&
      message.params.arguments.code.startsWith("rpc-")
    ) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32000,
            message: `Bad code ${message.params.arguments.code}`,
          },
        }),
      )
      return
    }

    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "sessions", version: "1" },
          }
        : message.method === "tools/list"
          ? {
              tools: TOOLS.map((tool) => ({
                ...tool,
                description: `${tool.name} of the sessions service`,
                inputSchema: { type: "object" },
              })),
            }
          : message.method === "tools/call"
            ? toolAnswer(
                message.params?.name ?? "",
                message.params?.arguments ?? {},
              )
            : {}

    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
  })
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  signedIn.ctx = ctx
  authorized = null
  account = null
  startUrl = PROVIDER
  startExpires = undefined
  seen = []
  docker = startFakeDocker({ engine: "docker" })
  ssh = await startFakeSsh({
    authorizedKey: () => authorized,
    run: docker.run,
    allowForwarding: true,
    connectTo: (host, port) =>
      host === "127.0.0.1" &&
      port === httpPort &&
      Object.values(docker.state().containers).some(
        (container) => container.state === "running",
      )
        ? { host, port }
        : null,
  })
  http = createHttpServer((request, response) => {
    if (request.url === "/mcp") {
      answerMcp(request, response)
      return
    }

    response.writeHead(request.url === "/health" ? 200 : 404).end("{}")
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  httpPort = (http.address() as AddressInfo).port
})

afterEach(async () => {
  closeAllSshConnections()
  http.closeAllConnections()
  await new Promise<void>((resolve) => http.close(() => resolve()))
  await ssh.close()
  docker.close()
  await cleanup()
})

const SESSIONS: ServiceDefinitionInput = {
  image: `ghcr.io/example/sessions@${DIGEST}`,
  ports: [{ container: 8080 }],
  env: [{ name: "MCP_AUTH_TOKEN", required: true, generated: true }],
  health: { kind: "http", port: 8080, path: "/health" },
  registers: {
    kind: "mcp",
    port: 8080,
    path: "/mcp",
    auth: {
      env: "MCP_AUTH_TOKEN",
      header: "Authorization",
      template: "Bearer {{secret}}",
    },
  },
  signin: {
    style: "paste_code",
    status: { tool: "login_status", signed_in: "signed_in", who: "email" },
    start: { tool: "login_start", url: "url", expires: "expires_at" },
    finish: { tool: "login_finish", argument: "code" },
  },
}

/** The sessions service, launched on a pinned SSH server: its server's id. */
async function launched(
  definition: ServiceDefinitionInput = SESSIONS,
): Promise<{ serviceId: string; serverId: string; message: string }> {
  const { id: hostId } = await createSshServer(ctx, {
    name: "Build box",
    host: "127.0.0.1",
    port: ssh.port,
    username: "deploy",
  })
  authorized = (await getServer(ctx, hostId)).sshPublicKey
  await syncServerTools(ctx, await getServer(ctx, hostId), {
    ...PUBLIC,
    byOwner: true,
  })
  const service = await launchService(
    ctx,
    {
      name: "Claude sessions",
      hostId,
      definition,
      publish: {
        address: "127.0.0.1",
        ports: [{ container: 8080, host: httpPort }],
      },
      env: {},
    },
    FAST,
  )

  return {
    serviceId: service.id,
    serverId: service.registeredId!,
    message: service.message,
  }
}

/** Every file under PCP's data folder (database, log), read as text. */
function everythingKept(): string {
  const texts: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)

      if (statSync(file).isDirectory()) {
        walk(file)
      } else {
        texts.push(readFileSync(file).toString("latin1"))
      }
    }
  }
  walk(dataDir())
  return texts.join("\n")
}

/** A gateway client for a new token that sees every server. */
async function assistant(
  prepare: (tokenId: string) => Promise<void> = async () => {},
): Promise<{ client: Client; tokenId: string }> {
  const { token, id: tokenId } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  })
  await prepare(tokenId)
  const scope = { ...(await resolveApiToken(token))!, ...PUBLIC }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
    serverSide,
  )
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  return { client, tokenId }
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text?: string }> }).content
    .map((part) => part.text ?? "")
    .join("")
}

describe("the owner's sign-in page", { timeout: 30_000 }, () => {
  it("starts a sign-in, takes the code, and says who is signed in", async () => {
    const { serverId, serviceId } = await launched()

    expect(await readServiceSignin(ctx, serverId, PUBLIC)).toEqual({
      signedIn: false,
      who: null,
    })
    // The service's own id finds it too.
    const started = await startServiceSignin(ctx, serviceId, PUBLIC)
    expect(started).toMatchObject({ url: PROVIDER, host: "claude.ai" })
    // Worked out on PCP's machine: the page counts from it, not its clock.
    expect(started.msLeft).toBeGreaterThan(14 * 60_000)
    expect(started.msLeft).toBeLessThanOrEqual(15 * 60_000)
    expect(Date.parse(started.expiresAt!)).toBeGreaterThan(Date.now())
    expect(
      await finishServiceSignin(ctx, serverId, `  ${GOOD_CODE}\n`, PUBLIC),
    ).toEqual({ signedIn: true, who: "ada@example.com" })

    // The calls went with the token PCP made for the service.
    const token = await db().secret.findFirstOrThrow({
      where: { kind: "text" },
      select: { id: true },
    })
    expect(token.id).toBeTruthy()
    expect(new Set(seen.map((each) => each.authorization)).size).toBe(1)
    expect(seen[0]!.authorization).toMatch(/^Bearer [A-Za-z0-9]{40}$/)
  })

  it("says at launch to sign in, or which sign-in tool the server does not serve", async () => {
    expect((await launched()).message).toContain(
      "Sign in to its account on its page to use it.",
    )
  })

  it("names a sign-in tool the server does not serve at launch", async () => {
    const { message } = await launched({
      ...SESSIONS,
      signin: {
        ...SESSIONS.signin!,
        finish: { tool: "login_complete", argument: "code" },
      },
    })
    expect(message).toContain(
      "Its sign-in names login_complete, which it does not serve",
    )
  })

  it("never keeps the code: not in the database, the request log, an answer or an error", async () => {
    const { serverId } = await launched()
    const server = await getServer(ctx, serverId)
    // An assistant's calls write the request log meanwhile.
    const { client } = await assistant()
    await client.callTool(entryCall("connect_account", { server: server.slug }))

    // The owner's page: started, a wrong code, then the right one.
    expect(await startSigninAction(serverId)).toMatchObject({
      status: "ok",
      host: "claude.ai",
    })
    const form = (code: string) => {
      const data = new FormData()
      data.set("id", serverId)
      data.set("code", code)
      return data
    }
    const refused = await finishSigninAction({ status: "idle" }, form(BAD_CODE))
    expect(refused).toMatchObject({ status: "error" })
    expect(JSON.stringify(refused)).not.toContain(BAD_CODE)
    expect(JSON.stringify(refused)).toMatch(
      /did not take the code: The code \[redacted\] did not work/,
    )

    const done = await finishSigninAction({ status: "idle" }, form(GOOD_CODE))
    expect(done).toMatchObject({
      status: "ok",
      signedIn: true,
      who: "ada@example.com",
    })
    expect(JSON.stringify(done)).not.toContain(GOOD_CODE)
    expect(await signinStatusAction(serverId)).toMatchObject({
      status: "ok",
      signedIn: true,
    })
    await client.callTool(entryCall("check_server", { server: server.slug }))
    await client.close()

    // It went to the service, in that one call's arguments.
    expect(seen.some((each) => each.body.includes(GOOD_CODE))).toBe(true)
    // And nowhere in what PCP keeps: its database, the request log.
    expect(readdirSync(path.join(dataDir(), "logs")).length).toBeGreaterThan(0)
    const kept = everythingKept()
    expect(kept).not.toContain(GOOD_CODE)
    expect(kept).not.toContain(BAD_CODE)
    // Read through the vault's key: the servers' status lines and the Log
    // page's lines.
    for (const id of [
      serverId,
      (await db().serviceSpec.findFirstOrThrow()).serverId,
    ]) {
      const row = await getServer(ctx, id)
      expect(JSON.stringify([row.status, row.statusMessage])).not.toMatch(
        new RegExp(`${GOOD_CODE}|${BAD_CODE}`),
      )
    }
    const log = await activityLog(ctx, { limit: 200 })
    expect(log.entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(log)).not.toMatch(
      new RegExp(`${GOOD_CODE}|${BAD_CODE}`),
    )
    for (const table of [
      "permissionRequest",
      "callRecord",
      "toolResult",
    ] as const) {
      expect(
        await (db()[table] as { count: () => Promise<number> }).count(),
        table,
      ).toBe(0)
    }
  })

  it("refuses a code that is empty, too long or more than a line, before anything is sent", async () => {
    const { serverId } = await launched()
    const before = seen.length

    for (const code of ["", "   ", "a".repeat(5000), "one\ntwo"]) {
      await expect(
        finishServiceSignin(ctx, serverId, code, PUBLIC),
      ).rejects.toThrow(/code/)
    }
    expect(seen.length).toBe(before)
  })

  it("calls an end it cannot believe unknown: no time left to count down", async () => {
    const { serverId } = await launched()

    for (const expires of [
      600,
      "1970-01-01T00:10:00Z",
      "2099-01-01T00:00:00Z",
    ]) {
      startExpires = expires
      expect(await startServiceSignin(ctx, serverId, PUBLIC)).toMatchObject({
        expiresAt: null,
        msLeft: null,
      })
    }
  })

  it("scrubs the code from a sign-in tool's own failure", async () => {
    const { serverId } = await launched()
    const code = "rpc-5be81c7a40d2"

    const failed = await finishServiceSignin(ctx, serverId, code, PUBLIC).catch(
      (error: Error) => error,
    )
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).not.toContain(code)
    expect(seen.some((each) => each.body.includes(code))).toBe(true)
  })

  it("shows only an https address the service hands back", async () => {
    const { serverId } = await launched()

    for (const url of [
      "javascript:alert(1)",
      "http://claude.ai/oauth",
      "https://user:pw@claude.ai/",
      "not a url",
    ]) {
      startUrl = url
      await expect(startServiceSignin(ctx, serverId, PUBLIC)).rejects.toThrow(
        /only an https address/,
      )
    }
  })

  it("is for a service that signs in only", async () => {
    const { id } = await createSshServer(ctx, {
      name: "Plain box",
      host: "127.0.0.1",
      port: ssh.port,
      username: "deploy",
    })

    await expect(readServiceSignin(ctx, id, PUBLIC)).rejects.toThrow(
      /not found|no longer/i,
    )
  })
})

describe("an assistant and the sign-in", { timeout: 30_000 }, () => {
  it("connect_account: the link to PCP's page while signed out, who once signed in", async () => {
    const { serverId } = await launched()
    const server = await getServer(ctx, serverId)
    // The token may not call the sign-in's tools itself: PCP's page calls
    // them as the owner's own action, by no token's levels.
    const { client } = await assistant(async (tokenId) => {
      for (const tool of ["login_start", "login_finish"]) {
        await setToolAccess(ctx, tokenId, serverId, tool, "blocked")
      }
    })

    const out = await client.callTool({
      name: "execute_write",
      arguments: {
        tool: "connect_account",
        arguments: { server: server.slug },
      },
    })
    const said = textOf(out)
    expect(out.isError).toBeFalsy()
    expect(out.structuredContent).toMatchObject({
      kind: "needs_owner",
      reason: "signin",
      url: `http://localhost:3000/servers/${serverId}/sign-in`,
      label: "Sign in to Claude sessions in PCP",
      signin: { serverId, slug: server.slug },
    })
    expect(said.split("\n").at(-1)).toBe(
      `[Sign in to Claude sessions in PCP](http://localhost:3000/servers/${serverId}/sign-in)`,
    )
    expect(said).toContain(
      `call check_server with server "${server.slug}" before you send the link again`,
    )

    await finishServiceSignin(ctx, serverId, GOOD_CODE, PUBLIC)
    const now = await client.callTool({
      name: "execute_write",
      arguments: {
        tool: "connect_account",
        arguments: { server: server.slug },
      },
    })
    expect(now.structuredContent).toMatchObject({
      kind: "done",
      signed_in: true,
      who: "ada@example.com",
    })
    expect(textOf(now)).not.toContain(GOOD_CODE)
    await client.close()
  })

  it("connect_account is refused for a server with no sign-in, and runs at Write", async () => {
    const { serviceId } = await launched()
    const service = await getServer(ctx, serviceId)
    const { client } = await assistant()

    const read = await client.callTool({
      name: "execute_read",
      arguments: {
        tool: "connect_account",
        arguments: { server: service.slug },
      },
    })
    expect(read.isError).toBe(true)
    expect(textOf(read)).toMatch(/execute_write/)

    // The service itself names the same account.
    const viaService = await client.callTool(
      entryCall("connect_account", { server: service.slug }),
    )
    expect(viaService.structuredContent).toMatchObject({ reason: "signin" })

    const host = await db().mcpServer.findFirstOrThrow({
      where: { kind: "ssh" },
      select: { id: true },
    })
    const plain = await client.callTool(
      entryCall("connect_account", {
        server: (await getServer(ctx, host.id)).slug,
      }),
    )
    expect(plain.isError).toBe(true)
    expect(textOf(plain)).toMatch(/signs in to no account/)
    await client.close()
  })

  it("a call that fails signed out hands the assistant the sign-in link instead", async () => {
    const { serverId } = await launched()
    const server = await getServer(ctx, serverId)
    const { client } = await assistant((tokenId) =>
      setToolAccess(ctx, tokenId, serverId, "list_sessions", "allowed"),
    )

    const call = async () =>
      client.callTool({
        name: "execute_read",
        arguments: await withCallHandle(client, {
          server: server.slug,
          tool: "list_sessions",
          arguments: {},
        }),
      })

    const out = await call()
    expect(out.structuredContent).toMatchObject({
      kind: "needs_owner",
      reason: "signin",
      url: `http://localhost:3000/servers/${serverId}/sign-in`,
    })
    expect(textOf(out)).toContain("Not signed in to Claude.")

    await finishServiceSignin(ctx, serverId, GOOD_CODE, PUBLIC)
    const again = await call()
    expect(again.isError).toBeFalsy()
    expect(textOf(again)).toContain("sessions")
    await client.close()
  })

  it("check_server says it is signed in once the owner has, waiting while they are at it", async () => {
    const { serverId } = await launched()
    const server = await getServer(ctx, serverId)
    const { client } = await assistant()

    // The owner pastes the code while the check waits.
    const pasted = new Promise((resolve) => setTimeout(resolve, 500)).then(() =>
      finishServiceSignin(ctx, serverId, GOOD_CODE, PUBLIC),
    )
    const out = await client.callTool(
      entryCall("check_server", { server: server.slug }),
    )
    await pasted
    expect(out.structuredContent).toMatchObject({ kind: "done" })
    expect(textOf(out)).toContain(
      "It is signed in to its account as ada@example.com.",
    )
    await client.close()
  })
})

describe(
  "what an assistant may learn, and when PCP reads",
  {
    timeout: 30_000,
  },
  () => {
    it("never calls a status tool that is not a Read tool: no offer, and connect_account says it cannot read it", async () => {
      const { serverId } = await launched()
      const server = await getServer(ctx, serverId)
      await setToolTier(ctx, serverId, "login_status", "write")
      const { client } = await assistant((tokenId) =>
        setToolAccess(ctx, tokenId, serverId, "list_sessions", "allowed"),
      )
      const statusCalls = () =>
        seen.filter((each) => each.body.includes('"login_status"')).length
      const before = statusCalls()

      const asked = await client.callTool(
        entryCall("connect_account", { server: server.slug }),
      )
      expect(asked.isError).toBe(true)
      expect(textOf(asked)).toMatch(
        /cannot read whether Claude sessions is signed in: its status tool login_status is not a Read tool/,
      )

      // The owner's page still signs in: its finish says so, unread.
      await startServiceSignin(ctx, serverId, PUBLIC)
      expect(
        await finishServiceSignin(ctx, serverId, GOOD_CODE, PUBLIC),
      ).toEqual({ signedIn: true, who: null })
      account = null

      const failed = await client.callTool({
        name: "execute_read",
        arguments: await withCallHandle(client, {
          server: server.slug,
          tool: "list_sessions",
          arguments: {},
        }),
      })
      expect(failed.isError).toBe(true)
      expect(failed.structuredContent ?? {}).not.toMatchObject({
        reason: "signin",
      })
      expect(textOf(failed)).toContain("Not signed in to Claude.")
      expect(statusCalls()).toBe(before)
      await client.close()
    })

    it("leaves what the service said out of the sign-in link when the call keeps a part", async () => {
      const { serverId } = await launched()
      const server = await getServer(ctx, serverId)
      const { client } = await assistant((tokenId) =>
        setToolAccess(ctx, tokenId, serverId, "list_sessions", "allowed"),
      )

      const out = await client.callTool({
        name: "execute_read",
        arguments: {
          ...(await withCallHandle(client, {
            server: server.slug,
            tool: "list_sessions",
            arguments: {},
          })),
          keep: ["sessions"],
        },
      })
      expect(out.structuredContent).toMatchObject({ reason: "signin" })
      expect(textOf(out)).not.toContain("Not signed in to Claude.")
      await client.close()
    })

    it("passes a signed-in service's own error on as it came", async () => {
      const { serverId } = await launched()
      const server = await getServer(ctx, serverId)
      await finishServiceSignin(ctx, serverId, GOOD_CODE, PUBLIC)
      const { client } = await assistant((tokenId) =>
        setToolAccess(ctx, tokenId, serverId, "fail_always", "allowed"),
      )

      const out = await client.callTool({
        name: "execute_read",
        arguments: await withCallHandle(client, {
          server: server.slug,
          tool: "fail_always",
          arguments: {},
        }),
      })
      expect(out.isError).toBe(true)
      expect(textOf(out)).toContain("Boom: the service failed.")
      expect(out.structuredContent ?? {}).not.toMatchObject({
        kind: "needs_owner",
      })
      await client.close()
    })

    it("tells a token with every tool of the server blocked only whether it is signed in", async () => {
      const { serverId, serviceId } = await launched()
      const service = await getServer(ctx, serviceId)
      await finishServiceSignin(ctx, serverId, GOOD_CODE, PUBLIC)
      const { client } = await assistant(async (tokenId) => {
        for (const tool of TOOLS) {
          await setToolAccess(ctx, tokenId, serverId, tool.name, "blocked")
        }
      })

      const out = await client.callTool(
        entryCall("connect_account", { server: service.slug }),
      )
      expect(out.structuredContent).toMatchObject({
        kind: "done",
        signed_in: true,
        who: null,
      })
      expect(textOf(out)).not.toContain("ada@example.com")

      const checked = await client.callTool(
        entryCall("check_server", { server: service.slug }),
      )
      expect(textOf(checked)).toContain("It is signed in to its account.")
      expect(textOf(checked)).not.toContain("ada@example.com")
      await client.close()
    })
  },
)

describe("signinCheck", { timeout: 30_000 }, () => {
  it("hands the sign-in link back when it is still not signed in after the wait", async () => {
    const { serverId } = await launched()
    const server = await getServer(ctx, serverId)
    let waited = false
    const answer = await signinCheck(ctx, server, {
      ...PUBLIC,
      call: async () => ({
        content: [{ type: "text", text: '{"signed_in": false}' }],
      }),
      wait: async () => {
        waited = true
        return null
      },
    })

    expect(waited).toBe(true)
    expect(
      answer && "result" in answer && answer.result.structuredContent,
    ).toMatchObject({ reason: "signin" })
  })

  it("names no line for a server with no sign-in", async () => {
    await launched()
    const plain = await db().mcpServer.findFirstOrThrow({
      where: { kind: "ssh" },
    })

    expect(
      await signinCheck(ctx, plain, {
        ...PUBLIC,
        call: async () => ({ content: [] }),
        wait: async () => null,
      }),
    ).toBeNull()
  })
})

describe("the sign-in's own checks", () => {
  it("reads an https address only", () => {
    expect(checkSigninUrl(PROVIDER, "S").host).toBe("claude.ai")
    expect(() => checkSigninUrl("ftp://x", "S")).toThrow(/https/)
    expect(() => checkSigninUrl(42, "S")).toThrow(/https/)
  })

  it("reads when a sign-in ends as a time or an epoch", () => {
    const now = Date.parse("2030-01-01T00:00:00Z")
    const later = now + 15 * 60_000

    expect(readExpiry("2030-01-01T00:15:00Z", now)).toBe(later)
    expect(readExpiry(later / 1000, now)).toBe(later)
    expect(readExpiry(later, now)).toBe(later)
    // A duration (expires_in: 600) reads as 1970: past, so unknown.
    expect(readExpiry(600, now)).toBeNull()
    expect(readExpiry("600", now)).toBeNull()
    // Now or past, or more than a day ahead: unknown.
    expect(readExpiry(now, now)).toBeNull()
    expect(readExpiry("2029-12-31T23:00:00Z", now)).toBeNull()
    expect(readExpiry(now + 25 * 60 * 60_000, now)).toBeNull()
    expect(readExpiry("soon", now)).toBeNull()
    expect(readExpiry(undefined, now)).toBeNull()
  })

  it("hands over PCP's page last, labelled, with check_server for later", () => {
    const result = signinResult(
      { id: "s1", slug: "sessions", name: "Sessions" },
      "https://pcp.x/",
    )
    const said = (result.content[0] as { text: string }).text

    expect(said.split("\n").at(-1)).toBe(
      "[Sign in to Sessions in PCP](https://pcp.x/servers/s1/sign-in)",
    )
    expect(said).toMatch(/you never see the code/)
  })
})
