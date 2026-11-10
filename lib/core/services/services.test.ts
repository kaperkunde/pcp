import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { exportVault, readExport, restoreExport } from "../backup"
import type { VaultContext } from "../context"
import { db } from "../db"
import { downloadSpec } from "../endpoints"
import { createSecret, deleteSecret, updateSecret } from "../secrets"
import { secretUses } from "../secret-uses"
import { deleteServer, getServer } from "../servers"
import { startFakeSsh, type FakeSsh } from "../ssh/fake-server"
import { createSshServer } from "../ssh/hosts"
import { scratchDatabase } from "../test-db"
import { closeAllSshConnections } from "../ssh/client"
import {
  embeddingProvider,
  callServerTool,
  checkServiceImage,
  launchService,
  readServiceStatus,
  reconcileServices,
  recreateService,
  removeService,
  restartServicesUsingSecret,
  runServiceAction,
  serviceStateLine,
  syncServerTools,
  updateService,
} from "../upstream"
import { setupVault } from "../vault"
import {
  forgetResourceLimits,
  getResourceConfig,
  useResourceConfig,
} from "../resources/state"
import { keepBytes, resultKeepers, resultOpener } from "../tool-results"
import { createApiToken, resolveApiToken } from "../api-tokens"
import { decidePermission, getPermissionView, runCall } from "../permissions"
import {
  fakeRepositoryTarball,
  startFakeDocker,
  type FakeDocker,
} from "./fake-docker"
import {
  parseServiceDefinition,
  type ServiceDefinitionInput,
} from "./definition"
import {
  saveServiceSettings,
  serviceDial,
  serviceOfDefinition,
  serviceView,
  statusWords,
  writeServiceDefinition,
  type ServiceLaunchInput,
} from "./services"
import { secretNameWhere } from "../secret-meta"

// Services end to end in the core: launched by the owner on an SSH server
// (the test server on 127.0.0.1) whose login runs commands in a real sh,
// with a fake `docker` on its PATH that records what it was given; what the
// service serves is an HTTP server of the test's own, at the port the
// container is published on, which PCP reaches through the SSH connection:
// the test server's forwarding opens it while the container runs.

const PUBLIC = { publicUrl: "http://localhost:3000" }
const FAST = { ...PUBLIC, timing: { waitMs: 1500, intervalMs: 50 } }
const API_KEY = "sk-service-secret-value-1234"
const DIGEST = `sha256:${"a".repeat(64)}`

let cleanup: () => Promise<void>
let ctx: VaultContext
let ssh: FakeSsh
let docker: FakeDocker
let authorized: string | null
let http: Server
let httpPort: number
/** What the test's HTTP server answers, by path. */
let answers: Record<string, { status: number; body: string }>
/** Whether the SSH server lets PCP open channels (TCP forwarding on). */
let forwarding: boolean
/** The tools the MCP server at /mcp lists. */
let mcpTools: Array<{ name: string; description: string }>
/** The Authorization the MCP server at /mcp asks for; null asks for none. */
let mcpAuthorization: string | null
/** The Authorization each request to /mcp came with. */
let mcpSeen: Array<string | null>

const SPEC = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Docs", version: "1" },
  paths: {
    "/things": {
      get: {
        operationId: "list_things",
        summary: "Lists things",
        responses: { "200": { description: "ok" } },
      },
    },
  },
})

/**
 * Just enough of an MCP server, over Streamable HTTP with JSON answers:
 * initialize, its notification and tools/list.
 */
function answerMcp(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") {
    response.writeHead(405).end()
    return
  }

  const authorization = request.headers.authorization ?? null
  mcpSeen.push(authorization)

  if (mcpAuthorization !== null && authorization !== mcpAuthorization) {
    response.writeHead(401).end()
    return
  }

  let body = ""
  request.on("data", (chunk: Buffer) => (body += chunk.toString()))
  request.on("end", () => {
    const message = JSON.parse(body) as {
      id?: number
      method: string
      params?: { protocolVersion?: string }
    }

    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }

    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "docs", version: "1" },
          }
        : message.method === "tools/list"
          ? {
              tools: mcpTools.map((tool) => ({
                ...tool,
                inputSchema: { type: "object" },
              })),
            }
          : {}

    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
  })
}

async function startHttp(port = 0) {
  http = createHttpServer((request, response) => {
    if (request.url === "/mcp") {
      answerMcp(request, response)
      return
    }

    const answer = answers[request.url ?? ""] ?? { status: 404, body: "no" }
    response.writeHead(answer.status, { "content-type": "application/json" })
    response.end(answer.body)
  })
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve))
  httpPort = (http.address() as AddressInfo).port
}

async function setup(engine: "docker" | "podman" = "docker") {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  authorized = null
  forwarding = true
  mcpTools = [{ name: "convert", description: "Converts a document" }]
  mcpAuthorization = null
  mcpSeen = []
  docker = startFakeDocker({ engine })
  ssh = await startFakeSsh({
    authorizedKey: () => authorized,
    run: docker.run,
    allowForwarding: true,
    // The SSH server's own 127.0.0.1 at the published port: the test's
    // HTTP server, while a container runs (a stopped one refuses).
    connectTo: (host, port) =>
      forwarding &&
      host === "127.0.0.1" &&
      port === httpPort &&
      Object.values(docker.state().containers).some(
        (container) => container.state === "running",
      )
        ? { host, port }
        : null,
  })
  answers = {
    "/health": { status: 200, body: "{}" },
    "/openapi.json": { status: 200, body: SPEC },
    "/things": { status: 200, body: "[]" },
  }
  await startHttp()
}

async function teardown() {
  closeAllSshConnections()
  http.closeAllConnections()
  await new Promise<void>((resolve) => http.close(() => resolve()))
  await ssh.close()
  docker.close()
  await cleanup()
}

/** The owner's SSH server, its key in authorized_keys and its host key pinned. */
async function pinnedHost(): Promise<string> {
  const { id } = await createSshServer(ctx, {
    name: "Build box",
    host: "127.0.0.1",
    port: ssh.port,
    username: "deploy",
  })
  authorized = (await getServer(ctx, id)).sshPublicKey
  await syncServerTools(ctx, await getServer(ctx, id), {
    ...PUBLIC,
    byOwner: true,
  })
  return id
}

function definition(
  change: Partial<ServiceDefinitionInput> = {},
): ServiceDefinitionInput {
  return {
    image: `ghcr.io/example/docs@${DIGEST}`,
    source: "ghcr.io/example/docs:latest",
    ports: [{ container: 5001 }],
    env: [
      { name: "API_KEY", required: true },
      { name: "LOG_LEVEL", value: "info" },
    ],
    volumes: [{ name: "data", path: "/data" }],
    health: { kind: "http", port: 5001, path: "/health" },
    registers: {
      kind: "openapi",
      port: 5001,
      specPath: "/openapi.json",
      auth: { env: "API_KEY", header: "X-Api-Key", template: "{{secret}}" },
    },
    ...change,
  }
}

/** What a service that serves an MCP server registers, with no header. */
const MCP = { kind: "mcp", port: 5001, path: "/mcp" } as const
/** The same, sending API_KEY's secret as a bearer token. */
const MCP_WITH_AUTH = {
  ...MCP,
  auth: {
    env: "API_KEY",
    header: "Authorization",
    template: "Bearer {{secret}}",
  },
} as const

async function launchInput(
  hostId: string,
  change: Partial<ServiceLaunchInput> = {},
): Promise<ServiceLaunchInput> {
  const secret = await db().secret.findFirst({
    where: secretNameWhere(ctx, "docs-key"),
  })
  const secretId =
    secret?.id ??
    (await createSecret(ctx, { name: "docs-key", value: API_KEY })).id

  return {
    name: "Docs",
    description: "Turns documents into text.",
    hostId,
    definition: definition(),
    publish: {
      address: "127.0.0.1",
      ports: [{ container: 5001, host: httpPort }],
    },
    env: { API_KEY: secretId },
    ...change,
  }
}

/** Everything the SSH server was asked to run, and the engine's words. */
function everythingSent(): string {
  return JSON.stringify([docker.commands, docker.state().calls])
}

