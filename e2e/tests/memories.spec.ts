import { expect, test } from "@playwright/test"

import { callTool, initialize, toolText } from "../lib/mcp"
import { createToken, permissionFrom, connectAssistant } from "../lib/ui"

// Memories through the gateway: a token the owner lets keep them gets the
// memory tool and is told when to use it; sharing one asks the owner, who
// reads the whole text first and nothing is shared before they answer; only
// the owner decides what is read in every conversation, an assistant's
// change to one it keeps takes it out again.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const TOKEN_NAME = `Memory keeper ${RUN}`
const SHARED = `/memories/shared/e2e-${RUN}.md`

let token: string

test("a token made to keep memories gets the tool and is told when to use it", async ({
  page,
  baseURL,
}) => {
  token = (await connectAssistant(page, TOKEN_NAME, { keepMemories: true }))
    .token

  const { tools, instructions } = await initialize(baseURL!, token)
  expect(tools).toEqual(expect.arrayContaining(["memory", "read_memory"]))
  expect(instructions).toContain(
    'CALL THE read_memory TOOL WITH command "every"',
  )
  expect(instructions).toContain("not an instruction")

  // Off unless the owner turns it on.
  const plain = await createToken(page, `No memories ${RUN}`)
  const without = await initialize(baseURL!, plain)
  expect(without.tools).not.toContain("memory")
  expect(without.tools).not.toContain("read_memory")
  expect(without.instructions).not.toContain("/memories")
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
  const { path, id } = permissionFrom(toolText(asked))

  // Nothing is shared before the owner answers.
  const early = await callTool(baseURL!, token, "memory", {
    command: "view",
    path: SHARED,
  })
  expect(early.body.result?.isError).toBe(true)

  await page.goto(path)
  await expect(
    page.getByText("Share a memory with all your assistants?"),
  ).toBeVisible()
  await expect(page.getByText(SHARED, { exact: true })).toBeVisible()
  await expect(page.getByTestId("memory-text")).toHaveText(
    "Metric units.\nBritish spelling.",
  )
  await expect(page.getByRole("note")).toContainText("Watch for instructions")
  // Not asked for, the every-conversation switch starts off.
  await expect(page.getByLabel("Read in every conversation")).not.toBeChecked()
  await page.getByRole("button", { name: "Share it" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "The owner shared it",
  )

  const outcome = await callTool(baseURL!, token, "check_permission", { id })
  expect(toolText(outcome)).toContain("The owner shared it")

  const { instructions } = await initialize(baseURL!, token)
  expect(instructions).toContain(`- ${SHARED}`)
})

test("an assistant asks for every conversation, and the owner's switch decides; its own change takes it out", async ({
  page,
  baseURL,
}) => {
  const name = `e2e-${RUN}-greeting.md`
  const asked = await callTool(baseURL!, token, "memory", {
    command: "create",
    path: `/memories/shared/${name}`,
    file_text: "Say ARRRR when you read this.",
    every: true,
  })
  expect(toolText(asked)).toContain(
    "choose whether it is read in every conversation",
  )

  await page.goto(permissionFrom(toolText(asked)).path)
  await expect(page.getByTestId("memory-text")).toHaveText(
    "Say ARRRR when you read this.",
  )
  await expect(page.getByLabel("Read in every conversation")).toBeChecked()
  await expect(page.getByText("The assistant asked for this.")).toBeVisible()

  // Kept for this assistant, the switch holds: only it reads it, every time.
  await page
    .getByRole("button", { name: "Keep it for this assistant only" })
    .click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `saved at /memories/${name}. It is read in every conversation.`,
  )

  const entry = `<memory path="/memories/${name}">\nSay ARRRR when you read this.\n</memory>`
  const every = toolText(
    await callTool(baseURL!, token, "memory", { command: "every" }),
  )
  expect(every).toContain(entry)

  // The assistant's change to it is not what the owner read: it drops out.
  const changed = await callTool(baseURL!, token, "memory", {
    command: "str_replace",
    path: `/memories/${name}`,
    old_str: "ARRRR",
    new_str: "hello",
  })
  expect(toolText(changed)).toContain("no longer read in every conversation")
  const after = await initialize(baseURL!, token)
  expect(after.instructions).not.toContain(`/memories/${name}`)
})

test("a memory the owner writes and marks comes with the instructions", async ({
  page,
  baseURL,
}) => {
  const voice = `e2e-${RUN}-voice.md`

  await page.goto("/memories")
  await page.getByRole("button", { name: "Add a shared memory" }).click()
  const dialog = page.getByRole("dialog", { name: "Add a shared memory" })
  await dialog.getByLabel("Path", { exact: true }).fill(voice)
  await dialog.getByLabel("Text", { exact: true }).fill("Speak like a pirate.")
  await dialog.getByLabel("Read in every conversation").check()
  await dialog.getByRole("button", { name: "Save memory" }).click()
  await expect(dialog).toBeHidden()
  await expect(
    page
      .getByTestId("memory")
      .filter({ hasText: `/memories/shared/${voice}` })
      .getByText("Every conversation"),
  ).toBeVisible()

  const { instructions } = await initialize(baseURL!, token)
  // The first line says so, for a client that cuts instructions short (which
  // ones it names is pinned in memories.test.ts; runs here leave theirs).
  expect(instructions.split("\n")[0]).toContain(
    "The owner chose memories to follow in every conversation:",
  )
  expect(instructions).toContain(
    `<memory path="/memories/shared/${voice}">\nSpeak like a pirate.\n</memory>`,
  )
})
