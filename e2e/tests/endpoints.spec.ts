import path from "node:path"

import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, initialize, toolText } from "../lib/mcp"
import { addSecret, createToken } from "../lib/ui"

// An API described by an OpenAPI schema, added like a server: PCP reads the
// schema, an assistant finds the operations as tools through /mcp, and PCP
// makes the HTTP calls itself with the stored secret — which only the API
// ever sees.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const SECRET_NAME = `Pet store key ${RUN}`
const NAME = `Pet store ${RUN}`
const SLUG = `pets-${RUN}`

let upstream: Upstream
let token: string
let endpointId: string

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

const lastRequest = () => upstream.requests.at(-1)

test("adds an endpoint from a schema URL, with a stored secret", async ({
  page,
}) => {
  await addSecret(page, { name: SECRET_NAME, value: upstream.expectedToken })

  await page.goto("/servers")
  await page.getByRole("link", { name: "Add an endpoint" }).click()
  await expect(page).toHaveURL(/\/servers\/endpoints\/new$/)

  await page.getByLabel("Name", { exact: true }).fill(NAME)
  await page.getByLabel("Description").fill("Pets for sale.")
  await page.getByLabel("Schema URL").fill(upstream.openapiUrl)
  await page.getByLabel("Authentication").selectOption("header")
  await page.getByLabel("Secret").selectOption({ label: SECRET_NAME })
  await page.getByRole("button", { name: "Add endpoint" }).click()

  // PCP read the schema on the way in.
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  endpointId = page.url().split("/").pop()!
  await expect(page.getByText("Ready", { exact: true })).toBeVisible()
  await expect(page.getByText("Tools (4)")).toBeVisible()
  await expect(page.locator("code", { hasText: "listPets" })).toBeVisible()
  await expect(
    page.locator("code", { hasText: "GET /pets/{petId}" }),
  ).toBeVisible()
  // What was left out is said, not hidden.
  await expect(page.getByText(/Skipped 2/)).toBeVisible()
  await expect(page.getByText(/it needs a file upload/)).toBeVisible()

  // The base URL came from the schema, and the secret was never sent to the
  // place the schema was downloaded from.
  await expect(page.getByText(`${upstream.origin}/api`).first()).toBeVisible()
  expect(upstream.requests).toHaveLength(0)

  await page.getByLabel("Short name").fill(SLUG)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()
})

test("lists the endpoint under API endpoints, and its secret as used", async ({
  page,
}) => {
  await page.goto("/servers")
  await expect(
    page.getByRole("heading", { name: "API endpoints" }),
  ).toBeVisible()
  const card = page.getByRole("link").filter({ hasText: NAME })
  await expect(card).toBeVisible()
  await expect(card.getByText("4 operations")).toBeVisible()

  await page.goto("/secrets")
  const row = page.getByRole("listitem").filter({ hasText: SECRET_NAME })
  await expect(row.getByText(NAME)).toBeVisible()
})

test("an assistant finds and describes the operations", async ({
  page,
  baseURL,
}) => {
  token = await createToken(page, `Pets assistant ${RUN}`)

  const { instructions } = await initialize(baseURL!, token)
  expect(instructions).toContain(`${SLUG}: Pets for sale. (4 tools)`)

  const search = await callTool(baseURL!, token, "search_tools", {
    query: "list pets",
    server: SLUG,
  })
  expect(toolText(search)).toMatch(
    new RegExp(`^${SLUG}/listPets \\(List pets\\)`),
  )

  const described = JSON.parse(
    toolText(
      await callTool(baseURL!, token, "describe_tool", {
        server: SLUG,
        tool: "getPet",
      }),
    ),
  ) as {
    description: string
    inputSchema: { properties: Record<string, unknown>; required: string[] }
    annotations: { readOnlyHint: boolean }
  }
  expect(Object.keys(described.inputSchema.properties)).toEqual(["petId"])
  expect(described.inputSchema.required).toEqual(["petId"])
  expect(described.annotations.readOnlyHint).toBe(true)
  expect(described.description).toContain("GET /pets/{petId}")

  const create = JSON.parse(
    toolText(
      await callTool(baseURL!, token, "describe_tool", {
        server: SLUG,
        tool: "createPet",
      }),
    ),
  ) as { inputSchema: { properties: { body: { properties: object } } } }
  // The schema's readOnly id is not something a request carries.
  expect(Object.keys(create.inputSchema.properties.body.properties)).toEqual([
    "name",
    "status",
  ])
})

