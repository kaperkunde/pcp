import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { writeEmbeddingsConfig } from "./embeddings/config"
import { buildGatewayServer, type GatewayScope } from "./gateway"
import {
  searchEverything,
  type PcpToolCandidate,
  type ToolCandidate,
} from "./search"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"
import { listEveryTool } from "./test-handles"

// Search with no embeddings provider, as an assistant met it in #61: PCP's
// own tools as the gateway registers them (their real descriptions), beside
// an owner's servers whose tools share the query's words.

const coolify = (
  name: string,
  title: string | null,
  description: string,
): ToolCandidate => ({
  server: "coolify-gaaf",
  serverName: "Coolify gaaf",
  serverDescription:
    "My primary development Coolify host, for checking runtime and deployment logs, modifying and creating projects",
  name,
  title,
  description,
})

const files = (
  server: string,
  name: string,
  description: string,
): ToolCandidate => ({
  server,
  serverName: server,
  serverDescription:
    "File storage on Bazzite (dufs): keep PDFs, documents and other artifacts for good; upload, download, list and delete by path.",
  name,
  title: null,
  description,
})

const OWNER_TOOLS: ToolCandidate[] = [
  coolify(
    "start_application",
    "Start an application",
    "Start an application on its server by uuid.",
  ),
  coolify(
    "restart_application",
    "Restart an application",
    "Restart a running application's containers.",
  ),
  coolify("stop_application", null, "Stop an application's containers."),
  coolify("start_service", "Start a service", "Start a service by uuid."),
  coolify(
    "restart_service",
    "Restart a service",
    "Restart every container of a service.",
  ),
  coolify(
    "deploy_application",
    "Deploy",
    "Deploy an application from its latest commit.",
  ),
  coolify(
    "restart_proxy",
    "Restart the proxy",
    "Restart the Traefik proxy on a server.",
  ),
  coolify("list_servers", "List servers", "Every server Coolify manages."),
  coolify(
    "validate_server",
    null,
    "Check that Coolify can reach a server over SSH and that Docker runs there.",
  ),
  {
    server: "coolify-gaaf-api",
    serverName: "Coolify gaaf API",
    serverDescription:
      "Coolify's REST API on gaaf: create and configure applications, services and databases.",
    name: "start_service_by_uuid",
    title: null,
    description: "Start service. Start service `uuid`.",
  },
  {
    server: "coolify-gaaf-api",
    serverName: "Coolify gaaf API",
    serverDescription:
      "Coolify's REST API on gaaf: create and configure applications, services and databases.",
    name: "create_service",
    title: null,
    description: "Create service. Create a one-click or a custom service.",
  },
  {
    server: "hetzner",
    serverName: "Hetzner Cloud",
    serverDescription: "Servers, volumes and backups at Hetzner.",
    name: "enable_server_backup",
    title: "Enable backups for a server",
    description:
      "Enables and configures the automatic daily backup of a server, stored for seven days.",
  },
  {
    server: "hetzner",
    serverName: "Hetzner Cloud",
    serverDescription: "Servers, volumes and backups at Hetzner.",
    name: "create_server",
    title: "Create a server",
    description: "Creates a new server from an image.",
  },
  files(
    "bazzite-files-service",
    "upload_file",
    "Upload a file handle to a path.",
  ),
  files(
    "bazzite-files-service",
    "download_file",
    "Download a path as a file handle.",
  ),
  files("bazzite-files-service", "list_files", "List the files in a folder."),
  files(
    "bazzite-files-service",
    "search_files",
    "Search files by name under a folder.",
  ),
  files("bazzite-files-service", "delete_file", "Delete a file by path."),
  files("bazzite-files-api", "upload_file", "Upload a file handle to a path."),
  files(
    "bazzite-files-api",
    "download_file",
    "Download a path as a file handle.",
  ),
  {
    server: "bazzite",
    serverName: "Bazzite",
    serverDescription:
      "My local gaming machine (bazzite) runs my arr stack, as well as hosts this PCP server",
    name: "run_command",
    title: "Run a command",
    description: "Run one command on the machine and answer its output.",
  },
]

let cleanup: () => Promise<void>
let pcp: PcpToolCandidate[]
let client: Client
let ctx: VaultContext

beforeAll(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  const { token } = await createApiToken(ctx, {
    name: "Everything",
    allowAllServers: true,
    manageEndpoints: true,
    keepMemories: true,
    webFetch: true,
    runCode: true,
    manageWrappers: true,
    shareFiles: true,
  })
  const scope: GatewayScope = {
    ...(await resolveApiToken(token))!,
    publicUrl: "http://localhost:3000",
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, []).connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  pcp = (await listEveryTool(client)).tools.map((tool) => ({
    name: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description ?? "",
  }))
})

afterAll(async () => {
  await client.close()
  await cleanup()
})

const topFive = (query: string) =>
  searchEverything({ tools: OWNER_TOOLS, pcp }, query, { limit: 5 }).map(
    (result) => result.ref,
  )

describe("task-phrased search with no provider (#61)", () => {
  it("finds PCP's file-moving tools for storing a file on a server", () => {
    expect(topFive("store a file on a server")).toEqual(
      expect.arrayContaining([
        "share_result",
        "receive_file",
        "create_upload_link",
      ]),
    )
  })

  it("finds register_server for launching a container", () => {
    expect(topFive("launch a container")).toContain("register_server")
  })

  it("still finds an owner's tool by what it does", () => {
    expect(topFive("restart a service")[0]).toBe("coolify-gaaf/restart_service")
    expect(topFive("upload a file")).toContain(
      "bazzite-files-service/upload_file",
    )
    expect(topFive("list servers")[0]).toBe("coolify-gaaf/list_servers")
  })

  it("answers by keywords when the embeddings provider cannot be reached", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    await writeEmbeddingsConfig(ctx, {
      provider: "openai",
      url: "http://127.0.0.1:9/v1",
      model: "m",
      secretId: null,
      embed: { tools: true, skills: false, memories: false },
    })

    const result = await client.callTool({
      name: "search",
      arguments: { query: "store a file" },
    })
    const text = (result.content as Array<{ text: string }>)[0]!.text

    expect(result.isError ?? false).toBe(false)
    expect(text).toContain("pcp share_result")
    await writeEmbeddingsConfig(ctx, null)
  })
})