describe("launching a service", { timeout: 30_000 }, () => {
  beforeEach(() => setup())
  afterEach(teardown)

  it("runs the container and registers the endpoint it serves, in one step", async () => {
    const hostId = await pinnedHost()
    const launched = await launchService(ctx, await launchInput(hostId), FAST)

    expect(launched.registeredKind).toBe("openapi")
    const service = await getServer(ctx, launched.id)
    expect(service.kind).toBe("service")
    expect(service.tools.map((tool) => tool.name).sort()).toEqual([
      "logs",
      "restart",
      "start",
      "status",
      "stop",
      "update",
    ])

    const endpoint = await getServer(ctx, launched.registeredId!)
    expect(endpoint.kind).toBe("openapi")
    expect(endpoint.url).toBe(`http://127.0.0.1:${httpPort}`)
    expect(endpoint.publicOnly).toBe(false)
    expect(endpoint.authType).toBe("header")
    expect(endpoint.authHeaderName).toBe("X-Api-Key")
    expect(endpoint.tools.map((tool) => tool.name)).toEqual(["list_things"])

    const state = docker.state()
    const container = state.containers["pcp-docs"]!
    expect(container.label).toBe(launched.id)
    expect(container.image).toBe(`ghcr.io/example/docs@${DIGEST}`)
    expect(container.publish).toEqual([`127.0.0.1:${httpPort}:5001`])
    expect(container.volumes).toEqual(["pcp-docs-data:/data"])
    // The values reached the engine through the env file only.
    expect(container.env).toBe(`LOG_LEVEL=info\nAPI_KEY=${API_KEY}\n`)
    expect(everythingSent()).not.toContain(API_KEY)
    // And the file is gone.
    expect(docker.leftovers()).toEqual([])
    expect(state.calls[0]).toEqual([
      "version",
      "--format",
      "{{.Server.Version}}",
    ])
  })

  it("launches another of a service's definition, which both share", async () => {
    const hostId = await pinnedHost()
    const first = await launchService(ctx, await launchInput(hostId), FAST)
    const definitionId = (await getServer(ctx, first.id)).definitionId!
    const shared = await serviceOfDefinition(ctx, definitionId)

    expect(shared.definition.image).toBe(`ghcr.io/example/docs@${DIGEST}`)

    const second = await launchService(
      ctx,
      await launchInput(hostId, {
        name: "Docs two",
        // What another instance brings: its own part only.
        definition: undefined,
        definitionId,
      }),
      FAST,
    )
    const row = await getServer(ctx, second.id)

    expect(row.definitionId).toBe(definitionId)
    expect(docker.state().containers["pcp-docs-two"]!.image).toBe(
      `ghcr.io/example/docs@${DIGEST}`,
    )
    await expect(
      serviceOfDefinition(
        ctx,
        (await getServer(ctx, first.registeredId!)).definitionId!,
      ),
    ).rejects.toThrow(/for an API endpoint/)
  })

  it("finds Podman when that is what the login has", async () => {
    await teardown()
    await setup("podman")
    const hostId = await pinnedHost()
    const launched = await launchService(ctx, await launchInput(hostId), FAST)
    const spec = await db().serviceSpec.findUniqueOrThrow({
      where: { serverId: launched.id },
    })
    expect(spec.engine).toBe("podman")
    expect(docker.commands.some((line) => line.includes("podman run"))).toBe(
      true,
    )
  })

  it("does not connect to an SSH server whose host key the owner has not pinned", async () => {
    const { id } = await createSshServer(ctx, {
      name: "New box",
      host: "127.0.0.1",
      port: ssh.port,
      username: "deploy",
    })
    await expect(
      launchService(ctx, await launchInput(id), FAST),
    ).rejects.toThrow(/not pinned/)
    expect(docker.commands).toEqual([])
  })

  it("checks everything it can before connecting", async () => {
    const hostId = await pinnedHost()
    const before = docker.commands.length
    const input = await launchInput(hostId)

    await expect(
      launchService(ctx, { ...input, env: {} }, FAST),
    ).rejects.toThrow(/API_KEY/)
    await expect(
      launchService(
        ctx,
        { ...input, definition: definition({ image: "docs:latest" }) },
        FAST,
      ),
    ).rejects.toThrow(/digest/)
    await expect(
      launchService(
        ctx,
        {
          ...input,
          publish: {
            address: "box; id",
            ports: [{ container: 5001, host: 1 }],
          },
        },
        FAST,
      ),
    ).rejects.toThrow(/IP address/)
    await expect(
      launchService(ctx, { ...input, hostId: "nope" }, FAST),
    ).rejects.toThrow(/SSH servers/)
    expect(docker.commands.length).toBe(before)
  })

  it("reaches what it serves through the SSH connection, on the SSH server's loopback", async () => {
    const hostId = await pinnedHost()
    const launched = await launchService(ctx, await launchInput(hostId), FAST)
    const spec = await db().serviceSpec.findUniqueOrThrow({
      where: { serverId: launched.id },
    })

    expect(spec.reach).toBe("tunnel")
    expect(spec.intendedState).toBe("running")
    // Its health check and its schema came through a channel to the
    // published port on the SSH server's own 127.0.0.1.
    expect(ssh.forwards).toContain(`127.0.0.1:${httpPort}`)
    const before = ssh.forwards.length
    const endpoint = await getServer(ctx, launched.registeredId!)
    const listed = await callServerTool(
      ctx,
      endpoint,
      "list_things",
      {},
      PUBLIC,
    )
    expect(listed.isError).toBeFalsy()
    expect(ssh.forwards.length).toBeGreaterThan(before)
    // Only ever to the port it publishes, nothing else on that machine.
    expect(new Set(ssh.forwards)).toEqual(new Set([`127.0.0.1:${httpPort}`]))
  })

  it("registers an MCP server it serves and reads its tools through the SSH connection", async () => {
    const hostId = await pinnedHost()
    const launched = await launchService(
      ctx,
      await launchInput(hostId, {
        definition: definition({
          env: [],
          registers: { kind: "mcp", port: 5001, path: "/mcp" },
        }),
        env: {},
      }),
      FAST,
    )

    expect(launched.registeredKind).toBe("mcp")
    const server = await getServer(ctx, launched.registeredId!)
    expect(server.url).toBe(`http://127.0.0.1:${httpPort}/mcp`)
    expect(server.tools.map((tool) => tool.name)).toEqual(["convert"])
    expect(ssh.forwards).toContain(`127.0.0.1:${httpPort}`)
  })

  it("registers an MCP server that sends the secret its definition names in a header", async () => {
    const hostId = await pinnedHost()
    mcpAuthorization = `Bearer ${API_KEY}`
    const launched = await launchService(
      ctx,
      await launchInput(hostId, {
        definition: definition({ registers: MCP_WITH_AUTH }),
      }),
      FAST,
    )
    const secret = await db().secret.findFirstOrThrow({
      where: secretNameWhere(ctx, "docs-key"),
    })
    const server = await getServer(ctx, launched.registeredId!)

    expect(server).toMatchObject({
      kind: "mcp",
      authType: "header",
      authHeaderName: "Authorization",
      authValueTemplate: "Bearer {{secret}}",
      authSecretId: secret.id,
    })
    expect(server.tools.map((tool) => tool.name)).toEqual(["convert"])
    expect(mcpSeen.length).toBeGreaterThan(0)
    expect(new Set(mcpSeen)).toEqual(new Set([`Bearer ${API_KEY}`]))
  })

  it("refuses to launch an MCP server with a header before its variable has a secret", async () => {
    const hostId = await pinnedHost()
    const before = docker.commands.length

    await expect(
      launchService(
        ctx,
        await launchInput(hostId, {
          definition: definition({
            env: [{ name: "API_KEY" }],
            registers: MCP_WITH_AUTH,
          }),
          env: {},
        }),
        FAST,
      ),
    ).rejects.toThrow(
      /Choose the secret for API_KEY: the MCP server sends it in Authorization/,
    )
    expect(docker.commands.length).toBe(before)
  })

  it("takes everything back when the SSH server does not let PCP through", async () => {
    const hostId = await pinnedHost()
    forwarding = false

    const failure = await launchService(
      ctx,
      await launchInput(hostId),
      FAST,
    ).catch((error: Error) => error)

    expect((failure as Error).message).toMatch(/did not become healthy/)
    expect((failure as Error).message).toMatch(/health check did not answer/)
    expect(docker.state().containers).toEqual({})
    expect(await db().serviceSpec.count()).toBe(0)
  })

  it("publishes on the SSH server's network only when the owner chooses it", async () => {
    const hostId = await pinnedHost()
    const launched = await launchService(
      ctx,
      await launchInput(hostId, {
        publish: {
          address: "0.0.0.0",
          ports: [{ container: 5001, host: httpPort }],
        },
      }),
      FAST,
    )

    expect(docker.state().containers["pcp-docs"]!.publish).toEqual([
      `0.0.0.0:${httpPort}:5001`,
    ])
    // PCP still goes through the SSH connection, to the loopback.
    const endpoint = await getServer(ctx, launched.registeredId!)
    expect(endpoint.url).toBe(`http://127.0.0.1:${httpPort}`)
    expect((await serviceView(ctx, launched.id)).reach).toBe("tunnel")
  })

  it("takes everything back when the container does not stay up", async () => {
    const hostId = await pinnedHost()
    docker.update((state) => {
      state.runState = "exited"
      state.logs = `boot failed with API_KEY=${API_KEY}\n`
    })

    const failure = await launchService(
      ctx,
      await launchInput(hostId),
      FAST,
    ).catch((error: Error) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/exited with code 1/)
    expect((failure as Error).message).toMatch(/removed the container pcp-docs/)
    // Its logs are quoted, without the secret.
    expect((failure as Error).message).toContain("API_KEY=[redacted]")
    expect((failure as Error).message).not.toContain(API_KEY)
    expect(docker.state().containers).toEqual({})
    expect(docker.state().volumesRemoved).toEqual(["pcp-docs-data"])
    expect(
      await db().mcpServer.count({ where: { kind: { not: "ssh" } } }),
    ).toBe(0)
    expect(await db().serviceSpec.count()).toBe(0)
  })

  it("takes the container and the volumes it made back when the engine cannot start it", async () => {
    const hostId = await pinnedHost()
    docker.update((state) => {
      state.runFailsAfterCreate =
        "Error response from daemon: driver failed programming external connectivity: Bind for 127.0.0.1:5001 failed: port is already allocated"
    })

    const failure = await launchService(
      ctx,
      await launchInput(hostId),
      FAST,
    ).catch((error: Error) => error)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toMatch(/port is already allocated/)
    expect(message).toMatch(
      /PCP removed the container pcp-docs and the volume pcp-docs-data it made from Build box\./,
    )
    expect(docker.state().containers).toEqual({})
    expect(docker.state().volumes).toEqual([])
    expect(docker.state().volumesRemoved).toEqual(["pcp-docs-data"])
    expect(await db().serviceSpec.count()).toBe(0)
  })

  it("keeps a volume that was there before, and says so", async () => {
    const hostId = await pinnedHost()
    docker.update((state) => {
      state.volumes = ["pcp-docs-data"]
      state.runFailsAfterCreate = "Error: port is already allocated"
    })

    const failure = await launchService(
      ctx,
      await launchInput(hostId),
      FAST,
    ).catch((error: Error) => error)

    expect((failure as Error).message).toMatch(
      /removed the container pcp-docs from Build box and kept the volume pcp-docs-data, which was there before/,
    )
    expect(docker.state().volumes).toEqual(["pcp-docs-data"])
    expect(docker.state().volumesRemoved).toEqual([])
  })

  it("says what is left on the SSH server when the engine will not remove it", async () => {
    const hostId = await pinnedHost()
    docker.update((state) => {
      state.runState = "exited"
      state.failRm = "Error response from daemon: device or resource busy"
    })

    const failure = await launchService(
      ctx,
      await launchInput(hostId),
      FAST,
    ).catch((error: Error) => error)

    expect((failure as Error).message).toMatch(/exited with code 1/)
    expect((failure as Error).message).toMatch(
      /could not take everything back on Build box \(Build box did not remove the container pcp-docs: Error response from daemon: device or resource busy\): remove the container pcp-docs and the volume pcp-docs-data there by hand/,
    )
    expect(await db().serviceSpec.count()).toBe(0)
  })

  it("quotes the first and the last of a long log", async () => {
    const hostId = await pinnedHost()
    docker.update((state) => {
      state.runState = "exited"
      state.logs = Array.from({ length: 50 }, (_, at) => `line ${at + 1}`)
        .join("\n")
        .concat("\n")
    })

    const message = await launchService(ctx, await launchInput(hostId), FAST)
      .then(() => "")
      .catch((error: Error) => error.message)

    expect(message).toMatch(/Its first lines:\nline 1\n/)
    expect(message).toMatch(/line 10\n…\nIts last lines:\nline 41\n/)
    expect(message).not.toContain("line 25\n")
  })

  it("takes everything back when what it serves cannot be registered", async () => {
    const hostId = await pinnedHost()
    answers["/openapi.json"] = { status: 404, body: "missing" }

    await expect(
      launchService(ctx, await launchInput(hostId), FAST),
    ).rejects.toThrow(/took the service out of PCP/)
    expect(docker.state().containers).toEqual({})
    expect(
      await db().mcpServer.count({ where: { kind: { not: "ssh" } } }),
    ).toBe(0)
    expect(await db().serverDefinition.count()).toBe(0)
  })

  it("waits for the health check, and gives up when it never passes", async () => {
    const hostId = await pinnedHost()
    answers["/health"] = { status: 503, body: "starting" }

    await expect(
      launchService(ctx, await launchInput(hostId), FAST),
    ).rejects.toThrow(/HTTP 503/)
    expect(docker.state().containers).toEqual({})
  })
})

