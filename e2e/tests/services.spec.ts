import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"

import { expect, test } from "@playwright/test"

import {
  startFakeDocker,
  type FakeDocker,
} from "../../lib/core/services/fake-docker"
import { startFakeSsh, type FakeSsh } from "../../lib/core/ssh/fake-server"
import {
  acceptNextDialog,
  addSecret,
  clickHydrated,
  openMoreOptions,
} from "../lib/ui"

// A service, launched by the owner on an SSH server PCP already holds: the
// test SSH server runs each command in a real sh with a fake `docker` on its
// PATH (lib/core/services/fake-docker.ts), and what the "container" serves
// is an HTTP server in this process, at the port the form publishes, which
// PCP reaches through the SSH connection. The launch registers its API
// endpoint in the same step; the secret for its variable reaches the engine
// only through the env file.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const HOST = `Service box ${RUN}`
const NAME = `Docs ${RUN}`
const SECRET = `Docs key ${RUN}`
const VALUE = `sk-docs-${RUN}-value`

let ssh: FakeSsh
let docker: FakeDocker
let http: Server
let port: number
/** Where the sessions service's container is published: its MCP server. */
let sessions: Server
let sessionsPort: number
let authorized: string | null = null

/** The account the sessions service is signed in as; null: signed out. */
let account: string | null = null
const CODE = `code-${RUN}-4f1a9b`

/**
 * A service that signs in to an account, as its MCP server: the three
 * sign-in tools its definition names (signin), answered as JSON text.
 */
function answerSessions(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") {
    response.writeHead(405).end()
    return
  }

  let body = ""
  request.on("data", (chunk: Buffer) => (body += chunk.toString()))
  request.on("end", () => {
    const message = JSON.parse(body) as {
      id?: number
      method: string
      params?: {
        protocolVersion?: string
        name?: string
        arguments?: { code?: string }
      }
    }

    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }

    const text = (value: unknown, isError = false) => ({
      content: [{ type: "text", text: JSON.stringify(value) }],
      ...(isError ? { isError: true } : {}),
    })
    const call = () => {
      switch (message.params?.name) {
        case "login_status":
          return text({ signed_in: account !== null, email: account })
        case "login_start":
          return text({
            url: `https://claude.ai/oauth/authorize?state=${RUN}`,
            expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          })
        case "login_finish":
          if (message.params.arguments?.code !== CODE) {
            return text({ error: "That code did not work." }, true)
          }
          account = "ada@example.com"
          return text({ signed_in: true, email: account })
        default:
          return text({ error: "No such tool." }, true)
      }
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
              tools: ["login_status", "login_start", "login_finish"].map(
                (name) => ({
                  name,
                  inputSchema: { type: "object" },
                  // Its status only reads: PCP reads it by itself.
                  annotations: { readOnlyHint: name === "login_status" },
                }),
              ),
            }
          : message.method === "tools/call"
            ? call()
            : {}

    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
  })
}

