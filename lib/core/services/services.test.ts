import { createServer as createHttpServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { exportVault, readExport, restoreExport } from "../backup"
import type { VaultContext } from "../context"
import { db } from "../db"
import { createSecret, deleteSecret, updateSecret } from "../secrets"
import { secretUses } from "../secret-uses"
import { deleteServer, getServer } from "../servers"
import { startFakeSsh, type FakeSsh } from "../ssh/fake-server"
import { createSshServer } from "../ssh/hosts"
import { scratchDatabase } from "../test-db"
import {
  callServerTool,
  launchService,
  readServiceStatus,
  removeService,
  restartServicesUsingSecret,
  runServiceAction,
  serviceStateLine,
  syncServerTools,
  updateService,
} from "../upstream"
import { setupVault } from "../vault"
import { startFakeDocker, type FakeDocker } from "./fake-docker"
import type { ServiceDefinitionInput } from "./definition"
import { serviceOfDefinition, type ServiceLaunchInput } from "./services"

// Services end to end in the core: launched by the owner on an SSH server
// (the test server on 127.0.0.1) whose login runs commands in a real sh,
// with a fake `docker` on its PATH that records what it was given; what the
// service serves is an HTTP server of the test's own, at the port the
// container is published on.

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

async function startHttp(port = 0) {
  http = createHttpServer((request, response) => {
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
  docker = startFakeDocker({ engine })
  ssh = await startFakeSsh({
    authorizedKey: () => authorized,
    run: docker.run,
  })
  answers = {
    "/health": { status: 200, body: "{}" },
    "/openapi.json": { status: 200, body: SPEC },
    "/things": { status: 200, body: "[]" },
  }
  await startHttp()
}

async function teardown() {
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

async function launchInput(
  hostId: string,
  change: Partial<ServiceLaunchInput> = {},
): Promise<ServiceLaunchInput> {
  const secret = await db().secret.findFirst({ where: { name: "docs-key" } })
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

  it("refuses a port PCP could not reach on another machine's loopback", async () => {
    const { id } = await createSshServer(ctx, {
      name: "Far box",
      host: "box.example",
      username: "deploy",
    })
    await expect(
      launchService(ctx, await launchInput(id), FAST),
    ).rejects.toThrow(/loopback/)
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
    await expect(
      callServerTool(ctx, service, tool, args, PUBLIC),
    ).rejects.toThrow()
    expect(docker.commands.length).toBe(before)
  })

  it("stops and starts, and a stopped service's tools say so", async () => {
    const { service, endpoint } = await launched()

    const stopped = await callServerTool(ctx, service, "stop", {}, PUBLIC)
    expect(JSON.parse(textOf(stopped))).toMatchObject({ state: "exited" })
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

  it("makes the container again when a secret it takes changes", async () => {
    const { service } = await launched()
    const secret = await db().secret.findFirstOrThrow({
      where: { name: "docs-key" },
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

  it("names the service among what uses its secret, which cannot be deleted under it", async () => {
    const { service } = await launched()
    const secret = await db().secret.findFirstOrThrow({
      where: { name: "docs-key" },
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
