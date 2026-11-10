import { expect, test } from "@playwright/test"

import { callTool, initialize, toolText } from "../lib/mcp"
import { connectAssistant, permissionFrom, clickHydrated } from "../lib/ui"

// Skills: the owner writes one on the Skills page; an assistant is told
// about it, finds it with search and reads it with describe; its change to
// it waits for the owner, who reads what changes and the whole skill, and is
// written as the next version only once they agree; a second edit while it
// waits joins the same request. An assistant's own skill is written at once,
// and the owner sees it, marked with its token, and makes it shared.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const NAME = `e2e-${RUN}-postcards`
const TOKEN_NAME = `Skill reader ${RUN}`
const DESCRIPTION = `Send a postcard to a friend, the way the owner likes (${RUN}).`

let token: string

test("the owner writes a skill on the Skills page", async ({ page }) => {
  await page.goto("/skills")
  await clickHydrated(page.getByRole("button", { name: "Add a skill" }))
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
  expect(tools).toEqual(expect.arrayContaining(["search", "execute_read"]))
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

  // A second edit while the first waits joins it: one request, both changes.
  const folded = await callTool(baseURL!, token, "memory", {
    command: "str_replace",
    path: `/skills/${NAME}/SKILL.md`,
    old_str: "1. Ask who it is for.",
    new_str: "1. Ask who it is for, and where.",
  })
  expect(toolText(folded)).toContain(
    `Folded into the open request ${id} (now shows both changes)`,
  )

  await page.goto(path)
  await expect(page.getByText(`Change the skill ${NAME}?`)).toBeVisible()
  await expect(page.getByText("Version 1 → 2")).toBeVisible()
  await expect(page.getByTestId("skill-diff")).toContainText(
    "2. Write two lines, no more.",
  )
  await expect(page.getByTestId("skill-diff")).toContainText(
    "1. Ask who it is for, and where.",
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

test("a long skill's request fits a phone: nothing past the footer, nothing to the side", async ({
  page,
  baseURL,
}) => {
  // A diff taller than its box: each line's words for a screen reader once
  // stretched the page by the whole of it (#50).
  const name = `${NAME}-long`
  const steps = Array.from(
    { length: 120 },
    (_, at) => `${at + 1}. Step ${at + 1} of the long way round.`,
  ).join("\n")

  await page.goto("/skills")
  await clickHydrated(page.getByRole("button", { name: "Add a skill" }))
  const dialog = page.getByRole("dialog", { name: "Add a skill" })
  await dialog.getByLabel("Name").fill(name)
  await dialog.getByLabel("When to use it").fill(DESCRIPTION)
  await dialog.getByLabel("Steps").fill(steps)
  await dialog.getByRole("button", { name: "Save skill" }).click()
  await expect(page.getByRole("heading", { name })).toBeVisible()

  const asked = await callTool(baseURL!, token, "memory", {
    command: "str_replace",
    path: `/skills/${name}/SKILL.md`,
    old_str: "60. Step 60",
    new_str: "60. Step sixty",
  })
  const { path, id } = permissionFrom(toolText(asked))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(path)
  await expect(page.getByTestId("skill-diff")).toContainText("Step sixty")

  const size = await page.evaluate(() => {
    const footer = document
      .querySelector('nav[aria-label="Footer"]')!
      .closest("footer")!
    const root = document.documentElement
    return {
      scrollHeight: root.scrollHeight,
      footerBottom: footer.getBoundingClientRect().bottom + window.scrollY,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
    }
  })
  expect(size.scrollHeight).toBeLessThanOrEqual(
    Math.ceil(size.footerBottom) + 2,
  )
  expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth)

  await callTool(baseURL!, token, "withdraw_request", { id })
})

test("an assistant keeps a skill of its own, which the owner sees and shares", async ({
  page,
  baseURL,
}) => {
  const own = `e2e-${RUN}-diary`
  const saved = await callTool(baseURL!, token, "memory", {
    command: "create",
    path: `/skills/mine/${own}/SKILL.md`,
    file_text: `---\nname: ${own}\ndescription: Keep a diary of the day (${RUN}).\n---\n\n1. Write what was done.\n`,
  })
  // Written at once: no request.
  expect(toolText(saved)).toContain(`Saved /skills/mine/${own}/SKILL.md`)
  expect(toolText(saved)).not.toContain("Not done yet")
  const described = await callTool(baseURL!, token, "describe", {
    ref: `skill:mine/${own}`,
  })
  expect(toolText(described)).toContain("Your own skill")

  await page.goto("/skills")
  const row = page.getByRole("link", { name: new RegExp(own) })
  await expect(row).toContainText(`${TOKEN_NAME}'s own`)
  await row.click()
  await expect(page.getByRole("heading", { name: own })).toBeVisible()
  page.once("dialog", (dialog) => void dialog.accept())
  await clickHydrated(page.getByRole("button", { name: "Make shared" }))
  await expect(page.getByRole("button", { name: "Make shared" })).toBeHidden()

  const shared = await callTool(baseURL!, token, "describe", {
    ref: `skill:${own}`,
  })
  expect(toolText(shared)).toContain("A procedure the owner approved")
})