test("calling an operation makes the HTTP request, with the secret added by PCP", async ({
  baseURL,
}) => {
  const list = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "listPets",
    arguments: { status: "available", limit: 1 },
  })
  expect(list.body.result?.isError ?? false, toolText(list)).toBe(false)
  expect(JSON.parse(toolText(list))).toEqual([
    { id: 1, name: "Fido", status: "available" },
  ])
  expect(lastRequest()).toMatchObject({
    method: "GET",
    path: "/api/pets",
    query: { status: "available", limit: "1" },
    authorization: `Bearer ${upstream.expectedToken}`,
  })

  const created = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "createPet",
    arguments: { body: { name: "Rex", status: "available" } },
  })
  expect(JSON.parse(toolText(created))).toMatchObject({ id: 3, name: "Rex" })
  expect(lastRequest()).toMatchObject({
    method: "POST",
    path: "/api/pets",
    contentType: "application/json",
  })
  expect(JSON.parse(lastRequest()!.body)).toEqual({
    name: "Rex",
    status: "available",
  })

  const one = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "getPet",
    arguments: { petId: 3 },
  })
  expect(JSON.parse(toolText(one))).toMatchObject({ name: "Rex" })
  expect(lastRequest()).toMatchObject({ method: "GET", path: "/api/pets/3" })

  // The assistant never reads the secret, only what the API answered.
  expect(JSON.stringify([list, created, one])).not.toContain(
    upstream.expectedToken,
  )
})

test("errors reach the assistant as readable results, and bad input never leaves PCP", async ({
  baseURL,
}) => {
  const missing = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "getPet",
    arguments: { petId: 999 },
  })
  expect(missing.body.result?.isError).toBe(true)
  expect(toolText(missing)).toContain("HTTP 404")

  const before = upstream.requests.length

  const unknown = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "listPets",
    arguments: { bogus: 1 },
  })
  expect(unknown.body.result?.isError).toBe(true)
  expect(toolText(unknown)).toContain('Unknown argument "bogus"')

  const dots = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "getPet",
    arguments: { petId: ".." },
  })
  expect(dots.body.result?.isError).toBe(true)
  expect(toolText(dots)).toContain("cannot be empty")

  const absent = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "getPet",
    arguments: {},
  })
  expect(toolText(absent)).toContain('Missing argument "petId"')

  // None of the three reached the API.
  expect(upstream.requests).toHaveLength(before)

  const removed = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "deletePet",
    arguments: { petId: 1 },
  })
  expect(removed.body.result?.isError ?? false, toolText(removed)).toBe(false)
  expect(toolText(removed)).toContain("no content")
  expect(lastRequest()).toMatchObject({ method: "DELETE", path: "/api/pets/1" })
})

test("a schema file can be uploaded, read-only, with the base URL typed in", async ({
  page,
}) => {
  await page.goto("/servers/endpoints/new")
  await page.getByLabel("Name", { exact: true }).fill(`${NAME} file`)
  await page.getByLabel("Upload a file").check()
  await page
    .getByLabel("Schema file")
    .setInputFiles(path.join(__dirname, "../fixtures/petstore.yaml"))
  await page.getByLabel("Base URL (optional)").fill(`${upstream.origin}/api`)
  await page.getByLabel("Read-only").check()
  await page.getByRole("button", { name: "Add endpoint" }).click()

  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await expect(page.getByText("Ready", { exact: true })).toBeVisible()
  // Only the two GET operations; the cookie one is left out.
  await expect(page.getByText("Tools (2)")).toBeVisible()
  await expect(page.locator("code", { hasText: "listPets" })).toBeVisible()
  await expect(page.locator("code", { hasText: "createPet" })).toHaveCount(0)
  // Nothing to download again: an uploaded schema is replaced, not re-read.
  await expect(
    page.getByRole("button", { name: "Re-read schema" }),
  ).toHaveCount(0)
})

test("a schema that cannot be read is refused and the form keeps what was typed", async ({
  page,
}) => {
  await page.goto("/servers/endpoints/new")
  await page.getByLabel("Name", { exact: true }).fill(`${NAME} broken`)
  await page.getByLabel("Schema URL").fill(`${upstream.origin}/missing.json`)
  await page.getByRole("button", { name: "Add endpoint" }).click()

  await expect(page.locator("p[role=alert]")).toContainText("HTTP 404")
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    `${NAME} broken`,
  )
  await expect(page.getByLabel("Schema URL")).toHaveValue(
    `${upstream.origin}/missing.json`,
  )

  // Nothing was added.
  await page.goto("/servers")
  await expect(page.getByText(`${NAME} broken`)).toHaveCount(0)
})

test("removing the endpoint takes its tools out of the gateway", async ({
  page,
  baseURL,
}) => {
  await page.goto(`/servers/${endpointId}`)
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: `Remove ${NAME}` }).click()
  await expect(page).toHaveURL(/\/servers$/)

  const gone = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "listPets",
    arguments: {},
  })
  expect(gone.body.result?.isError).toBe(true)
  expect(toolText(gone)).toContain(`No server called ${SLUG}`)
})
