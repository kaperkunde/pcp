import { expect, test } from "@playwright/test"

import {
  issueCertificate,
  makeEd25519,
  startFakeSsh,
  type FakeSsh,
  type TestCa,
} from "../../lib/core/ssh/fake-server"
import {
  certificateLine,
  parsePublicKeyLine,
  publicKeyLine,
} from "../../lib/core/ssh/keys"
import { callTool, toolText } from "../lib/mcp"
import { createToken } from "../lib/ui"

// An SSH server, added in PCP and used by an assistant through /mcp. PCP
// signs in with a certificate only: the page shows PCP's own key, the
// owner's CA signs it (here, the test's), and nothing runs until that
// certificate is pasted. The server proves itself with a host certificate
// from the CA the owner gave, or PCP does not connect. The test SSH server
// runs in this process and records the logins and commands it saw.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const NAME = `Build box ${RUN}`
const SLUG = `build-box-${RUN}`
const TOKEN_NAME = `SSH assistant ${RUN}`

let fake: FakeSsh
let hostCa: TestCa
let userCa: TestCa
let token: string

test.beforeAll(async () => {
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
      stdout: `ran ${command}${stdin.length ? ` with ${stdin.toString()}` : ""}\n`,
      exitCode: 0,
    }),
  })
})

test.afterAll(async () => {
  await fake?.close()
})

/** What the owner does with ssh-keygen -s: sign the key the page shows. */
function sign(publicKey: string, principals = ["deploy"]): string {
  return certificateLine(
    issueCertificate({
      ca: userCa,
      key: parsePublicKeyLine(publicKey),
      type: "user",
      principals,
      keyId: "pcp",
    }),
  )
}

test("an SSH server runs nothing until PCP's key is signed", async ({
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
  await page
    .getByLabel("Host CA")
    .fill(`@cert-authority * ${publicKeyLine(hostCa.publicKey, "host-ca")}`)
  await page.getByRole("button", { name: "Add SSH server" }).click()

  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await expect(
    page.getByText("Needs a certificate", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Tools (1)")).toBeVisible()
  const publicKey = (await page.getByTestId("ssh-public-key").textContent())!
  expect(publicKey).toMatch(/^ssh-ed25519 \S+ pcp-build-box-/)
  await page.getByLabel("Short name").fill(SLUG)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()

  // Signed for another login: refused before anything connects.
  await page
    .getByLabel("Certificate", { exact: true })
    .fill(sign(publicKey, ["root"]))
  await page.getByRole("button", { name: "Save certificate" }).click()
  await expect(page.getByText(/It is not for deploy/)).toBeVisible()
  expect(fake.logins).toEqual([])

  await page.getByLabel("Certificate", { exact: true }).fill(sign(publicKey))
  await page.getByRole("button", { name: "Save certificate" }).click()
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Certificate saved. PCP signed in." }),
  ).toBeVisible()
  expect(fake.logins).toEqual(["deploy"])

  await page.reload()
  await expect(page.getByText("Ready", { exact: true })).toBeVisible()
  await expect(page.getByTestId("ssh-certificate")).toContainText("deploy")

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

test("PCP does not connect to a host its CA did not certify", async ({
  page,
  baseURL,
}) => {
  await page.goto("/servers")
  await page.getByRole("link").filter({ hasText: NAME }).click()
  await page
    .getByLabel("Host CA")
    .fill(publicKeyLine(makeEd25519().publicKey, "another-ca"))
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: /CA you have not given PCP/ }),
  ).toBeVisible()
  await page.reload()
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible()

  const logins = fake.logins.length
  const refused = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "run_command",
    arguments: { command: "uptime" },
  })
  expect(toolText(refused)).toMatch(/CA you have not given PCP/)
  expect(fake.logins.length).toBe(logins)
})
