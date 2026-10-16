import { expect, test } from "@playwright/test"

import { callTool, initialize, toolText } from "../lib/mcp"
import { connectAssistant, createToken } from "../lib/ui"

// File links: a token the owner lets move files by link gets share_result
// and receive_file and is told how (a token without it gets neither); a
// file sent to a receive_file link with a plain PUT becomes a kept result
// of the token's, and a share_result link downloads it again as a file,
// with its name, a few times and then no more. What the browser does with
// such a file is covered by lib/core/browser's unit tests.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const TOKEN_NAME = `File mover ${RUN}`
const PLAIN_TOKEN_NAME = `No file links ${RUN}`
const NOTE = `A note sent by link, ${RUN}.`

let token: string

test("a token made to move files by link gets the tools, and no other", async ({
  page,
  baseURL,
}) => {
  const plain = await createToken(page, PLAIN_TOKEN_NAME)
  const without = await initialize(baseURL!, plain)
  expect(without.tools).not.toContain("share_result")
  expect(without.tools).not.toContain("receive_file")

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
