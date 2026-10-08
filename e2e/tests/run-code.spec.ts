import { expect, test } from "@playwright/test"

import { PICTURE_PNG, startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, initialize, toolText } from "../lib/mcp"
import {
  allowAllTools,
  connectAssistant,
  createToken,
  expectLevel,
  setToolLevel,
  showTools,
} from "../lib/ui"

// run_code through the gateway: a token the owner lets run code gets the
// tool and is told how (a token without it gets neither); a program calls
// the token's tools with the server's secret added by PCP, filters what they
// answer and moves a picture from one tool to another by its handle, so the
// answer holds neither; a blocked tool is an error the program catches; a
// tool that asks the owner stops the program at that call with the usual
// link, and once the owner chooses Always allow the program runs through.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const SERVER_NAME = `Code postcards ${RUN}`
const SLUG = `code-${RUN}`
const TOKEN_NAME = `Programmer ${RUN}`
const PLAIN_TOKEN_NAME = `No programs ${RUN}`

let upstream: Upstream
let token: string

test.beforeAll(async () => {
  upstream = await startUpstream()
  upstream.lateTools.add("picture")
  upstream.lateTools.add("measure")
})

test.afterAll(async () => {
  await upstream?.close()
})

function callsOf(tool: string) {
  return upstream.calls.filter((call) => call.tool === tool)
}

async function run(baseURL: string, code: string) {
  return toolText(await callTool(baseURL, token, "run_code", { code }))
}

function returned(text: string): unknown {
  return JSON.parse(text.split("It returned:\n")[1]!)
}

test("a token made to run code gets run_code and is told how, and no other", async ({
  page,
  baseURL,
}) => {
  await page.goto("/servers/new")
  await page.getByLabel("Name").fill(SERVER_NAME)
  await page.getByLabel("Server URL").fill(upstream.mcpUrl)
  await page.getByLabel("Authentication").selectOption("header")
  await page
    .getByLabel("Secret", { exact: true })
    .selectOption({ label: "A new secret, entered here" })
  await page.getByLabel("New secret's value").fill(upstream.expectedToken)
  await page.getByLabel("Save it as (optional)").fill(`Code key ${RUN}`)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByText("Tools (5)")).toBeVisible()
  await page.getByLabel("Short name").fill(SLUG)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()

  ;({ token } = await connectAssistant(page, TOKEN_NAME, { runCode: true }))
  await expect(page.getByRole("switch", { name: /^Run code/ })).toBeChecked()

  const told = await initialize(baseURL!, token)
  expect(told.tools).toContain("run_code")
  expect(told.instructions).toContain("run_code")

  const plain = await initialize(
    baseURL!,
    await createToken(page, PLAIN_TOKEN_NAME),
  )
  expect(plain.tools).not.toContain("run_code")
  expect(plain.instructions).not.toContain("run_code")
})

test("a program calls the token's tools and hands back only what it kept", async ({
  page,
  baseURL,
}) => {
  await allowAllTools(page, TOKEN_NAME, SLUG)
  for (const [tool, level] of [
    ["send_postcard", "ask"],
    ["echo_auth", "blocked"],
  ] as const) {
    await setToolLevel(page, SLUG, tool, level)
  }
  await page.reload()
  await showTools(page, SLUG)
  await expectLevel(page, `Access to ${SLUG}/echo_auth`, "blocked")

  const text = await run(
    baseURL!,
    `
    let sum = 0
    for (let i = 1; i <= 5; i++) {
      sum = Number(await pcp.call("${SLUG}", "add_numbers", { a: sum, b: i }))
    }
    const picture = await pcp.call("${SLUG}", "picture")
    const measured = await pcp.call("${SLUG}", "measure", { text: picture.data })
    let blocked
    try { await pcp.call("${SLUG}", "echo_auth") } catch (error) { blocked = error.message }
    console.log(picture.caption)
    return { sum, measured, type: picture.data.type, blocked }
  `,
  )

  expect(text).toContain("The program finished in")
  expect(text).toContain("8 calls")
  expect(text).toContain("It printed:\nA small dot, drawn for the test.")
  expect(returned(text)).toEqual({
    sum: 15,
    // The handle stood for the picture, as base64, in measure's arguments.
    measured: {
      length: PICTURE_PNG.toString("base64").length,
      startsWith: PICTURE_PNG.toString("base64").slice(0, 12),
    },
    type: "image/png",
    blocked: `The owner has blocked ${SLUG}/echo_auth for this token.`,
  })
  expect(text).not.toContain(PICTURE_PNG.toString("base64").slice(0, 40))

  expect(callsOf("add_numbers")).toHaveLength(5)
  expect(callsOf("echo_auth")).toHaveLength(0)
  for (const call of upstream.calls) {
    expect(call.authorization).toBe(`Bearer ${upstream.expectedToken}`)
  }
})

test("a tool that asks the owner stops the program until they allow it", async ({
  page,
  baseURL,
}) => {
  const program = `
    const sum = await pcp.call("${SLUG}", "add_numbers", { a: 2, b: 3 })
    const sent = await pcp.call("${SLUG}", "send_postcard", { to: "Grace", message: "Sum: " + sum })
    return sent
  `
  const before = callsOf("add_numbers").length

  const stopped = await run(baseURL!, program)
  expect(stopped).toContain(`stopped at ${SLUG}/send_postcard`)
  expect(stopped).toContain("Not done yet")
  const path = stopped.match(/\/permissions\/[\w-]+/)?.[0]
  expect(path, stopped).toBeTruthy()
  expect(stopped.trimEnd().endsWith(path!)).toBe(true)
  expect(callsOf("add_numbers")).toHaveLength(before + 1)
  expect(callsOf("send_postcard")).toHaveLength(0)

  await page.goto(path!)
  await expect(page.getByText("send_postcard").first()).toBeVisible()
  await page.getByRole("button", { name: "Always allow" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "Sent to Grace: Sum: 5",
  )
  expect(callsOf("send_postcard")).toHaveLength(1)

  const ran = await run(baseURL!, program)
  expect(returned(ran)).toBe("Sent to Grace: Sum: 5")
  expect(callsOf("send_postcard")).toHaveLength(2)
})
