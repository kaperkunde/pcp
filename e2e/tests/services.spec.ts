import { createServer, type Server } from "node:http"
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
// is an HTTP server in this process, at the port the form publishes. The
// launch registers its API endpoint in the same step; the secret for its
// variable reaches the engine only through the env file.
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
let authorized: string | null = null

test.beforeAll(async () => {
  docker = startFakeDocker()
  ssh = await startFakeSsh({
    authorizedKey: () => authorized,
    run: docker.run,
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
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => http?.close(() => resolve()))
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
    .getByLabel("SSH server")
    .selectOption({ label: `${HOST} (127.0.0.1)` })
  await page.getByLabel("Definition").fill(
    JSON.stringify({
      image: `ghcr.io/example/docs@sha256:${"a".repeat(64)}`,
      ports: [{ container: 5001 }],
      env: [{ name: "API_KEY", required: true }],
      health: { kind: "http", port: 5001, path: "/health" },
      registers: { kind: "openapi", port: 5001, specPath: "/openapi.json" },
    }),
  )
  await page.getByLabel("Publish on").fill("127.0.0.1")
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

  // The endpoint it serves is a server of its own.
  await card.getByRole("link", { name: /Serves/ }).click()
  await expect(page.getByRole("heading", { name: NAME })).toBeVisible()
  await expect(page.getByText("list_things")).toBeVisible()
})
