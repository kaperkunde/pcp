import { expect, test, type Page } from "@playwright/test"

import { keyedSpec, startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, toolText } from "../lib/mcp"
import { addSecret, allowAllTools, createToken, openAdvanced } from "../lib/ui"

// APIs whose credential is more than one bearer token, proposed by an
// assistant that names the secrets and never sees them: HTTP Basic (a user
// name and a password the owner types in on PCP's page), and a key and a
// secret key in two headers (as Porkbun's is). Every part is a secret PCP
// sends; none is ever a tool argument, and what the API echoes back reaches
// the assistant redacted.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const TOKEN_NAME = `Credentials assistant ${RUN}`

let upstream: Upstream
let token: string

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

/**
 * An assistant's endpoint reaches public addresses only, and the fake API
 * is on loopback: the owner allows it on the endpoint's page.
 */
async function allowPrivateAddresses(page: Page, name: string) {
  await page.goto("/servers")
  await page.getByRole("link").filter({ hasText: name }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await openAdvanced(page)
  await page.getByLabel("Public addresses only").uncheck()
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()
}

function permissionId(text: string): string {
  const id = text.match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, text).toBeTruthy()
  return id!
}

test("an assistant proposes an API with a user name and a password, which the owner types in PCP", async ({
  page,
  baseURL,
}) => {
  const { username, password } = upstream.basicUser
  const basic = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  const proposed = `Proposed basic ${RUN}`
  const slug = `proposed-basic-${RUN}`
  const secretName = `Proposed basic password ${RUN}`

  token = await createToken(page, TOKEN_NAME)

  // A user name without the password's name is refused with what to pass.
  const missing = await callTool(baseURL!, token, "register_server", {
    name: proposed,
    openapi_schema: await (await fetch(upstream.basicApiSpecUrl)).text(),
    url: upstream.basicApiUrl,
    auth_type: "basic",
    username,
  })
  expect(missing.body.result?.isError).toBe(true)
  expect(toolText(missing)).toContain(
    "needs the name of the secret that holds the password",
  )

  const asked = await callTool(baseURL!, token, "register_server", {
    name: proposed,
    openapi_schema: await (await fetch(upstream.basicApiSpecUrl)).text(),
    url: upstream.basicApiUrl,
    auth_type: "basic",
    username,
    secret: secretName,
  })
  expect(asked.body.result?.isError ?? false, toolText(asked)).toBe(false)
  expect(toolText(asked)).toContain(
    `They type the password for ${username} in there`,
  )
  const id = permissionId(toolText(asked))

  await page.goto(`/permissions/${id}`)
  await expect(
    page.getByText(`Add the API endpoint ${proposed}?`),
  ).toBeVisible()
  await expect(
    page.getByText(
      `Authentication: sends a new secret, saved as "${secretName}", as the password for ${username} (HTTP Basic)`,
    ),
  ).toBeVisible()
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(
    page.getByText(`Enter the password for ${username} first.`),
  ).toBeVisible()
  await page.getByLabel(`Password for ${username}`).fill(password)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `Added ${proposed}`,
  )

  // The assistant learns the outcome, never the password.
  const outcome = await callTool(baseURL!, token, "check_permission", { id })
  expect(toolText(outcome)).not.toContain(password)

  await allowPrivateAddresses(page, proposed)
  await allowAllTools(page, TOKEN_NAME, slug)

  const described = toolText(
    await callTool(baseURL!, token, "describe_tool", {
      server: slug,
      tool: "whoami",
    }),
  )
  expect(described).not.toMatch(/authorization/i)

  const result = await callTool(baseURL!, token, "call_tool", {
    server: slug,
    tool: "whoami",
    arguments: {},
  })
  expect(result.body.result?.isError ?? false, toolText(result)).toBe(false)
  expect(toolText(result)).toContain(username)
  expect(upstream.basicApiRequests.at(-1)).toEqual({
    path: "/basic-api/whoami",
    authorization: basic,
  })

  // The API echoed the header back; the assistant reads it redacted.
  const answer = JSON.stringify(result.body)
  expect(answer).toContain("[redacted]")
  expect(answer).not.toContain(password)
  expect(answer).not.toContain(basic.replace("Basic ", ""))

  // The endpoint is the owner's now, and says how it signs in, never with
  // what.
  const read = toolText(
    await callTool(baseURL!, token, "get_endpoint", { endpoint: slug }),
  )
  expect(read).not.toContain(password)
})

test("an assistant proposes an API with a key and a secret key in two headers, and neither reaches it", async ({
  page,
  baseURL,
}) => {
  const keyName = `Domains key ${RUN}`
  const secretKeyName = `Domains secret key ${RUN}`
  const proposed = `Proposed domains ${RUN}`
  const slug = `proposed-domains-${RUN}`
  await addSecret(page, { name: keyName, value: upstream.keyedKeys.apiKey })
  await addSecret(page, {
    name: secretKeyName,
    value: upstream.keyedKeys.secretKey,
  })

  // A secret named that does not exist is refused before anyone is asked.
  const unknown = await callTool(baseURL!, token, "register_server", {
    name: proposed,
    url: `${upstream.origin}/keyed`,
    openapi_schema: JSON.stringify(keyedSpec(upstream.origin)),
    auth_type: "header",
    secret: keyName,
    extra_headers: [
      { secret: `No such secret ${RUN}`, header_name: "X-Secret-API-Key" },
    ],
  })
  expect(unknown.body.result?.isError).toBe(true)
  expect(toolText(unknown)).toContain("No secret called")

  const asked = await callTool(baseURL!, token, "register_server", {
    name: proposed,
    url: `${upstream.origin}/keyed`,
    openapi_schema: JSON.stringify(keyedSpec(upstream.origin)),
    auth_type: "header",
    secret: keyName,
    header_name: "X-API-Key",
    value_template: "{{secret}}",
    extra_headers: [{ secret: secretKeyName, header_name: "X-Secret-API-Key" }],
  })
  expect(toolText(asked)).toContain("Not done yet")
  const id = permissionId(toolText(asked))

  // The owner sees every secret and the header it goes in.
  await page.goto(`/permissions/${id}`)
  await expect(
    page.getByText(
      `Authentication: sends your secret "${keyName}" in the X-API-Key header, and "${secretKeyName}" in the X-Secret-API-Key header`,
    ),
  ).toBeVisible()
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText("1 tool")

  await allowPrivateAddresses(page, proposed)
  await allowAllTools(page, TOKEN_NAME, slug)

  const described = toolText(
    await callTool(baseURL!, token, "describe_tool", {
      server: slug,
      tool: "ping",
    }),
  )
  expect(described).not.toMatch(/X-Secret-API-Key/i)

  const result = await callTool(baseURL!, token, "call_tool", {
    server: slug,
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
