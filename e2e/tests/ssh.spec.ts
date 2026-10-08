import { expect, test } from "@playwright/test"

import { startFakeSsh, type FakeSsh } from "../../lib/core/ssh/fake-server"
import { fingerprint } from "../../lib/core/ssh/keys"
import { callTool, toolText } from "../lib/mcp"
import { createToken } from "../lib/ui"

// An SSH server, added in PCP and used by an assistant through /mcp. PCP
// signs in with a key of its own, which the owner puts in the login's
// authorized_keys, and pins the server's host key the first time it
// connects; a server that later shows another key is refused until the
// owner forgets the pinned one. The test SSH server runs in this process
// and records the logins and commands it saw.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const NAME = `Build box ${RUN}`
const SLUG = `build-box-${RUN}`
const TOKEN_NAME = `SSH assistant ${RUN}`

let fake: FakeSsh
/** The test server's authorized_keys. */
let authorized: string | null = null
let token: string

function startServer(port?: number) {
  return startFakeSsh({
    port,
    authorizedKey: () => authorized,
    run: (command, stdin) => ({
      stdout: `ran ${command}${stdin.length ? ` with ${stdin.toString()}` : ""}\n`,
      exitCode: 0,
    }),
  })
}

test.beforeAll(async () => {
  fake = await startServer()
})

test.afterAll(async () => {
  await fake?.close()
})

test("an SSH server signs in once PCP's key is in authorized_keys", async ({
  page,
}) => {
  await page.goto("/servers")
  await page.getByRole("link", { name: "Add an SSH server" }).click()
  await expect(page).toHaveURL(/\/servers\/ssh\/new$/)
  await page.getByLabel("Name", { exact: true }).fill(NAME)
  await page.getByLabel("Description").fill("The CI runner.")
  await page.getByLabel("Host", { exact: true }).fill("127.0.0.1")
  await page.getByLabel("Port").fill(String(fake.port))
  await page.getByLabel("Login").fill("deploy")
  await page.getByRole("button", { name: "Add SSH server" }).click()

  // PCP connected once: the host key is pinned, PCP's key not yet accepted.
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await expect(
    page.getByText("Key not accepted", { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText(/deploy's ~\/.ssh\/authorized_keys/),
  ).toBeVisible()
  await expect(page.getByTestId("ssh-host-key")).toContainText(
    fingerprint(fake.hostKey),
  )
  await expect(page.getByText("Tools (1)")).toBeVisible()
  const publicKey = (await page.getByTestId("ssh-public-key").textContent())!
  expect(publicKey).toMatch(/^ssh-ed25519 \S+ pcp-build-box-/)
  expect(fake.logins).toEqual([])

  await page.getByLabel("Short name").fill(SLUG)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()

  authorized = publicKey
  await page.getByRole("button", { name: "Check sign-in" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "PCP signed in." }),
  ).toBeVisible()
  expect(fake.logins).toEqual(["deploy"])
  await page.reload()
  await expect(page.getByText("Ready", { exact: true })).toBeVisible()

  // The key PCP made is a secret of its own, used by this server.
  await page.goto("/secrets")
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "SSH key" })
      .filter({ hasText: NAME }),
  ).toBeVisible()
})

test("an assistant's command is shown to the owner before it runs", async ({
  page,
  baseURL,
}) => {
  token = await createToken(page, TOKEN_NAME)
  const args = {
    server: SLUG,
    tool: "run_command",
    arguments: { command: "uptime" },
  }

  const asked = await callTool(baseURL!, token, "call_tool", args)
  expect(toolText(asked)).toContain("Not done yet")
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, toolText(asked)).toBeTruthy()
  expect(fake.commands).toEqual([])

  await page.goto(`/permissions/${id}`)
  await expect(page.getByText(`Allow ${SLUG}/run_command?`)).toBeVisible()
  await expect(page.getByText("command: uptime")).toBeVisible()
  await page.getByRole("button", { name: "Always allow" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "ran uptime",
  )
  expect(fake.commands).toEqual(["uptime"])

  const outcome = await callTool(baseURL!, token, "check_permission", { id })
  expect(toolText(outcome)).toContain("ran uptime")

  // Allowed now: the next command runs at once, with its standard input.
  const direct = await callTool(baseURL!, token, "call_tool", {
    ...args,
    arguments: { command: "cat", stdin: "hello" },
  })
  expect(JSON.parse(toolText(direct))).toMatchObject({
    exit_code: 0,
    stdout: "ran cat with hello\n",
  })
})

test("a server with another host key is refused until the owner forgets the old one", async ({
  page,
  baseURL,
}) => {
  // The same address, another machine: a new host key.
  const port = fake.port
  const before = fake.hostKey
  await fake.close()
  fake = await startServer(port)
  expect(fake.hostKey).not.toBe(before)

  const call = () =>
    callTool(baseURL!, token, "call_tool", {
      server: SLUG,
      tool: "run_command",
      arguments: { command: "uptime" },
    })

  const refused = await call()
  expect(toolText(refused)).toMatch(/not the one PCP pinned/)
  expect(fake.logins).toEqual([])

  await page.goto("/servers")
  await page.getByRole("link").filter({ hasText: NAME }).click()
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible()
  await expect(page.getByTestId("ssh-host-key")).toContainText(
    fingerprint(before),
  )

  page.once("dialog", (dialog) => void dialog.accept())
  await page.getByRole("button", { name: "Forget host key" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: /Forgotten.*PCP signed in\./ }),
  ).toBeVisible()
  await expect(page.getByTestId("ssh-host-key")).toContainText(
    fingerprint(fake.hostKey),
  )

  expect(JSON.parse(toolText(await call()))).toMatchObject({ exit_code: 0 })
})