describe("a running service", { timeout: 30_000 }, () => {
  beforeEach(() => setup())
  afterEach(teardown)

  async function launched() {
    const hostId = await pinnedHost()
    const result = await launchService(ctx, await launchInput(hostId), FAST)
    return {
      ...result,
      service: await getServer(ctx, result.id),
      endpoint: await getServer(ctx, result.registeredId!),
    }
  }

  function textOf(result: { content: unknown }): string {
    return (result.content as Array<{ text: string }>)[0]!.text
  }

  it("says how it is through its status tool", async () => {
    const { service, endpoint } = await launched()
    const result = await callServerTool(ctx, service, "status", {}, PUBLIC)
    const answer = JSON.parse(textOf(result)) as Record<string, unknown>

    expect(result.isError).toBeFalsy()
    expect(answer).toMatchObject({
      state: "running",
      health: "healthy",
      image: `ghcr.io/example/docs@${DIGEST}`,
      engine: "docker 27.3.1",
      host: "Build box",
      serves: endpoint.slug,
      serves_kind: "API endpoint",
    })
  })

  it("reads its logs with the secrets taken out, within bounds", async () => {
    const { service } = await launched()
    docker.update((state) => {
      state.logs = `2026-10-29T10:00:00Z key is ${API_KEY}\n`
    })

    const result = await callServerTool(
      ctx,
      service,
      "logs",
      { lines: 10, since_minutes: 60 },
      PUBLIC,
    )
    expect(textOf(result)).toContain("key is [redacted]")
    expect(textOf(result)).not.toContain(API_KEY)
    expect(docker.state().calls.at(-1)).toEqual([
      "logs",
      "--timestamps",
      "--tail",
      "10",
      "--since",
      "60m",
      "pcp-docs",
    ])
  })

  it.each([
    ["logs", { lines: 0 }],
    ["logs", { lines: 501 }],
    ["logs", { lines: 1.5 }],
    ["logs", { since_minutes: 0 }],
    ["logs", { since_minutes: 7 * 24 * 60 + 1 }],
    ["logs", { tail: 5 }],
    ["status", { verbose: true }],
    ["stop", { force: true }],
    ["exec", {}],
  ])("refuses %s with %j before anything connects", async (tool, args) => {
    const { service } = await launched()
    const before = docker.commands.length
    const refused = await callServerTool(ctx, service, tool, args, PUBLIC)
    expect(refused.isError).toBe(true)
    expect(refused._meta).toEqual({
      "gg.pcp/error": {
        code: tool === "exec" ? "not_found" : "invalid_arguments",
      },
    })
    expect(docker.commands.length).toBe(before)
  })

  it("stops and starts, and a stopped service's tools say so", async () => {
    const { service, endpoint } = await launched()

    const stopped = await callServerTool(ctx, service, "stop", {}, PUBLIC)
    expect(JSON.parse(textOf(stopped))).toMatchObject({ state: "exited" })
    expect(
      (
        await db().serviceSpec.findUniqueOrThrow({
          where: { serverId: service.id },
        })
      ).intendedState,
    ).toBe("stopped")
    expect(docker.state().calls).toContainEqual([
      "stop",
      "--time",
      "30",
      "pcp-docs",
    ])

    // What it serves is gone with it.
    await new Promise<void>((resolve) => http.close(() => resolve()))
    const failure = await callServerTool(
      ctx,
      endpoint,
      "list_things",
      {},
      PUBLIC,
    ).catch((error: Error) => error)
    expect((failure as Error).message).toMatch(/Docs service is stopped/)
    // Stopped through PCP, it stays stopped: the call starts nothing.
    expect((failure as Error).message).toMatch(/stopped through PCP/)
    expect(docker.state().calls.filter((call) => call[0] === "start")).toEqual(
      [],
    )
    expect((failure as Error).message).toContain(`${service.slug}/start`)
    expect((failure as Error).message).toContain(
      `page in PCP](http://localhost:3000/servers/${service.id})`,
    )
    expect(await serviceStateLine(ctx, endpoint, PUBLIC.publicUrl)).toMatch(
      /stopped/,
    )

    // Started again (by the owner here), it serves again.
    await startHttp(httpPort)
    const status = await runServiceAction(ctx, service.id, "start", FAST)
    expect(status).toMatchObject({ state: "running", health: "healthy" })
    expect(
      (
        await db().serviceSpec.findUniqueOrThrow({
          where: { serverId: service.id },
        })
      ).intendedState,
    ).toBe("running")
    expect(docker.state().containers["pcp-docs"]!.state).toBe("running")
    const listed = await callServerTool(
      ctx,
      endpoint,
      "list_things",
      {},
      PUBLIC,
    )
    expect(listed.isError).toBeFalsy()
  })

  it("embeds search's text through the SSH connection, starting the service once if it stopped", async () => {
    const { endpoint } = await launched()
    answers["/v1/embeddings"] = {
      status: 200,
      body: JSON.stringify({ data: [{ index: 0, embedding: [0.5, 0.5] }] }),
    }
    const provider = await embeddingProvider(
      ctx,
      {
        provider: "endpoint",
        serverId: endpoint.id,
        model: "",
        embed: { tools: true, skills: true, memories: true },
      },
      PUBLIC.publicUrl,
    )
    const before = ssh.forwards.length

    const vectors = await provider.embed(
      ["PCP search"],
      "query",
      AbortSignal.timeout(10_000),
    )

    expect(vectors.map((vector) => [...vector])).toEqual([[0.5, 0.5]])
    expect(ssh.forwards.length).toBeGreaterThan(before)

    // The SSH server restarted and the engine did not start it again.
    docker.update((state) => {
      state.containers["pcp-docs"]!.state = "exited"
    })

    const again = await provider.embed(
      ["PCP search"],
      "query",
      AbortSignal.timeout(10_000),
    )

    expect(again).toHaveLength(1)
    expect(docker.state().calls).toContainEqual(["start", "pcp-docs"])
  })

  it("starts a service left running when a call finds its container stopped, and tries once more", async () => {
    const { endpoint } = await launched()
    // The SSH server restarted, and the engine did not start it again.
    docker.update((state) => {
      state.containers["pcp-docs"]!.state = "exited"
    })

    const result = await callServerTool(
      ctx,
      endpoint,
      "list_things",
      {},
      PUBLIC,
    )

    expect(result.isError).toBeFalsy()
    // The answer first, as ever; what PCP did after it.
    const parts = result.content as Array<{ text: string }>
    expect(parts[0]!.text).toBe("[]")
    expect(parts.at(-1)!.text).toBe(
      "PCP started the service Docs service (docs-service), which was stopped, for this call.",
    )
    expect(docker.state().calls).toContainEqual(["start", "pcp-docs"])
    expect(docker.state().containers["pcp-docs"]!.state).toBe("running")
  })

  it("says why when a call's start does not work", async () => {
    const { endpoint } = await launched()
    docker.update((state) => {
      state.containers["pcp-docs"]!.state = "exited"
    })
    answers["/health"] = { status: 503, body: "broken" }

    const failure = await callServerTool(
      ctx,
      endpoint,
      "list_things",
      {},
      { ...PUBLIC },
    ).catch((error: Error) => error)

    expect((failure as Error).message).toMatch(
      /could not be reached\. Docs service was stopped, and PCP could not start it: .*HTTP 503/,
    )
  }, 90_000)

  it("brings services left running back up after a request, at most once in a while", async () => {
    const { service } = await launched()
    docker.update((state) => {
      state.containers["pcp-docs"]!.state = "exited"
    })
    const now = Date.now() + 60 * 60_000

    expect(await reconcileServices(ctx, PUBLIC, { now })).toEqual({
      started: [service.id],
    })
    expect(docker.state().containers["pcp-docs"]!.state).toBe("running")
    expect(await reconcileServices(ctx, PUBLIC, { now: now + 1000 })).toEqual({
      started: [],
      skipped: "recent",
    })

    // One stopped through PCP stays stopped.
    await runServiceAction(ctx, service.id, "stop", FAST)
    const before = docker.state().calls.length
    expect(
      await reconcileServices(ctx, PUBLIC, { now: now + 60 * 60_000 }),
    ).toEqual({ started: [] })
    expect(docker.state().containers["pcp-docs"]!.state).toBe("exited")
    expect(docker.state().calls.length).toBe(before)
  })

  it("reaches a service launched before tunnels directly, until it is made again", async () => {
    const { service, endpoint } = await launched()
    await db().serviceSpec.update({
      where: { serverId: service.id },
      data: { reach: "direct" },
    })
    const before = ssh.forwards.length

    const direct = await callServerTool(
      ctx,
      endpoint,
      "list_things",
      {},
      PUBLIC,
    )
    expect(direct.isError).toBeFalsy()
    expect(ssh.forwards.length).toBe(before)

    await updateService(ctx, service.id, FAST)
    expect(
      (
        await db().serviceSpec.findUniqueOrThrow({
          where: { serverId: service.id },
        })
      ).reach,
    ).toBe("tunnel")
    const tunnelled = await callServerTool(
      ctx,
      endpoint,
      "list_things",
      {},
      PUBLIC,
    )
    expect(tunnelled.isError).toBeFalsy()
    expect(ssh.forwards.length).toBeGreaterThan(before)
  })

  it("never reaches a tunnelled service's endpoint from PCP's machine", async () => {
    const { endpoint } = await launched()
    // Its SSH server's host key forgotten: no channel, and no way around.
    await db().mcpServer.updateMany({
      where: { kind: "ssh" },
      data: { sshHostKey: null },
    })
    closeAllSshConnections()

    await expect(
      callServerTool(ctx, endpoint, "list_things", {}, PUBLIC),
    ).rejects.toThrow(/not pinned/)
    await expect(downloadSpec(endpoint)).rejects.toThrow(
      /re-read its schema on its page/,
    )
    const sync = await syncServerTools(ctx, endpoint, PUBLIC)
    expect(sync.status).toBe("error")
    expect(sync.message).toMatch(/not pinned/)
  })

  it("makes the container again when a secret it takes changes", async () => {
    const { service } = await launched()
    const secret = await db().secret.findFirstOrThrow({
      where: secretNameWhere(ctx, "docs-key"),
    })
    await updateSecret(ctx, secret.id, { value: "sk-rotated-value-5678" })

    const outcomes = await restartServicesUsingSecret(ctx, secret.id, FAST)
    expect(outcomes).toEqual([
      {
        id: service.id,
        ok: true,
        message: "Docs service is running and healthy.",
      },
    ])
    const state = docker.state()
    expect(state.envFiles.at(-1)).toBe(
      "LOG_LEVEL=info\nAPI_KEY=sk-rotated-value-5678\n",
    )
    expect(state.containers["pcp-docs"]!.env).toContain("sk-rotated-value-5678")
    expect(everythingSent()).not.toContain("sk-rotated-value-5678")
  })

  it("gives the MCP server it registered the header a definition gained, and the secret bound now, when it is made again", async () => {
    const hostId = await pinnedHost()
    const launched = await launchService(
      ctx,
      await launchInput(hostId, {
        definition: definition({ registers: MCP }),
      }),
      FAST,
    )
    const secret = await db().secret.findFirstOrThrow({
      where: secretNameWhere(ctx, "docs-key"),
    })
    expect((await getServer(ctx, launched.registeredId!)).authType).toBe("none")

    // The definition gains a header (a linked repository's, say): the
    // server sends nothing new until the container is made again.
    mcpAuthorization = `Bearer ${API_KEY}`
    await writeServiceDefinition(
      launched.id,
      parseServiceDefinition(definition({ registers: MCP_WITH_AUTH })),
    )
    expect((await getServer(ctx, launched.registeredId!)).authType).toBe("none")

    await updateService(ctx, launched.id, FAST)
    const after = await getServer(ctx, launched.registeredId!)
    expect(after).toMatchObject({
      authType: "header",
      authHeaderName: "Authorization",
      authValueTemplate: "Bearer {{secret}}",
      authSecretId: secret.id,
      // Its tools are read again with the new credential.
      status: "unknown",
      lastSyncedAt: null,
    })
    expect((await syncServerTools(ctx, after, PUBLIC)).status).toBe("ok")
    expect(mcpSeen.at(-1)).toBe(`Bearer ${API_KEY}`)

    // Another secret bound to the variable: the remake the save asks for
    // has the server send that one.
    const other = await createSecret(ctx, {
      name: "docs-key-two",
      value: "sk-other-service-value-9876",
    })
    await saveServiceSettings(ctx, launched.id, {
      name: (await getServer(ctx, launched.id)).name,
      env: { API_KEY: other.id },
    })
    await recreateService(ctx, launched.id, FAST)
    expect((await getServer(ctx, launched.registeredId!)).authSecretId).toBe(
      other.id,
    )
  })

  it("leaves the MCP server's credential alone when the definition names no header, or the owner moved it to OAuth", async () => {
    const hostId = await pinnedHost()
    const launched = await launchService(
      ctx,
      await launchInput(hostId, {
        definition: definition({ registers: MCP }),
      }),
      FAST,
    )
    const secret = await db().secret.findFirstOrThrow({
      where: secretNameWhere(ctx, "docs-key"),
    })
    // The owner's own header, on the server's page.
    await db().mcpServer.update({
      where: { id: launched.registeredId! },
      data: {
        authType: "header",
        authHeaderName: "X-Owner",
        authValueTemplate: "{{secret}}",
        authSecretId: secret.id,
      },
    })

    await recreateService(ctx, launched.id, FAST)
    expect(await getServer(ctx, launched.registeredId!)).toMatchObject({
      authType: "header",
      authHeaderName: "X-Owner",
    })

    await db().mcpServer.update({
      where: { id: launched.registeredId! },
      data: {
        authType: "oauth",
        authHeaderName: null,
        authValueTemplate: null,
        authSecretId: null,
      },
    })
    await writeServiceDefinition(
      launched.id,
      parseServiceDefinition(definition({ registers: MCP_WITH_AUTH })),
    )
    await recreateService(ctx, launched.id, FAST)
    expect(await getServer(ctx, launched.registeredId!)).toMatchObject({
      authType: "oauth",
      authSecretId: null,
    })
  })

  it("keeps a remake that worked when the MCP server it registered cannot take the header, and says so there and in the answer", async () => {
    const hostId = await pinnedHost()
    const launched = await launchService(
      ctx,
      await launchInput(hostId, {
        definition: definition({ registers: MCP }),
      }),
      FAST,
    )
    const secret = await db().secret.findFirstOrThrow({
      where: secretNameWhere(ctx, "docs-key"),
    })
    // The owner's own header, with a further one named as the definition's
    // header will be.
    await db().mcpServer.update({
      where: { id: launched.registeredId! },
      data: {
        authType: "header",
        authHeaderName: "X-Owner",
        authValueTemplate: "{{secret}}",
        authSecretId: secret.id,
      },
    })
    await db().serverAuthHeader.create({
      data: {
        id: "extra-authorization",
        serverId: launched.registeredId!,
        position: 0,
        headerName: "authorization",
        valueTemplate: "Bearer {{secret}}",
        secretId: secret.id,
      },
    })
    await writeServiceDefinition(
      launched.id,
      parseServiceDefinition(definition({ registers: MCP_WITH_AUTH })),
    )

    const { status } = await updateService(ctx, launched.id, FAST)

    // The container was made again and runs: the remake worked.
    expect(status.state).toBe("running")
    expect(docker.state().containers["pcp-docs"]!.state).toBe("running")
    expect(status.note).toMatch(
      /could not take API_KEY's secret in Authorization and sends what it did before: .* sends Authorization as a further header already: take that one out on its page and update the service again, or set the header there yourself\./,
    )
    expect(statusWords("Docs", status)).toContain(status.note)

    // The server it registered says what failed, and keeps its header.
    expect(await getServer(ctx, launched.registeredId!)).toMatchObject({
      authType: "header",
      authHeaderName: "X-Owner",
      status: "error",
      statusMessage: status.note,
    })

    // Made again later, it says the same.
    const again = await recreateService(ctx, launched.id, FAST)
    expect(again.note).toBe(status.note)
  })

  it("names the service among what uses its secret, which cannot be deleted under it", async () => {
    const { service } = await launched()
    const secret = await db().secret.findFirstOrThrow({
      where: secretNameWhere(ctx, "docs-key"),
    })
    const uses = (await secretUses(ctx)).get(secret.id) ?? []
    expect(uses.map((use) => use.kind).sort()).toEqual([
      "API endpoint",
      "service",
    ])
    expect(uses.find((use) => use.kind === "service")?.slug).toBe(service.slug)
    await expect(deleteSecret(ctx, secret.id)).rejects.toThrow(/Docs service/)
  })

  it("updates to the newest image of its source, pinned by digest", async () => {
    const { service } = await launched()
    const result = await updateService(ctx, service.id, FAST)
    const newer = `ghcr.io/example/docs@sha256:${"b".repeat(64)}`

    expect(result).toMatchObject({ image: newer, changed: true })
    expect(docker.state().containers["pcp-docs"]!.image).toBe(newer)
    const spec = await db().serviceSpec.findUniqueOrThrow({
      where: { serverId: service.id },
    })
    expect(JSON.parse(spec.definition).image).toBe(newer)
    expect((await readServiceStatus(ctx, service.id, PUBLIC)).upToDate).toBe(
      true,
    )
  })

  it("marks the service failed when its container cannot be made again, and says how to retry", async () => {
    const { service } = await launched()
    docker.update((state) => {
      state.runFailsAfterCreate = "Error: port is already allocated"
    })

    const failure = await updateService(ctx, service.id, FAST).catch(
      (error: Error) => error,
    )

    expect((failure as Error).message).toMatch(
      /Docs service could not be made again: .*port is already allocated/,
    )
    expect((failure as Error).message).toMatch(
      /Its old container is gone; its volumes and settings stay\..*Start on its page or its start tool makes it again/s,
    )
    // The container it made is taken out; the data stays.
    expect(docker.state().containers).toEqual({})
    expect(docker.state().volumes).toEqual(["pcp-docs-data"])
    const row = await getServer(ctx, service.id)
    expect(row.status).toBe("error")
    expect(row.statusMessage).toMatch(/Start makes it again/)

    // Once the port is free, Start makes it again.
    docker.update((state) => {
      state.runFailsAfterCreate = null
    })
    const status = await runServiceAction(ctx, service.id, "start", FAST)
    expect(status.state).toBe("running")
    expect((await getServer(ctx, service.id)).status).toBe("ok")
  })

  it("is removed on its own page only, with its container and what it served", async () => {
    const { service, endpoint } = await launched()
    await expect(deleteServer(ctx, service.id)).rejects.toThrow(/own page/)

    const said = await removeService(
      ctx,
      service.id,
      { volumes: true, registered: true },
      PUBLIC,
    )
    expect(said).toMatch(/Removed the container pcp-docs and its volumes/)
    expect(docker.state().containers).toEqual({})
    expect(docker.state().volumesRemoved).toEqual(["pcp-docs-data"])
    expect(
      await db().mcpServer.findUnique({ where: { id: endpoint.id } }),
    ).toBe(null)
    expect(await db().serviceSpec.count()).toBe(0)
    expect(await db().serverDefinition.count()).toBe(0)
  })

  it("tells the owner of a Podman service how it starts again with its machine", async () => {
    await teardown()
    await setup("podman")
    const { service } = await launched()
    const view = await serviceView(ctx, service.id)

    expect(view.engine).toBe("podman")
    expect(view.host?.username).toBe("deploy")
    expect(view.intent).toBe("running")
  })

  it("travels in an export and comes back with a restore", async () => {
    const { service } = await launched()
    const before = await db().serviceSpec.findUniqueOrThrow({
      where: { serverId: service.id },
    })
    const file = await exportVault(ctx, "export password 123")
    const { payload, preview } = await readExport(file, "export password 123")
    expect(preview.counts.services).toBe(1)
    expect(JSON.stringify(payload)).not.toContain(API_KEY)

    await db().serviceSpec.deleteMany()
    await restoreExport(
      payload,
      { into: "vault", ctx },
      {
        restoreHostSettings: false,
      },
    )
    expect(
      await db().serviceSpec.findUniqueOrThrow({
        where: { serverId: service.id },
      }),
    ).toEqual(before)
  })
})

