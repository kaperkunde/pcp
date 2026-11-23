import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { buildGatewayServer, loadGatewayServers } from "./gateway"
import { asksForService } from "./search"
import { createSshServer } from "./ssh/hosts"
import { sshTools } from "./ssh/tools"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// #166: software for an SSH server is a PCP service. A search that asks to
// install, host or run something says so, also one narrowed to the server,
// which hides PCP's own tools.

let cleanup: () => Promise<void>
let client: Client
let ctx: VaultContext

const HINT = "propose it as a PCP service (register_server, kind service"

async function search(args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name: "search", arguments: args })

  return (result.content as Array<{ text: string }>)[0]!.text
}

beforeAll(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  await createSshServer(ctx, {
    name: "Bazzite",
    host: "127.0.0.1",
    port: 2222,
    username: "badpirate",
  })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  })
  const scope = {
    ...(await resolveApiToken(token))!,
    publicUrl: "http://localhost:3000",
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
    serverSide,
  )
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
})

afterAll(async () => {
  await client.close()
  await cleanup()
})

describe("search for software to run on a server (#166)", () => {
  it("knows the words that ask for it", () => {
    for (const query of [
      "install docker app on my server",
      "run a container on bazzite",
      "host a website",
      "self-host an app",
      "deploy it with podman",
    ]) {
      expect(asksForService(query), query).toBe(true)
    }

    for (const query of [
      "list files",
      "read my mail",
      "price of a lamp",
      "ssh host key",
      "host key",
      "hostname",
      "host header",
      "install updates",
      "storage container",
    ]) {
      expect(asksForService(query), query).toBe(false)
    }
  })

  it("lists register_server for the queries, with no server", async () => {
    for (const query of [
      "install docker app on my server",
      "run a container on bazzite",
      "host a website",
    ]) {
      const text = await search({ query })

      expect(text, query).toMatch(/^pcp register_server /m)
    }
  })

  it("adds the hint to a search narrowed to an SSH server", async () => {
    for (const query of [
      "run a container",
      "install docker image",
      "host a website",
    ]) {
      const text = await search({ query, server: "bazzite" })

      expect(text, query).toContain(HINT)
      expect(text, query).toContain(
        "rather than hand-editing it with run_command",
      )
      expect(text, query).toContain("on bazzite")
    }
  })

  it("keeps the hint out of a search that is not about software", async () => {
    expect(
      await search({ query: "run command", server: "bazzite" }),
    ).not.toContain(HINT)
    expect(await search({ query: "read my mail" })).not.toContain(HINT)
  })

  it("does not repeat the hint where register_server is already listed", async () => {
    expect(await search({ query: "launch a container" })).not.toContain(HINT)
  })

  it("adds the hint to a search that finds nothing, beside the usual text", async () => {
    const text = await search({
      query: "zzqx host a website",
      server: "bazzite",
    })

    expect(text).toContain("Nothing matches")
    expect(text).toContain(HINT)
  })

  it("describes run_command as a pointer to services", () => {
    const [tool] = sshTools({ host: "bazzite", username: "badpirate" })

    expect(JSON.stringify(tool)).toContain(
      "propose a PCP service with register_server (kind service)",
    )
  })
})
