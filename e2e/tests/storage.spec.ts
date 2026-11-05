import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { expect, test } from "@playwright/test"

import { startFakeSsh, type FakeSsh } from "../../lib/core/ssh/fake-server"
import { callTool, toolText } from "../lib/mcp"
import { createToken, openMoreOptions } from "../lib/ui"

// A storage folder on an SSH server: added on the server's page, browsed
// and changed in its file browser, and used by an assistant through /mcp.
// The test SSH server runs in this process and answers SFTP on this
// machine's own file system, in a temporary folder.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const HOST = `Files box ${RUN}`
const FOLDER = `Scans ${RUN}`
const SLUG = `scans-${RUN}`

let fake: FakeSsh
let authorized: string | null = null
let base: string
let top: string

test.beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pcp-e2e-")))
  top = path.join(base, "share")
  fs.mkdirSync(top)
  fs.writeFileSync(path.join(top, "hello.txt"), "hello from the share")
  fs.mkdirSync(path.join(base, "private"))
  fs.symlinkSync(path.join(base, "private"), path.join(top, "escape"))
  fake = await startFakeSsh({
    authorizedKey: () => authorized,
    run: () => ({}),
    sftp: true,
  })
})

test.afterAll(async () => {
  await fake?.close()
  fs.rmSync(base, { recursive: true, force: true })
})

test("a folder is added on its SSH server's page and browsed there", async ({
  page,
}) => {
  await page.goto("/servers/ssh/new")
  await page.getByLabel("Name", { exact: true }).fill(HOST)
  await page.getByLabel("Host", { exact: true }).fill("127.0.0.1")
  await page.getByLabel("Login").fill("deploy")
  await openMoreOptions(page)
  await page.getByLabel("Port").fill(String(fake.port))
  await page.getByRole("button", { name: "Add SSH server" }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  authorized = (await page.getByTestId("ssh-public-key").textContent())!
  await page.getByRole("button", { name: "Check sign-in" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "PCP signed in." }),
  ).toBeVisible()

  await page
    .getByTestId("ssh-storage")
    .getByRole("link", { name: "Add a folder" })
    .click()
  // The SSH server's page has Name fields of its own (the server, an exit):
  // fill in the folder's once its page is open.
  await expect(page).toHaveURL(/\/servers\/storage\/new\?/)
  await page.getByLabel("Name", { exact: true }).fill(FOLDER)
  await page.getByLabel("Folder", { exact: true }).fill(top)
  await page.getByRole("button", { name: "Add folder" }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await expect(page.getByTestId("storage-folder")).toContainText(top)

  await page.getByRole("link", { name: "Browse files" }).click()
  const entries = page.getByTestId("storage-entries")
  await expect(entries).toContainText("hello.txt")
  await expect(entries).toContainText("A link out of the folder")

  await page.getByLabel("New folder's name").fill("2026")
  await page.getByRole("button", { name: "New folder" }).click()
  await expect(entries.getByRole("link", { name: "2026" })).toBeVisible()
  expect(fs.statSync(path.join(top, "2026")).isDirectory()).toBe(true)

  await page.getByLabel("Files to upload").setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded"),
  })
  // Exact: the file field ("Files to upload") is a button by role too.
  await page.getByRole("button", { name: "Upload", exact: true }).click()
  await expect(entries).toContainText("note.txt")
  expect(fs.readFileSync(path.join(top, "note.txt"), "utf8")).toBe("uploaded")

  page.once("dialog", (dialog) => void dialog.accept())
  await entries
    .getByRole("listitem")
    .filter({ hasText: "note.txt" })
    .getByRole("button", { name: "Delete" })
    .click()
  await expect(entries).not.toContainText("note.txt")
})

test("an assistant saves a file once the owner allows it, inside the folder only", async ({
  page,
  baseURL,
}) => {
  const token = await createToken(page, `Storage assistant ${RUN}`)
  const args = {
    server: SLUG,
    tool: "save_file",
    arguments: { path: "2026/from-assistant.txt", text: "saved" },
  }

  const asked = await callTool(baseURL!, token, "call_tool_write", args)
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, toolText(asked)).toBeTruthy()
  expect(fs.existsSync(path.join(top, "2026", "from-assistant.txt"))).toBe(
    false,
  )

  await page.goto(`/permissions/${id}`)
  await page.getByRole("button", { name: "Always allow" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText("created")
  expect(
    fs.readFileSync(path.join(top, "2026", "from-assistant.txt"), "utf8"),
  ).toBe("saved")

  const escaped = await callTool(baseURL!, token, "call_tool_write", {
    ...args,
    arguments: { path: "escape/stolen.txt", text: "x" },
  })
  expect(toolText(escaped)).toMatch(/leads out of the folder/)
  expect(fs.readdirSync(path.join(base, "private"))).toEqual([])
})