describe("a service's files folder", { timeout: 30_000 }, () => {
  beforeEach(() => setup())
  afterEach(async () => {
    forgetResourceLimits()
    await teardown()
  })

  const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n")

  async function launchedWithFiles(
    files: ServiceDefinitionInput["files"] | null = {
      volume: "data",
      path: "/data",
    },
  ) {
    const hostId = await pinnedHost()
    const input = await launchInput(hostId, {
      definition: definition(files ? { files } : {}),
    })
    const result = await launchService(ctx, input, FAST)
    const { token } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })
    const tokenId = (await resolveApiToken(token))!.tokenId
    return { service: await getServer(ctx, result.id), tokenId }
  }

  async function keep(tokenId: string, bytes = PDF, name = "report.pdf") {
    return (
      await keepBytes(ctx, {
        tokenId,
        serverId: null,
        toolName: "test",
        bytes,
        mediaType: "application/pdf",
        name,
      })
    ).id
  }

  function call(
    service: Awaited<ReturnType<typeof launchedWithFiles>>["service"],
    tokenId: string,
    tool: string,
    args: Record<string, unknown>,
  ) {
    return callServerTool(ctx, service, tool, args, {
      ...PUBLIC,
      tokenId,
      keep: resultKeepers(ctx, tokenId).text,
      keepBytes: resultKeepers(ctx, tokenId).bytes,
      open: resultOpener(ctx, tokenId),
    })
  }

  function textOf(result: { content: unknown }): string {
    return (result.content as Array<{ text: string }>)
      .map((part) => part.text)
      .join("\n")
  }

  function codeOf(result: { _meta?: Record<string, unknown> }): unknown {
    return (result._meta?.["gg.pcp/error"] as { code?: string })?.code
  }

  it("offers put_file and get_file only with a files folder in one of its volumes", async () => {
    const { service } = await launchedWithFiles()
    expect(service.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["put_file", "get_file"]),
    )
    expect(
      service.tools.find((tool) => tool.name === "put_file")!.description,
    ).toContain("/data")

    expect(() =>
      parseServiceDefinition(
        definition({ files: { volume: "cache", path: "/data" } }),
      ),
    ).toThrow(/not one of the service's volumes/)
    expect(() =>
      parseServiceDefinition(
        definition({ files: { volume: "data", path: "/etc" } }),
      ),
    ).toThrow(/not in the volume data/)
    expect(() =>
      parseServiceDefinition(
        definition({ files: { volume: "data", path: "/data/../etc" } }),
      ),
    ).toThrow()
    expect(
      parseServiceDefinition(
        definition({ files: { volume: "data", path: "/data/in" } }),
      ).files,
    ).toEqual({ volume: "data", path: "/data/in" })
  })

  it("puts a kept file into the volume with the engine's cp, and gets it back", async () => {
    const { service, tokenId } = await launchedWithFiles()
    const id = await keep(tokenId)
    const before = docker.commands.length

    const put = await call(service, tokenId, "put_file", {
      file: { $result: id },
      path: "in/report.pdf",
    })
    expect(put.isError, textOf(put)).toBeFalsy()
    expect(put.structuredContent).toMatchObject({
      path: "/data/in/report.pdf",
      size: PDF.length,
    })
    // On the SSH server: the engine's own cp, the bytes on standard input.
    const words = docker.state().calls.slice(-2)
    expect(words).toEqual([
      ["cp", "pcp-docs:/data/in/report.pdf", "-"],
      ["cp", "-", "pcp-docs:/data"],
    ])
    expect(docker.commands.slice(before).join("\n")).not.toContain("PDF-1.7")
    expect(
      readFileSync(`${docker.volumeDir("pcp-docs-data")}/in/report.pdf`),
    ).toEqual(PDF)

    // What the service's tools wrote, read back by its full path.
    writeFileSync(
      `${docker.volumeDir("pcp-docs-data")}/in/report.txt`,
      "the text",
    )
    const got = await call(service, tokenId, "get_file", {
      path: "/data/in/report.txt",
    })
    expect(got.isError, textOf(got)).toBeFalsy()
    const answer = got.structuredContent as {
      result: { $result: string }
      size: number
      name: string
    }
    expect(answer).toMatchObject({ name: "report.txt", size: 8 })
    const opened = await resultOpener(ctx, tokenId)(answer.result.$result)
    expect(opened!.bytes().toString()).toBe("the text")

    // And the PDF it was given, round trip.
    const back = await call(service, tokenId, "get_file", {
      path: "in/report.pdf",
    })
    const backId = (back.structuredContent as { result: { $result: string } })
      .result.$result
    expect((await resultOpener(ctx, tokenId)(backId))!.bytes()).toEqual(PDF)
  })

  it("replaces a file only with overwrite, and never a folder", async () => {
    const { service, tokenId } = await launchedWithFiles()
    const first = await keep(tokenId)
    const second = await keep(tokenId, Buffer.from("second"))
    await call(service, tokenId, "put_file", {
      file: { $result: first },
      path: "report.pdf",
    })

    const refused = await call(service, tokenId, "put_file", {
      file: { $result: second },
      path: "report.pdf",
    })
    expect(refused.isError).toBe(true)
    expect(codeOf(refused)).toBe("conflict")
    expect(textOf(refused)).toMatch(/already a file at \/data\/report\.pdf/)
    const volume = docker.volumeDir("pcp-docs-data")
    expect(readFileSync(`${volume}/report.pdf`)).toEqual(PDF)

    const replaced = await call(service, tokenId, "put_file", {
      file: { $result: second },
      path: "report.pdf",
      overwrite: true,
    })
    expect(replaced.structuredContent).toMatchObject({ replaced: true })
    expect(readFileSync(`${volume}/report.pdf`, "utf8")).toBe("second")

    mkdirSync(`${volume}/out`)
    const folder = await call(service, tokenId, "put_file", {
      file: { $result: second },
      path: "out",
      overwrite: true,
    })
    expect(codeOf(folder)).toBe("conflict")
    expect(textOf(folder)).toMatch(/is a folder/)
    expect(statSync(`${volume}/out`).isDirectory()).toBe(true)

    const notAFile = await call(service, tokenId, "get_file", { path: "out" })
    expect(notAFile.isError).toBe(true)
    expect(textOf(notAFile)).toMatch(/a folder/)
  })

  it.each([
    "../etc/passwd",
    "/etc/passwd",
    "/data",
    "a/../../b",
    "a;rm -rf x",
    "a$(id)",
  ])("refuses the name %j before anything connects", async (path) => {
    const { service, tokenId } = await launchedWithFiles()
    const id = await keep(tokenId)
    const before = docker.commands.length

    for (const [tool, args] of [
      ["put_file", { file: { $result: id }, path }],
      ["get_file", { path }],
    ] as const) {
      const refused = await call(service, tokenId, tool, args)
      expect(refused.isError).toBe(true)
      expect(codeOf(refused)).toBe("invalid_arguments")
    }

    expect(docker.commands.length).toBe(before)
  })

  it("refuses a file the token does not have before anything connects", async () => {
    const { service, tokenId } = await launchedWithFiles()
    const before = docker.commands.length
    const refused = await call(service, tokenId, "put_file", {
      file: { $result: "no-such-result" },
      path: "a.pdf",
    })
    expect(refused.isError).toBe(true)
    expect(docker.commands.length).toBe(before)
  })

  it("refuses a file larger than PCP keeps, either way", async () => {
    const { service, tokenId } = await launchedWithFiles()
    const big = Buffer.alloc(1024 * 1024 + 1, 1)
    const id = await keep(tokenId, big, "big.bin")
    useResourceConfig({ ...(await getResourceConfig()), fileMb: 1 })
    const before = docker.commands.length

    const put = await call(service, tokenId, "put_file", {
      file: { $result: id },
      path: "big.bin",
    })
    expect(put.isError).toBe(true)
    expect(textOf(put)).toMatch(/more than PCP copies at once/)
    expect(docker.commands.length).toBe(before)

    writeFileSync(`${docker.volumeDir("pcp-docs-data")}/out.bin`, big)
    const got = await call(service, tokenId, "get_file", { path: "out.bin" })
    expect(got.isError).toBe(true)
    expect(textOf(got)).toMatch(/larger than PCP keeps of one file/)

    // One past what PCP reads of the stream at all: cut off, not read whole.
    writeFileSync(
      `${docker.volumeDir("pcp-docs-data")}/huge.bin`,
      Buffer.alloc(2 * 1024 * 1024, 2),
    )
    const huge = await call(service, tokenId, "get_file", { path: "huge.bin" })
    expect(huge.isError).toBe(true)
    expect(textOf(huge)).toMatch(/larger than PCP keeps of one file/)
  })

  it("does not keep a file that holds a secret the service was given", async () => {
    const { service, tokenId } = await launchedWithFiles()
    writeFileSync(
      `${docker.volumeDir("pcp-docs-data")}/env.txt`,
      `API_KEY=${API_KEY}\n`,
    )
    const got = await call(service, tokenId, "get_file", { path: "env.txt" })
    expect(got.isError).toBe(true)
    expect(codeOf(got)).toBe("forbidden")
    expect(textOf(got)).not.toContain(API_KEY)
  })

  it("says when there is no such file", async () => {
    const { service, tokenId } = await launchedWithFiles()
    const got = await call(service, tokenId, "get_file", { path: "nope.pdf" })
    expect(got.isError).toBe(true)
    expect(codeOf(got)).toBe("not_found")
  })

  it("is refused by a service without a files folder", async () => {
    const { service, tokenId } = await launchedWithFiles(null)
    expect(service.tools.map((tool) => tool.name)).not.toContain("put_file")
    const id = await keep(tokenId)
    const before = docker.commands.length

    for (const [tool, args] of [
      ["put_file", { file: { $result: id }, path: "a.pdf" }],
      ["get_file", { path: "a.pdf" }],
    ] as const) {
      const refused = await call(service, tokenId, tool, args)
      expect(refused.isError).toBe(true)
      expect(codeOf(refused)).toBe("not_found")
      expect(textOf(refused)).toMatch(/has no files folder/)
    }

    expect(docker.commands.length).toBe(before)
  })
})

