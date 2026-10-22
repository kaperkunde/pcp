import { expect, test } from "@playwright/test"

import { callTool, initialize, toolText } from "../lib/mcp"
import { connectAssistant, permissionFrom } from "../lib/ui"

// Skills: the owner writes one on the Skills page; an assistant is told
// about it, finds it with search and reads it with describe; its change to
// it waits for the owner, who reads what changes and the whole skill, and is
// written as the next version only once they agree.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const NAME = `e2e-${RUN}-postcards`
const TOKEN_NAME = `Skill reader ${RUN}`
const DESCRIPTION = `Send a postcard to a friend, the way the owner likes (${RUN}).`

let token: string

test("the owner writes a skill on the Skills page", async ({ page }) => {
  await page.goto("/skills")
  await page.getByRole("button", { name: "Add a skill" }).click()
  const dialog = page.getByRole("dialog", { name: "Add a skill" })
  await dialog.getByLabel("Name").fill(NAME)
  await dialog.getByLabel("When to use it").fill(DESCRIPTION)
  await dialog
    .getByLabel("Steps")
    .fill("1. Ask who it is for.\n2. Write three lines, no more.")
  await dialog.getByRole("button", { name: "Save skill" }).click()

  await expect(page.getByRole("heading", { name: NAME })).toBeVisible()
  await expect(page.getByText(/Version 1 · written by you/)).toBeVisible()

  await page.goto("/skills")
  await expect(
    page.getByRole("link", { name: new RegExp(NAME) }),
  ).toContainText("Version 1")
})

test("an assistant is told about it, finds it with search and reads it with describe", async ({
  page,
  baseURL,
}) => {
  token = (await connectAssistant(page, TOKEN_NAME, { keepMemories: true }))
    .token

  const { tools, instructions } = await initialize(baseURL!, token)
  expect(tools).toEqual(expect.arrayContaining(["search", "describe"]))
  expect(instructions).toContain(`- skill:${NAME}: ${DESCRIPTION}`)
  expect(instructions).toContain("procedures the owner approved")

  const found = await callTool(baseURL!, token, "search", {
    query: `postcard friend ${RUN}`,
    kind: "skill",
  })
  expect(toolText(found)).toContain(`skill skill:${NAME} — ${DESCRIPTION}`)

  const described = await callTool(baseURL!, token, "describe", {
    ref: `skill:${NAME}`,
  })
  expect(toolText(described)).toContain(
    "A procedure the owner approved: follow it when the task matches.",
  )
  expect(toolText(described)).toContain("2. Write three lines, no more.")
  expect(toolText(described)).toContain("version: 1")
})

test("its change asks the owner, who reads what changes and allows it", async ({
  page,
  baseURL,
}) => {
  const asked = await callTool(baseURL!, token, "memory", {
    command: "str_replace",
    path: `/skills/${NAME}/SKILL.md`,
    old_str: "three lines",
    new_str: "two lines",
  })
  expect(toolText(asked)).toContain("Changing a skill asks the owner")
  expect(toolText(asked)).toContain("Not done yet")
  const { path, id } = permissionFrom(toolText(asked))

  // Nothing is written before the owner answers.
  const early = await callTool(baseURL!, token, "describe", {
    ref: `skill:${NAME}`,
  })
  expect(toolText(early)).toContain("three lines")

  await page.goto(path)
  await expect(page.getByText(`Change the skill ${NAME}?`)).toBeVisible()
  await expect(page.getByText("Version 1 → 2")).toBeVisible()
  await expect(page.getByTestId("skill-diff")).toContainText(
    "2. Write two lines, no more.",
  )
  await expect(page.getByTestId("skill-text")).toContainText("version: 2")
  await page.getByRole("button", { name: "Allow the change" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "saved as version 2",
  )

  const outcome = await callTool(baseURL!, token, "check_permission", { id })
  expect(toolText(outcome)).toContain("saved as version 2")
  const after = await callTool(baseURL!, token, "describe", {
    ref: `skill:${NAME}`,
  })
  expect(toolText(after)).toContain("2. Write two lines, no more.")

  await page.goto("/skills")
  await expect(
    page.getByRole("link", { name: new RegExp(NAME) }),
  ).toContainText("Version 2")
})
