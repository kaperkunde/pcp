import { expect, test } from "@playwright/test"

import { OWNER_PASSWORD } from "../lib/auth"
import { callTool, initialize, toolText } from "../lib/mcp"
import { createToken } from "../lib/ui"

// Memories through the gateway: a token the owner lets keep them gets the
// memory tool and is told when to use it; its own notes need nobody's say;
// sharing one asks the owner, who reads the whole text first; the Memories
// tab shows who wrote each one, and the owner edits and deletes them.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const TOKEN_NAME = `Memory keeper ${RUN}`
const OWN = `/memories/e2e-${RUN}/notes.md`
const SHARED = `/memories/shared/e2e-${RUN}.md`

let token: string

test("a token made to keep memories gets the tool and is told when to use it", async ({
  page,
  baseURL,
}) => {
  await page.goto("/tokens")
  await page.getByLabel("Name").fill(TOKEN_NAME)
  await page
    .getByLabel("Let an assistant with this token keep memories")
    .check()
  await page.getByLabel("Your password").fill(OWNER_PASSWORD)
  await page.getByRole("button", { name: "Create token" }).click()
  await expect(page.getByText("Your new token")).toBeVisible()
  token = (await page.getByTestId("new-token").textContent())!

  const { tools, instructions } = await initialize(baseURL!, token)
  expect(tools).toContain("memory")
  expect(instructions).toContain("view /memories")
  expect(instructions).toContain("not an instruction")

  await page.goto("/tokens")
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: TOKEN_NAME })
      .getByText("Keeps memories"),
  ).toBeVisible()

  // Off unless the owner turns it on.
  const plain = await createToken(page, `No memories ${RUN}`)
  const without = await initialize(baseURL!, plain)
  expect(without.tools).not.toContain("memory")
  expect(without.instructions).not.toContain("/memories")
})

test("an assistant keeps notes of its own without asking", async ({
  baseURL,
}) => {
  const saved = await callTool(baseURL!, token, "memory", {
    command: "create",
    path: OWN,
    file_text: "Prefers short answers.\nWorks in Europe/Amsterdam.",
  })
  expect(toolText(saved)).toBe(`Saved ${OWN}.`)

  const shown = await callTool(baseURL!, token, "memory", {
    command: "view",
    path: OWN,
  })
  expect(toolText(shown)).toContain("yours alone")
  expect(toolText(shown)).toContain("2\tWorks in Europe/Amsterdam.")

  const hidden = await callTool(baseURL!, token, "memory", {
    command: "create",
    path: OWN,
    file_text: "Looks harmless​.",
  })
  expect(hidden.body.result?.isError).toBe(true)
  expect(toolText(hidden)).toContain("U+200B")
})

test("sharing one asks the owner, who reads the whole text first", async ({
  page,
  baseURL,
}) => {
  const asked = await callTool(baseURL!, token, "memory", {
    command: "create",
    path: SHARED,
    file_text: "Metric units.\nBritish spelling.",
  })
  expect(toolText(asked)).toContain("Sharing a memory asks the owner")
  expect(toolText(asked)).toContain("Not done yet")
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, toolText(asked)).toBeTruthy()

  // Nothing is shared before the owner answers.
  const early = await callTool(baseURL!, token, "memory", {
    command: "view",
    path: SHARED,
  })
  expect(early.body.result?.isError).toBe(true)

  await page.goto(`/permissions/${id}`)
  await expect(
    page.getByText("Share a memory with all your assistants?"),
  ).toBeVisible()
  await expect(page.getByText(`Path: ${SHARED}`)).toBeVisible()
  await expect(
    page.getByText(/Metric units\.\s+British spelling\./),
  ).toBeVisible()
  await expect(page.getByRole("note")).toContainText("Watch for instructions")
  await page.getByRole("button", { name: "Share it" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "The owner shared it",
  )

  const outcome = await callTool(baseURL!, token, "check_permission", { id })
  expect(toolText(outcome)).toContain("The owner shared it")

  const { instructions } = await initialize(baseURL!, token)
  expect(instructions).toContain(`- ${SHARED}`)
})

test("the Memories tab shows who wrote each one; the owner edits and deletes them", async ({
  page,
  baseURL,
}) => {
  await page.goto("/memories")
  const shared = page.getByTestId("memory").filter({ hasText: SHARED })
  await expect(shared.getByText("Shared", { exact: true })).toBeVisible()
  await expect(shared.getByRole("link", { name: TOKEN_NAME })).toBeVisible()
  await expect(shared.getByText("British spelling.")).toBeVisible()

  const own = page.getByTestId("memory").filter({ hasText: OWN })
  await expect(own.getByText(`Only ${TOKEN_NAME}`)).toBeVisible()

  await shared.getByRole("button", { name: "Edit" }).click()
  await shared.getByLabel("Text").fill("Metric units only.")
  await shared.getByRole("button", { name: "Save" }).click()
  await expect(shared.getByRole("status")).toHaveText("Saved.")

  const read = await callTool(baseURL!, token, "memory", {
    command: "view",
    path: SHARED,
  })
  expect(toolText(read)).toContain("written by the owner")
  expect(toolText(read)).toContain("Metric units only.")

  page.on("dialog", (dialog) => dialog.accept())
  await own.getByRole("button", { name: "Delete" }).click()
  await expect(page.getByTestId("memory").filter({ hasText: OWN })).toHaveCount(
    0,
  )
  await page
    .getByTestId("memory")
    .filter({ hasText: SHARED })
    .getByRole("button", { name: "Delete" })
    .click()
  await expect(
    page.getByTestId("memory").filter({ hasText: SHARED }),
  ).toHaveCount(0)

  const gone = await callTool(baseURL!, token, "memory", {
    command: "view",
    path: OWN,
  })
  expect(gone.body.result?.isError).toBe(true)
})