test.beforeAll(async () => {
  docker = startFakeDocker()
  ssh = await startFakeSsh({
    authorizedKey: () => authorized,
    run: docker.run,
    // PCP reaches the service through the SSH connection, at the port it
    // is published on the SSH server's 127.0.0.1.
    allowForwarding: true,
  })
  http = createServer((request, response) => {
    const body =
      request.url === "/openapi.json"
        ? JSON.stringify({
            openapi: "3.0.3",
            info: { title: "Docs", version: "1" },
            paths: {
              "/things": {
                get: {
                  operationId: "list_things",
                  responses: { "200": { description: "ok" } },
                },
              },
            },
          })
        : "{}"
    response.writeHead(200, { "content-type": "application/json" })
    response.end(body)
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  port = (http.address() as AddressInfo).port
  sessions = createServer((request, response) => {
    if (request.url === "/mcp") {
      answerSessions(request, response)
      return
    }

    response.writeHead(200, { "content-type": "application/json" })
    response.end("{}")
  })
  await new Promise<void>((resolve) => sessions.listen(0, "127.0.0.1", resolve))
  sessionsPort = (sessions.address() as AddressInfo).port
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => http?.close(() => resolve()))
  await new Promise<void>((resolve) => sessions?.close(() => resolve()))
  await ssh?.close()
  docker?.close()
})

test("a service launches on an SSH server and registers its API endpoint", async ({
  page,
}) => {
  // The SSH server, signed in to and its host key pinned.
  await page.goto("/servers/ssh/new")
  await page.getByLabel("Name", { exact: true }).fill(HOST)
  await page.getByLabel("Host", { exact: true }).fill("127.0.0.1")
  await page.getByLabel("Login").fill("deploy")
  await openMoreOptions(page)
  await page.getByLabel("Port").fill(String(ssh.port))
  await page.getByRole("button", { name: "Add SSH server" }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  authorized = (await page.getByTestId("ssh-public-key").textContent())!
  await page.getByRole("button", { name: "Check sign-in" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "PCP signed in." }),
  ).toBeVisible()

  await addSecret(page, { name: SECRET, value: VALUE })

  await page.goto("/servers/services/new")
  await page.getByLabel("Name", { exact: true }).fill(NAME)
  await page.getByLabel("Description").fill("Turns documents into text.")
  await page
    .getByLabel("SSH server", { exact: true })
    .selectOption({ label: `${HOST} (127.0.0.1)` })
  await page.getByLabel("Definition").fill(
    JSON.stringify({
      image: `ghcr.io/example/docs@sha256:${"a".repeat(64)}`,
      source: "ghcr.io/example/docs:latest",
      ports: [{ container: 5001 }],
      env: [{ name: "API_KEY", required: true }],
      health: { kind: "http", port: 5001, path: "/health" },
      registers: { kind: "openapi", port: 5001, specPath: "/openapi.json" },
    }),
  )
  // Published on the SSH server's own 127.0.0.1 unless chosen otherwise.
  await expect(page.getByLabel("Publish on")).toHaveCount(0)
  await page.getByLabel("The SSH server's port for 5001").fill(String(port))
  await page.getByLabel("API_KEY").selectOption({ label: SECRET })
  await page.getByRole("button", { name: "Launch" }).click()

  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  const card = page.getByTestId("service-card")
  await expect(card).toContainText("Running and healthy")
  await expect(card).toContainText("Serves")

  // The value went over standard input, never on a command line.
  expect(docker.state().containers[`pcp-docs-${RUN}`]?.env).toBe(
    `API_KEY=${VALUE}\n`,
  )
  expect(JSON.stringify(docker.commands)).not.toContain(VALUE)

  // Stopped from its page, it says so.
  acceptNextDialog(page)
  await clickHydrated(card.getByRole("button", { name: "Stop" }))
  await expect(card).toContainText("Stopped")
  await clickHydrated(card.getByRole("button", { name: "Start" }))
  await expect(card).toContainText("Running and healthy")

  // A newer image is looked for on a click, and nothing is made again.
  await clickHydrated(
    card.getByRole("button", { name: "Check for a newer image" }),
  )
  await expect(card.getByTestId("newer-image")).toContainText(
    `A newer image of ghcr.io/example/docs:latest: ghcr.io/example/docs@sha256:${"b".repeat(64)}`,
  )
  expect(docker.state().containers[`pcp-docs-${RUN}`]?.image).toBe(
    `ghcr.io/example/docs@sha256:${"a".repeat(64)}`,
  )

  // The endpoint it serves is a server of its own.
  await card.getByRole("link", { name: /Serves/ }).click()
  await expect(page.getByRole("heading", { name: NAME })).toBeVisible()
  await expect(page.getByText("list_things")).toBeVisible()
})

test("a service that signs in to an account: PCP's own sign-in page takes the code", async ({
  page,
}) => {
  // On the SSH server the first test pinned, at a port of its own.
  await page.goto("/servers/services/new")
  await page.getByLabel("Name", { exact: true }).fill(`Sessions ${RUN}`)
  await page
    .getByLabel("SSH server", { exact: true })
    .selectOption({ label: `${HOST} (127.0.0.1)` })
  await page.getByLabel("Definition").fill(
    JSON.stringify({
      image: `ghcr.io/example/sessions@sha256:${"c".repeat(64)}`,
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
    }),
  )
  await page
    .getByLabel("The SSH server's port for 8080")
    .fill(String(sessionsPort))
  // Its token is PCP's to make: nothing to choose, and the form says so.
  await expect(page.getByLabel("MCP_AUTH_TOKEN")).toHaveValue("")
  await expect(page.getByTestId("service-form-signin")).toContainText(
    "login_start",
  )
  await page.getByRole("button", { name: "Launch" }).click()

  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  const card = page.getByTestId("service-card")
  await expect(card).toContainText("Running and healthy")
  await expect(card).toContainText("MCP_AUTH_TOKEN")
  await expect(card).toContainText("(made by PCP)")

  // Its account, on PCP's own sign-in page.
  await card.getByTestId("service-account").click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+\/sign-in$/)
  const signIn = page.getByTestId("service-sign-in")
  // Nothing starts by itself: a reload or a second tab would end the sign-in
  // in progress.
  await expect(signIn).toContainText("Not signed in")
  await expect(signIn.getByTestId("sign-in-link")).toHaveCount(0)
  await clickHydrated(signIn.getByRole("button", { name: "Start signing in" }))
  await expect(signIn).toContainText("Open claude.ai")
  await expect(signIn.getByTestId("sign-in-link")).toHaveAttribute(
    "href",
    `https://claude.ai/oauth/authorize?state=${RUN}`,
  )

  // A wrong code is refused, and says so without the code.
  await signIn.getByLabel("2. Paste the code").fill("not-the-code-123")
  await signIn.getByRole("button", { name: "Sign in" }).click()
  await expect(signIn).toContainText("did not take the code")
  await expect(signIn).not.toContainText("not-the-code-123")

  await signIn.getByLabel("2. Paste the code").fill(CODE)
  await signIn.getByRole("button", { name: "Sign in" }).click()
  await expect(signIn).toContainText("Signed in as ada@example.com")
  await expect(page.getByText(CODE)).toHaveCount(0)

  // Opened again, it reads who is signed in.
  await page.reload()
  await expect(page.getByTestId("service-sign-in")).toContainText(
    "Signed in as ada@example.com",
  )
})