describe("an image update", { timeout: 30_000 }, () => {
  beforeEach(() => setup())
  afterEach(teardown)

  const NEWER = `ghcr.io/example/docs@sha256:${"b".repeat(64)}`

  async function launchedWithToken() {
    const hostId = await pinnedHost()
    const result = await launchService(ctx, await launchInput(hostId), FAST)
    const { token } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })
    const tokenId = (await resolveApiToken(token))!.tokenId
    return { ...result, service: await getServer(ctx, result.id), tokenId }
  }

  function textOf(result: { content: unknown }): string {
    return (result.content as Array<{ text: string }>)[0]!.text
  }

  it("is looked for on the owner's click, changing nothing", async () => {
    const { service } = await launchedWithToken()
    const calls = docker.state().calls.length

    const found = await checkServiceImage(ctx, service.id, FAST)

    expect(found).toEqual({
      current: `ghcr.io/example/docs@${DIGEST}`,
      newest: NEWER,
      source: "ghcr.io/example/docs:latest",
      newer: true,
    })
    // A pull and a look at its digest; no container made again.
    const since = docker.state().calls.slice(calls)
    expect(since.map((call) => call[0])).toEqual(["pull", "image"])
    expect(docker.state().containers["pcp-docs"]!.image).toBe(
      `ghcr.io/example/docs@${DIGEST}`,
    )
  })

  it("is proposed by an assistant as a request showing both images, and made only once the owner agrees", async () => {
    const { service, tokenId } = await launchedWithToken()

    const asked = await runCall(
      ctx,
      service,
      "update",
      {},
      {
        ...PUBLIC,
        tokenId,
      },
    )

    expect(textOf(asked)).toMatch(/permissions\//)
    const row = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "service_change" },
    })
    expect(row.serverId).toBe(service.id)
    expect(row.toolName).toBe("update")
    const view = (await getPermissionView(ctx, row.id, PUBLIC))!
    expect(view.title).toBe("Update Docs service to a new image?")
    expect(view.lines).toEqual(
      expect.arrayContaining([
        `Image now: ghcr.io/example/docs@${DIGEST}`,
        `Image after: ${NEWER}`,
        "The newest ghcr.io/example/docs:latest, as Build box resolved it when the assistant asked",
      ]),
    )
    expect(view.decisions.map((decision) => decision.label)).toEqual([
      "Update it",
      "Not now",
    ])
    // Nothing changed yet.
    expect(docker.state().containers["pcp-docs"]!.image).toBe(
      `ghcr.io/example/docs@${DIGEST}`,
    )

    const done = await decidePermission(ctx, row.id, "allow_once", PUBLIC)

    expect(done.isError).not.toBe(true)
    expect(textOf(done)).toMatch(/now runs ghcr\.io\/example\/docs@sha256:b+/)
    expect(docker.state().containers["pcp-docs"]!.image).toBe(NEWER)
    const spec = await db().serviceSpec.findUniqueOrThrow({
      where: { serverId: service.id },
    })
    expect(JSON.parse(spec.definition).image).toBe(NEWER)
  })

  it("takes a digest an assistant names in the same repository, and refuses another", async () => {
    const { service, tokenId } = await launchedWithToken()
    const named = `sha256:${"c".repeat(64)}`

    await runCall(
      ctx,
      service,
      "update",
      { digest: named },
      {
        ...PUBLIC,
        tokenId,
      },
    )
    const row = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "service_change" },
    })
    expect((await getPermissionView(ctx, row.id, PUBLIC))!.lines).toEqual(
      expect.arrayContaining([
        `Image after: ghcr.io/example/docs@${named}`,
        "A digest the assistant named, in the same repository",
      ]),
    )

    const wrong = await runCall(
      ctx,
      service,
      "update",
      { digest: "latest" },
      {
        ...PUBLIC,
        tokenId,
      },
    )
    expect(wrong.isError).toBe(true)
    expect(textOf(wrong)).toMatch(/digest/)
  })

  it("asks nothing when the service runs the newest already", async () => {
    const { service, tokenId } = await launchedWithToken()
    docker.update((state) => {
      state.digest = DIGEST
    })

    const answer = await runCall(
      ctx,
      service,
      "update",
      {},
      {
        ...PUBLIC,
        tokenId,
      },
    )

    expect(textOf(answer)).toMatch(/already runs .*nothing to update/)
    expect(await db().permissionRequest.count()).toBe(0)
  })

  it("updates nothing when the definition changed since the owner was asked", async () => {
    const { service, tokenId } = await launchedWithToken()
    await runCall(
      ctx,
      service,
      "update",
      { digest: `sha256:${"c".repeat(64)}` },
      {
        ...PUBLIC,
        tokenId,
      },
    )
    const row = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "service_change" },
    })
    // The owner updated it in the meantime.
    await updateService(ctx, service.id, FAST)

    const done = await decidePermission(ctx, row.id, "allow_once", PUBLIC)

    expect(done.isError).toBe(true)
    expect(textOf(done)).toMatch(/changed since this was asked/)
    expect(docker.state().containers["pcp-docs"]!.image).toBe(NEWER)
  })
})

