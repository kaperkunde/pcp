import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, toolText } from "../lib/mcp"
import { allowAllTools, createToken } from "../lib/ui"

// An API that wants HTTP Basic authentication: a user name and a password
// PCP sends encoded, which the owner types into the form or an assistant
// proposes through register_server, naming the password and never seeing it.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const NAME = `Basic whoami ${RUN}`
const SLUG = `basic-whoami-${RUN}`
const TOKEN_NAME = `Basic assistant ${RUN}`

let upstream: Upstream
let token: string

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

function basic(): string {
  const { username, password } = upstream.basicUser
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

test("the owner adds an API with a user name and a password typed into the form", async ({
  page,
}) => {
  await page.goto("/servers/endpoints/new")
  await page.getByLabel("Name", { exact: true }).fill(NAME)
  await page.getByLabel("Schema URL").fill(upstream.basicApiSpecUrl)
  await page.getByLabel("Authentication").selectOption("basic")
  await page.getByLabel("User name").fill(upstream.basicUser.username)
  await page
    .getByLabel("Password", { exact: true })
    .selectOption({ label: "A new password, entered here" })
  await page.getByLabel("New password").fill(upstream.basicUser.password)
  await page.getByLabel("Base URL").fill(upstream.basicApiUrl)
  await page.getByRole("button", { name: "Add endpoint" }).click()

  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await expect(page.getByText("Ready", { exact: true })).toBeVisible()
  // The schema asks for Basic and the endpoint sends it: nothing to say.
  await expect(page.getByText(/this endpoint sends none/)).toHaveCount(0)
  // The user name is kept with the endpoint.
  await expect(page.getByLabel("User name")).toHaveValue(
    upstream.basicUser.username,
  )

  await page.getByLabel("Short name").fill(SLUG)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()

  // The password is a secret of the owner's, used by the endpoint.
  await page.goto("/secrets")
  await expect(
    page.getByRole("listitem").filter({ hasText: NAME }),
  ).toBeVisible()
})

test("a call carries the login, and neither the password nor the encoded login reaches the assistant", async ({
  page,
  baseURL,
}) => {
  token = await createToken(page, TOKEN_NAME)
  await allowAllTools(page, TOKEN_NAME, SLUG)

  const described = toolText(
    await callTool(baseURL!, token, "describe_tool", {
      server: SLUG,
      tool: "whoami",
    }),
  )
  expect(described).not.toMatch(/authorization/i)

  const result = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "whoami",
    arguments: {},
  })
  expect(result.body.result?.isError ?? false, toolText(result)).toBe(false)
  expect(toolText(result)).toContain(upstream.basicUser.username)
  expect(upstream.basicApiRequests.at(-1)).toEqual({
    path: "/basic-api/whoami",
    authorization: basic(),
  })

  // The API echoed the header back; the assistant reads it redacted.
  const answer = JSON.stringify(result.body)
  expect(answer).toContain("[redacted]")
  expect(answer).not.toContain(upstream.basicUser.password)
  expect(answer).not.toContain(basic().replace("Basic ", ""))
})

test("an assistant proposes such an API, naming the user name and the password, which the owner types in PCP", async ({
  page,
  baseURL,
}) => {
  const proposed = `Proposed basic ${RUN}`
  const secretName = `Proposed basic password ${RUN}`

  const asked = await callTool(baseURL!, token, "register_server", {
    name: proposed,
    openapi_schema: await (await fetch(upstream.basicApiSpecUrl)).text(),
    url: upstream.basicApiUrl,
    auth_type: "basic",
    username: upstream.basicUser.username,
    secret: secretName,
  })
  expect(asked.body.result?.isError ?? false, toolText(asked)).toBe(false)
  expect(toolText(asked)).toContain(
    `They type the password for ${upstream.basicUser.username} in there`,
  )
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, toolText(asked)).toBeTruthy()

  await page.goto(`/permissions/${id}`)
  await expect(
    page.getByText(`Add the API endpoint ${proposed}?`),
  ).toBeVisible()
  await expect(
    page.getByText(
      `Authentication: sends a new secret, saved as "${secretName}", as the password for ${upstream.basicUser.username} (HTTP Basic)`,
    ),
  ).toBeVisible()
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(
    page.getByText(
      `Enter the password for ${upstream.basicUser.username} first.`,
    ),
  ).toBeVisible()
  await page
    .getByLabel(`Password for ${upstream.basicUser.username}`)
    .fill(upstream.basicUser.password)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `Added ${proposed}`,
  )

  // The assistant learns the outcome, never the password.
  const outcome = await callTool(baseURL!, token, "check_permission", {
    id: id!,
  })
  expect(toolText(outcome)).not.toContain(upstream.basicUser.password)

  // An assistant's endpoint reaches public addresses only, and the fake API
  // is on loopback: the owner allows it on the endpoint's page.
  const slug = `proposed-basic-${RUN}`
  await page.goto("/servers")
  await page.getByRole("link").filter({ hasText: proposed }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await page.getByLabel("Public addresses only").uncheck()
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()
  await allowAllTools(page, TOKEN_NAME, slug)
  const result = await callTool(baseURL!, token, "call_tool", {
    server: slug,
    tool: "whoami",
    arguments: {},
  })
  expect(result.body.result?.isError ?? false, toolText(result)).toBe(false)
  expect(upstream.basicApiRequests.at(-1)!.authorization).toBe(basic())

  // The endpoint is the owner's now, and says so to an assistant that reads
  // it: how it signs in, never as whom.
  const read = toolText(
    await callTool(baseURL!, token, "get_endpoint", { endpoint: slug }),
  )
  expect(read).not.toContain(upstream.basicUser.password)
})

test("an assistant is told what to pass when it names a user name without a password", async ({
  baseURL,
}) => {
  const refused = await callTool(baseURL!, token, "register_server", {
    name: `Missing password ${RUN}`,
    openapi_schema: await (await fetch(upstream.basicApiSpecUrl)).text(),
    url: upstream.basicApiUrl,
    auth_type: "basic",
    username: upstream.basicUser.username,
  })
  expect(refused.body.result?.isError).toBe(true)
  expect(toolText(refused)).toContain(
    "needs the name of the secret that holds the password",
  )
})
