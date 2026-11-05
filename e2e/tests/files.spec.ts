import fs from "node:fs"

import { expect, test } from "@playwright/test"

// The Files section: every store listed, PCP's own first; PCP's own store
// browsed, files uploaded (picked and dropped), previewed (text and an
// image), read in a range, downloaded and deleted. PCP's own store needs no
// setup: it is in PCP's data folder, encrypted.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const FOLDER = `e2e-${RUN}`
const TEXT = `notes from the files page ${RUN}\nsecond line\n`

// A 1×1 PNG.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
)

let storeUrl: string

test("Files lists PCP's own store first, with its mode and size", async ({
  page,
}) => {
  await page.goto("/home")
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Files" })
    .click()
  await expect(page).toHaveURL(/\/files$/)

  const stores = page.getByTestId("stores")
  const own = stores.getByRole("listitem").first()
  await expect(own).toContainText("PCP files")
  await expect(own).toContainText("This machine")
  await expect(own).toContainText("Encrypted")
  await expect(own).toContainText(/ of /)
  await expect(page.getByText("not its files")).toBeVisible()

  await own.getByRole("link").click()
  await expect(page).toHaveURL(/\/files\/[\w-]+$/)
  storeUrl = new URL(page.url()).pathname
  await expect(page.getByRole("heading", { name: "PCP files" })).toBeVisible()
})

test("a folder is made, files uploaded and dropped into it", async ({
  page,
}) => {
  await page.goto(storeUrl)
  const entries = page.getByTestId("storage-entries")

  await page.getByLabel("New folder's name").fill(FOLDER)
  await page.getByRole("button", { name: "New folder" }).click()
  await entries.getByRole("link", { name: FOLDER }).click()
  await expect(
    page.getByRole("navigation", { name: "Folder" }).getByText(FOLDER),
  ).toBeVisible()
  await expect(entries).toContainText("Nothing here yet.")

  await page.getByLabel("Files to upload").setInputFiles([
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(TEXT) },
    { name: "pixel.png", mimeType: "image/png", buffer: PIXEL },
  ])
  // Exact: the file field ("Files to upload") is a button by role too.
  await page.getByRole("button", { name: "Upload", exact: true }).click()
  await expect(entries).toContainText("notes.txt")
  await expect(entries).toContainText("pixel.png")

  const dropped = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(
      new File(["dropped on the page"], "dropped.txt", { type: "text/plain" }),
    )
    return transfer
  })
  await page
    .getByTestId("storage-browser")
    .dispatchEvent("dragover", { dataTransfer: dropped })
  await page
    .getByTestId("storage-browser")
    .dispatchEvent("drop", { dataTransfer: dropped })
  await expect(entries).toContainText("dropped.txt")
})

test("a text file and an image are previewed, and a file read in a range", async ({
  page,
}) => {
  await page.goto(`${storeUrl}?path=${encodeURIComponent(FOLDER)}`)

  await page.getByRole("button", { name: "Preview notes.txt" }).click()
  const preview = page.getByTestId("file-preview")
  await expect(preview.getByTestId("file-preview-text")).toHaveText(TEXT)
  await preview.getByRole("button", { name: "Close" }).click()
  await expect(preview).toBeHidden()

  await page.getByRole("button", { name: "Preview pixel.png" }).click()
  const image = preview.getByRole("img", { name: "Preview of pixel.png" })
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1)
  await preview.getByRole("button", { name: "Close" }).click()

  // From PCP's own page, a range is served as a part; from anywhere else
  // (no Sec-Fetch-Site, no Origin) the route refuses.
  const url = `/api/storage/${storeUrl.split("/").at(-1)}/download?${new URLSearchParams({ path: `${FOLDER}/notes.txt`, inline: "1" })}`
  const part = await page.evaluate(async (address) => {
    const response = await fetch(address, { headers: { Range: "bytes=0-4" } })
    return {
      status: response.status,
      range: response.headers.get("content-range"),
      type: response.headers.get("content-type"),
      csp: response.headers.get("content-security-policy"),
      text: await response.text(),
    }
  }, url)
  expect(part).toEqual({
    status: 206,
    range: `bytes 0-4/${Buffer.byteLength(TEXT)}`,
    type: "text/plain; charset=utf-8",
    csp: expect.stringContaining("sandbox"),
    text: TEXT.slice(0, 5),
  })
  expect((await page.request.get(url)).status()).toBe(403)
})

test("a file is downloaded and deleted", async ({ page }) => {
  await page.goto(`${storeUrl}?path=${encodeURIComponent(FOLDER)}`)
  const entries = page.getByTestId("storage-entries")

  const waiting = page.waitForEvent("download")
  await page.getByRole("link", { name: "Download notes.txt" }).click()
  const download = await waiting
  expect(download.suggestedFilename()).toBe("notes.txt")
  expect(fs.readFileSync((await download.path())!, "utf8")).toBe(TEXT)

  page.once("dialog", (dialog) => void dialog.accept())
  await entries
    .getByRole("listitem")
    .filter({ hasText: "notes.txt" })
    .getByRole("button", { name: "Delete" })
    .click()
  await expect(entries).not.toContainText("notes.txt")
  await expect(entries).toContainText("pixel.png")
})