describe("a service built from a repository", { timeout: 60_000 }, () => {
  beforeEach(() => setup())
  afterEach(teardown)

  const COMMIT = "a".repeat(40)
  const BUILT = `sha256:${"d".repeat(64)}`

  function built(change: Record<string, unknown> = {}) {
    return definition({
      image: undefined,
      source: undefined,
      build: {
        repository: "kaperkunde/docs-server",
        commit: COMMIT,
        containerfile: "deploy/Containerfile",
        context: ".",
        args: [{ name: "VERSION", value: "1.2 beta" }],
        ...change,
      },
    })
  }

  function repository(links: Record<string, string> = {}) {
    docker.update((state) => {
      state.tarball = fakeRepositoryTarball(
        docker.dir,
        {
          "deploy/Containerfile": "FROM scratch\nCOPY app /app\n",
          "app/main.py": "print('docs')\n",
        },
        { links },
      )
    })
  }

  it("builds the image on the SSH server at the commit, and never pulls it", async () => {
    const hostId = await pinnedHost()
    repository()

    const launched = await launchService(
      ctx,
      await launchInput(hostId, { definition: built() }),
      FAST,
    )

    const state = docker.state()
    expect(state.downloads).toEqual([
      expect.objectContaining({
        program: "curl",
        url: `https://codeload.github.com/kaperkunde/docs-server/tar.gz/${COMMIT}`,
      }),
    ])
    expect(state.downloads[0]!.args).toEqual(
      expect.arrayContaining(["--proto", "=https"]),
    )
    expect(state.builds).toHaveLength(1)
    expect(state.builds[0]).toMatchObject({
      containerfile: "FROM scratch\nCOPY app /app\n",
      tag: "localhost/pcp-docs-server:aaaaaaaaaaaa",
      buildArgs: ["VERSION=1.2 beta"],
    })
    expect(state.builds[0]!.contextFiles).toEqual([
      "app/main.py",
      "deploy/Containerfile",
    ])
    expect(state.calls.some((call) => call[0] === "pull")).toBe(false)
    expect(state.containers["pcp-docs"]!.image).toBe(BUILT)
    // The folder it built in is gone.
    expect(docker.leftovers()).toEqual([])

    const spec = await db().serviceSpec.findUniqueOrThrow({
      where: { serverId: launched.id },
    })
    expect(JSON.parse(spec.definition).image).toBe(
      `localhost/pcp-docs-server@${BUILT}`,
    )
    expect((await readServiceStatus(ctx, launched.id, PUBLIC)).upToDate).toBe(
      true,
    )
  })

  it("downloads with wget when the login has no curl, and says when it has neither", async () => {
    const hostId = await pinnedHost()
    repository()
    docker.withoutDownloader("curl")

    const first = await launchService(
      ctx,
      await launchInput(hostId, { definition: built() }),
      FAST,
    )
    expect(docker.state().downloads[0]!.program).toBe("wget")
    const definitionId = (await getServer(ctx, first.id)).definitionId!

    docker.withoutDownloader("wget")
    // Another of the definition: the image is there, so nothing is built.
    await launchService(
      ctx,
      await launchInput(hostId, {
        name: "Docs two",
        definition: undefined,
        definitionId,
      }),
      FAST,
    )
    expect(docker.state().downloads).toHaveLength(1)
    expect(docker.state().builds).toHaveLength(1)

    docker.update((state) => {
      state.images = []
    })
    await expect(
      launchService(
        ctx,
        await launchInput(hostId, {
          name: "Docs three",
          definition: undefined,
          definitionId,
        }),
        FAST,
      ),
    ).rejects.toThrow(/Neither curl nor wget is installed/)
  })

  it("refuses a Containerfile or folder that leads out of the repository", async () => {
    const hostId = await pinnedHost()
    repository({ "deploy/outside": "/etc", linked: "/" })

    await expect(
      launchService(
        ctx,
        await launchInput(hostId, {
          definition: built({ containerfile: "deploy/outside/passwd" }),
        }),
        FAST,
      ),
    ).rejects.toThrow(/leads out of the repository/)
    await expect(
      launchService(
        ctx,
        await launchInput(hostId, { definition: built({ context: "linked" }) }),
        FAST,
      ),
    ).rejects.toThrow(/leads out of the repository/)
    await expect(
      launchService(
        ctx,
        await launchInput(hostId, {
          definition: built({ containerfile: "Dockerfile" }),
        }),
        FAST,
      ),
    ).rejects.toThrow(/There is no Dockerfile in the repository/)
    expect(docker.state().builds).toEqual([])
    expect(docker.leftovers()).toEqual([])
    expect(await db().serviceSpec.count()).toBe(0)
  })

  it("removes an image larger than PCP keeps, and says so", async () => {
    const hostId = await pinnedHost()
    repository()
    docker.update((state) => {
      state.imageSize = 9 * 1024 * 1024 * 1024
    })

    await expect(
      launchService(
        ctx,
        await launchInput(hostId, { definition: built() }),
        FAST,
      ),
    ).rejects.toThrow(/more than the 8 GB PCP keeps/)
    expect(docker.state().imagesRemoved).toEqual([BUILT])
    expect(docker.state().containers).toEqual({})
  })

  it("updates to a new commit on the owner's word, and builds again an image that is gone", async () => {
    const hostId = await pinnedHost()
    repository()
    const launched = await launchService(
      ctx,
      await launchInput(hostId, { definition: built() }),
      FAST,
    )
    const next = "b".repeat(40)
    docker.update((state) => {
      state.buildId = "e".repeat(64)
    })

    const result = await updateService(ctx, launched.id, FAST, {
      commit: next,
    })

    expect(result).toMatchObject({
      image: `localhost/pcp-docs-server@sha256:${"e".repeat(64)}`,
      changed: true,
    })
    expect(docker.state().downloads.at(-1)!.url).toMatch(new RegExp(`${next}$`))
    expect(docker.state().containers["pcp-docs"]!.image).toBe(
      `sha256:${"e".repeat(64)}`,
    )
    const definitionNow = (await serviceView(ctx, launched.id)).definition
    expect(definitionNow.build?.commit).toBe(next)

    // The image pruned on the SSH server: made again from the same commit.
    docker.update((state) => {
      state.images = []
      state.buildId = "9".repeat(64)
    })
    await runServiceAction(ctx, launched.id, "restart", FAST)
    await updateService(ctx, launched.id, FAST)
    expect(docker.state().containers["pcp-docs"]!.image).toBe(
      `sha256:${"9".repeat(64)}`,
    )
    await expect(
      updateService(ctx, launched.id, FAST, { commit: "main" }),
    ).rejects.toThrow(/40 hex digits/)
  })

  it("is not proposed for an update by an assistant", async () => {
    const hostId = await pinnedHost()
    repository()
    const launched = await launchService(
      ctx,
      await launchInput(hostId, { definition: built() }),
      FAST,
    )
    const { token } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })
    const tokenId = (await resolveApiToken(token))!.tokenId

    const answer = await runCall(
      ctx,
      await getServer(ctx, launched.id),
      "update",
      {},
      { ...PUBLIC, tokenId },
    )

    expect(answer.isError).toBe(true)
    expect((answer.content as Array<{ text: string }>)[0]!.text).toMatch(
      /only the owner updates it, to a new commit/,
    )
    expect(await db().permissionRequest.count()).toBe(0)
  })
})

