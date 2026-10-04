import { expect, test } from "@playwright/test"

import { keyedSpec, startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, toolText } from "../lib/mcp"
import { addSecret, allowAllTools, createToken } from "../lib/ui"

// An API whose credential comes in two parts, a key and a secret key each in
// its own header (Porkbun's, for one). Every part is a secret PCP sends; none
// is ever a tool argument, so no assistant handles any of it.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const KEY_NAME = `Domains key ${RUN}`
const SECRET_KEY_NAME = `Domains secret key ${RUN}`
const NAME = `Domains ${RUN}`
const SLUG = `domains-${RUN}`
const TOKEN_NAME = `Domains assistant ${RUN}`

let upstream: Upstream
let token: string

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

test("the owner adds an API that wants a key and a secret key", async ({
  page,
}) => {
  await addSecret(page, { name: KEY_NAME, value: upstream.keyedKeys.apiKey })
  await addSecret(page, {
    name: SECRET_KEY_NAME,
    value: upstream.keyedKeys.secretKey,
  })

  await page.goto("/servers/endpoints/new")
  await page.getByLabel("Name", { exact: true }).fill(NAME)
  await page
    .getByLabel("Schema URL")
    .fill(`${upstream.origin}/keyed/openapi.json`)
  await page.getByLabel("Authentication").selectOption("header")
  await page
    .getByLabel("Secret", { exact: true })
    .selectOption({ label: KEY_NAME })
  await page.getByLabel("Header", { exact: true }).fill("X-API-Key")
  await page.getByLabel("Value", { exact: true }).fill("{{secret}}")

  await page.getByRole("button", { name: "Add another secret header" }).click()
  await page
    .getByLabel("Secret 2", { exact: true })
    .selectOption({ label: SECRET_KEY_NAME })
  await page.getByLabel("Header 2", { exact: true }).fill("X-Secret-API-Key")
  await expect(page.getByLabel("Value 2", { exact: true })).toHaveValue(
    "{{secret}}",
  )
  await page.getByRole("button", { name: "Add endpoint" }).click()

  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await expect(page.getByText("Ready", { exact: true })).toBeVisible()
  // Both parts are sent, so there is nothing to say about the credential.
  await expect(page.getByText(/does not send/)).toHaveCount(0)
  // The second header is kept with the endpoint.
  await expect(page.getByLabel("Header 2", { exact: true })).toHaveValue(
    "X-Secret-API-Key",
  )

  await page.getByLabel("Short name").fill(SLUG)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()

  // Each secret is used by the endpoint.
  await page.goto("/secrets")
  for (const secret of [KEY_NAME, SECRET_KEY_NAME]) {
    await expect(
      page.getByRole("listitem").filter({ hasText: secret }).getByText(NAME),
    ).toBeVisible()
  }
})

test("a call carries both keys, and neither reaches the assistant", async ({
  page,
  baseURL,
}) => {
  token = await createToken(page, TOKEN_NAME)
  await allowAllTools(page, TOKEN_NAME, SLUG)

  const described = toolText(
    await callTool(baseURL!, token, "describe_tool", {
      server: SLUG,
      tool: "ping",
    }),
  )
  expect(described).not.toMatch(/X-Secret-API-Key/i)

  const result = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "ping",
    arguments: {},
  })
  expect(result.body.result?.isError ?? false, toolText(result)).toBe(false)
  expect(toolText(result)).toContain("SUCCESS")
  expect(upstream.keyedRequests.at(-1)).toEqual(upstream.keyedKeys)

  // The API echoed the secret key back; the assistant reads it redacted.
  const answer = JSON.stringify(result.body)
  expect(answer).toContain("[redacted]")
  expect(answer).not.toContain(upstream.keyedKeys.secretKey)
  expect(answer).not.toContain(upstream.keyedKeys.apiKey)
})

test("an assistant proposes such an API, naming each secret, and the owner sees them all", async ({
  page,
  baseURL,
}) => {
  const proposed = `Proposed domains ${RUN}`
  const asked = await callTool(baseURL!, token, "register_server", {
    name: proposed,
    url: `${upstream.origin}/keyed`,
    openapi_schema: JSON.stringify(keyedSpec(upstream.origin)),
    auth_type: "header",
    secret: KEY_NAME,
    header_name: "X-API-Key",
    value_template: "{{secret}}",
    extra_headers: [
      { secret: SECRET_KEY_NAME, header_name: "X-Secret-API-Key" },
    ],
  })
  expect(toolText(asked)).toContain("Not done yet")
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, toolText(asked)).toBeTruthy()

  await page.goto(`/permissions/${id}`)
  await expect(
    page.getByText(
      `Authentication: sends your secret "${KEY_NAME}" in the X-API-Key header, and "${SECRET_KEY_NAME}" in the X-Secret-API-Key header`,
    ),
  ).toBeVisible()
  await expect(
    page.getByText(`the secrets "${KEY_NAME}" and "${SECRET_KEY_NAME}"`),
  ).toBeVisible()
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText("1 tool")

  // A secret named that does not exist is refused before anyone is asked.
  const unknown = await callTool(baseURL!, token, "register_server", {
    name: `${proposed} again`,
    url: `${upstream.origin}/keyed`,
    openapi_schema: JSON.stringify(keyedSpec(upstream.origin)),
    auth_type: "header",
    secret: KEY_NAME,
    extra_headers: [
      { secret: `No such secret ${RUN}`, header_name: "X-Secret-API-Key" },
    ],
  })
  expect(unknown.body.result?.isError).toBe(true)
  expect(toolText(unknown)).toContain("No secret called")
})
