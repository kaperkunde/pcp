import { expect, test } from "@playwright/test"

import { callTool, initialize, toolText } from "../lib/mcp"
import { connectAssistant } from "../lib/ui"

// File links: a token the owner lets move files by link gets share_result
// and receive_file and is told how; a
// file sent to a receive_file link with a plain PUT becomes a kept result
// of the token's, and a share_result link downloads it again as a file,
// with its name, a few times and then no more. An upload link opens a page
// the owner sends files from without signing in, and check_upload hands
// the token their handles. What the browser does with such a file is
// covered by lib/core/browser's unit tests.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const TOKEN_NAME = `File mover ${RUN}`
const NOTE = `A note sent by link, ${RUN}.`

let token: string

test("a token made to move files by link gets the tools", async ({
  page,
  baseURL,
}) => {
  // A token without the switch gets neither: lib/core/file-links.test.ts.
  ;({ token } = await connectAssistant(page, TOKEN_NAME, { shareFiles: true }))
  await expect(
    page.getByRole("switch", { name: /^Move files by link/ }),
  ).toBeChecked()

  const { tools, instructions } = await initialize(baseURL!, token)
  expect(tools).toEqual(
    expect.arrayContaining(["share_result", "receive_file"]),
  )
  expect(instructions).toContain("receive_file")

  await page.goto("/tokens")
  await expect(
    page.getByRole("link", { name: new RegExp(TOKEN_NAME) }),
  ).toContainText("Moves files by link")
})

test("a file sent to a link comes back by another, as a file", async ({
  request,
  baseURL,
}) => {
  const receive = JSON.parse(
    toolText(
      await callTool(baseURL!, token, "receive_file", { name: "note.txt" }),
    ),
  ) as { url: string; result: { $result: string } }
  expect(receive.url).toMatch(/\/api\/files\/[\w-]{43}$/)

  const sent = await request.put(receive.url, { data: NOTE })
  expect(sent.status()).toBe(201)
  expect(await sent.json()).toMatchObject({
    received: NOTE.length,
    result: {
      $result: receive.result.$result,
      name: "note.txt",
      type: "text/plain; charset=utf-8",
    },
  })
  expect((await request.put(receive.url, { data: NOTE })).status()).toBe(409)

  const shared = JSON.parse(
    toolText(
      await callTool(baseURL!, token, "share_result", {
        id: receive.result.$result,
      }),
    ),
  ) as { url: string; downloads: number; curl: string }
  expect(shared.curl).toBe(`curl -fsSL -o note.txt ${shared.url}`)

  for (let use = 0; use < shared.downloads; use++) {
    const file = await request.get(shared.url)
    expect(file.status()).toBe(200)
    expect(await file.text()).toBe(NOTE)
    expect(file.headers()["content-disposition"]).toBe(
      'attachment; filename="note.txt"',
    )
    expect(file.headers()["content-type"]).toBe("text/plain; charset=utf-8")
    expect(file.headers()["cache-control"]).toBe("no-store")
  }

  expect((await request.get(shared.url)).status()).toBe(410)
  expect(
    (
      await request.get(shared.url.replace(/[\w-]{43}$/, "x".repeat(43)))
    ).status(),
  ).toBe(404)
})

test("the owner uploads files on the page an upload link opens, without signing in", async ({
  browser,
  request,
  baseURL,
}) => {
  const made = await callTool(baseURL!, token, "create_upload_link", {
    purpose: `Receipts for March ${RUN}`,
    max_files: 3,
  })
  const owner = made.body.result?.structuredContent as unknown as {
    kind: string
    reason: string
    url: string
    upload: { id: string }
  }
  expect(owner).toMatchObject({ kind: "needs_owner", reason: "upload" })
  expect(owner.url).toMatch(/\/upload\/[\w-]{43}$/)
  // Handed over as a markdown link, last.
  expect(toolText(made).trimEnd().split("\n").at(-1)).toBe(
    `[Upload files](${owner.url})`,
  )

  // A context of its own: the owner's phone, not signed in to PCP.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
  })
  const page = await phone.newPage()
  await page.goto(owner.url)
  await expect(
    page.getByRole("heading", { name: "Upload files" }),
  ).toBeVisible()
  await expect(page.getByText(`Receipts for March ${RUN}`)).toBeVisible()
  await expect(page.getByText(TOKEN_NAME)).toBeVisible()

  await page.getByLabel("Choose files").setInputFiles([
    { name: "März.txt", mimeType: "text/plain", buffer: Buffer.from(NOTE) },
    {
      name: "receipt.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n% receipt\n"),
    },
  ])
  const files = page.getByRole("list", { name: "Files" })
  await expect(files.getByRole("listitem")).toHaveCount(2)
  await expect(files.getByText(/^Sent/)).toHaveCount(2)

  await page.getByRole("button", { name: "Done" }).click()
  await expect(page.getByText(/^Done\. Tell the assistant/)).toBeVisible()
  // Nothing scrolls sideways on a phone.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  await phone.close()

  const checked = await callTool(baseURL!, token, "check_upload", {
    id: owner.upload.id,
  })
  const status = checked.body.result?.structuredContent as unknown as {
    open: boolean
    files: Array<{ handle: { $result: string }; name: string; type: string }>
    message: string
  }
  expect(status.open).toBe(false)
  expect(status.files.map((file) => file.name)).toEqual([
    "März.txt",
    "receipt.pdf",
  ])
  expect(status.message).toContain(status.files[0]!.handle.$result)

  // Each handle is the token's file: share_result downloads it again.
  const shared = JSON.parse(
    toolText(
      await callTool(baseURL!, token, "share_result", {
        id: status.files[0]!.handle.$result,
      }),
    ),
  ) as { url: string }
  expect(await (await request.get(shared.url)).text()).toBe(NOTE)

  // Closed: another file is refused, and the page says so.
  const secret = owner.url.split("/").pop()!
  expect(
    (
      await request.put(`/api/files/${secret}`, {
        data: NOTE,
        headers: { "X-File-Name": "late.txt" },
      })
    ).status(),
  ).toBe(410)
})