describe("a tunnel to a service", () => {
  const publish = {
    address: "0.0.0.0",
    ports: [{ container: 5001, host: 8001 }],
  }

  it("opens a channel to the SSH server's loopback, at a published port only", async () => {
    const opened: string[] = []
    const dial = serviceDial(publish, "box.lan", async (address, port) => {
      opened.push(`${address}:${port}`)
      return {} as never
    })

    await dial("127.0.0.1", 8001)
    await dial("box.lan", 8001)
    await dial("localhost", 8001)
    expect(opened).toEqual([
      "127.0.0.1:8001",
      "127.0.0.1:8001",
      "127.0.0.1:8001",
    ])

    await expect(dial("127.0.0.1", 22)).rejects.toThrow(/not 127.0.0.1:22/)
    await expect(dial("10.0.0.5", 8001)).rejects.toThrow(/only the ports/)
    await expect(dial("metadata.google.internal", 80)).rejects.toThrow()
    expect(opened).toHaveLength(3)
  })

  it("goes to the address the ports are bound to when that is one of the SSH server's", async () => {
    const opened: string[] = []
    const dial = serviceDial(
      { ...publish, address: "192.168.1.5" },
      "box.lan",
      async (address, port) => {
        opened.push(`${address}:${port}`)
        return {} as never
      },
    )

    await dial("192.168.1.5", 8001)
    expect(opened).toEqual(["192.168.1.5:8001"])
  })
})
