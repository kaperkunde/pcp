import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"

import type { McpServer } from "@/lib/generated/prisma/client"

import { createApiToken, resolveApiToken } from "../api-tokens"
import { grantSecretUse } from "../browser-secrets"
import type { VaultContext } from "../context"
import { db } from "../db"
import { startTestApi, type TestApi } from "../openapi/test-api"
import { logDays, readRequestLog, withLogNote } from "../request-log"
import { createSecret } from "../secrets"
import { scratchDatabase } from "../test-db"
import { callServerTool } from "../upstream"
import { setupVault } from "../vault"
import { setFetchPrivate, setFetchSite } from "../web-fetch"
import { chromiumExecutable } from "./executable"
import { closeAllBrowsers, runningBrowser } from "./runtime"
import { createBrowserServer } from "./server"
import { isOwnerNeeded, type BrowserAsk } from "./types"

// Typing the owner's secrets into pages, against a real headless Chromium
// and pages served on this machine, through upstream.ts as every call comes
// (call_tool, run_code, a wrapper, the owner's answer): the gate per secret,
// site and token, the field and its frame checked at the moment of typing,
// and the value kept out of every answer, the snapshot, read_page and
// screenshots. Skipped where no Chromium is installed.

const executable = await chromiumExecutable()
const PUBLIC_URL = "http://pcp.test"
const VALUE = "hunter2-very-secret"
// "12345678901234567890" in base32: RFC 6238's seed.
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

const LOGIN = `<!doctype html><title>Sign in</title>
<label>Email <input id="email"></label>
<label>Password <input type="password" id="pw"></label>
<label>Code <input id="code" inputmode="numeric"></label>
<button onclick="document.title = 'Sent'">Sign in</button>`

/** A field whose value the page repeats where everybody sees it, and in its title. */
const MIRROR = `<!doctype html><title>Mirror</title>
<label>Token <input id="token" oninput="document.getElementById('said').textContent = 'You typed ' + this.value; document.title = 'Got ' + this.value"></label>
<p id="said">Nothing yet</p>`

let cleanup: () => Promise<void>
let site: TestApi
/** Another site, whose page the login page frames. */
let framed: TestApi
let ctx: VaultContext
let tokenId: string
let server: McpServer
let secretId: string

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({ name: "Ada", password: "correct horse battery" })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  })
  tokenId = (await resolveApiToken(token))!.tokenId
  server = await db().mcpServer.findUniqueOrThrow({
    where: { id: (await createBrowserServer(ctx)).id },
  })
  ;({ id: secretId } = await createSecret(ctx, {
    name: "Shop password",
    value: VALUE,
  }))
  framed = await startTestApi((_, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8")
    res.end(
      `<!doctype html><title>Inner</title><label>Inner password <input type="password"></label>`,
    )
  })
  site = await startTestApi((request, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8")

    if (request.url.startsWith("/login")) {
      return res.end(LOGIN)
    }

    if (request.url.startsWith("/framed")) {
      return res.end(
        `<!doctype html><title>Framed</title><h1>Framed</h1><iframe src="${framed.origin}/inner"></iframe>`,
      )
    }

    if (request.url.startsWith("/mirror")) {
      return res.end(MIRROR)
    }

    res.end("<title>Elsewhere</title><h1>Another page</h1>")
  })
  await setFetchSite(ctx, tokenId, new URL(site.origin).host, "allowed")
  await setFetchPrivate(ctx, tokenId, "allowed")
})

afterEach(async () => {
  await closeAllBrowsers()
  await site.close()
  await framed.close()
  await cleanup()
})

afterAll(async () => {
  await closeAllBrowsers()
})

function call(name: string, args: Record<string, unknown>) {
  return callServerTool(ctx, server, name, args, {
    publicUrl: PUBLIC_URL,
    tokenId,
  })
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
}

function refOf(result: CallToolResult, pattern: RegExp): string {
  const line = textOf(result)
    .split("\n")
    .find((candidate) => pattern.test(candidate))
  const ref = line?.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1]

  if (!ref) {
    throw new Error(`no ref for ${pattern} in:\n${textOf(result)}`)
  }

  return ref
}

async function owner(promise: Promise<unknown>): Promise<BrowserAsk> {
  try {
    await promise
  } catch (error) {
    if (isOwnerNeeded(error)) return error.ask
    throw error
  }
  throw new Error("expected the owner to be asked")
}

/** Opens a page of the site in a new tab: its id and its answer. */
async function open(path: string) {
  const opened = await call("tabs", {
    action: "open",
    url: `${site.origin}${path}`,
  })
  const tab = textOf(opened).match(/^Tab (\S+):/m)?.[1]

  if (!tab) {
    throw new Error(`no tab in:\n${textOf(opened)}`)
  }

  return { tab, opened }
}

/** What a field of the tab holds, as the page has it (the test's own look). */
function fieldValue(tab: string, selector: string): Promise<string> {
  return runningBrowser(ctx.vaultId)!
    .tabs.get(tab)!
    .page.locator(selector)
    .inputValue()
}

async function always(name = "Shop password") {
  const secret = await db().secret.findFirstOrThrow({ where: { name } })
  await grantSecretUse(ctx, {
    tokenId,
    secretId: secret.id,
    origin: site.origin,
    level: "always",
  })
}

describe.skipIf(!executable)("typing a secret", { timeout: 90_000 }, () => {
  it("asks the owner first, types it once allowed, and never shows it", async () => {
    const { tab, opened } = await open("/login")
    const password = refOf(opened, /textbox "Password"/)
    const args = { tab, ref: password, text: { $secret: "Shop password" } }

    const ask = await owner(call("type", args))
    expect(ask).toMatchObject({
      kind: "secret_use",
      input: {
        secretName: "Shop password",
        origin: site.origin,
        tabId: tab,
        field: password,
        call: { tab, ref: password },
      },
    })
    expect(await fieldValue(tab, "#pw")).toBe("")

    await grantSecretUse(ctx, {
      tokenId,
      secretId,
      origin: site.origin,
      level: "once",
    })
    // The call's line in the request log gets the secret's name and site.
    const { typed, note } = await withLogNote(async (note) => ({
      typed: await call("type", args),
      note,
    }))
    expect(note).toEqual({ secret: "Shop password", origin: site.origin })

    expect(typed.isError, textOf(typed)).toBeUndefined()
    expect(textOf(typed)).toContain('Typed the secret "Shop password"')
    expect(textOf(typed)).toMatch(
      /textbox "Password" .*\[ref=\w+\]: \[secret: Shop password\]/,
    )
    expect(textOf(typed)).not.toContain(VALUE)
    expect(await fieldValue(tab, "#pw")).toBe(VALUE)

    for (const read of [
      await call("snapshot", { tab }),
      await call("read_page", { tab }),
      await call("find", { tab, text: "Password" }),
    ]) {
      expect(textOf(read)).not.toContain(VALUE)
    }

    const picture = await call("screenshot", { tab })
    expect(picture.isError).toBe(true)
    expect(textOf(picture)).toContain('holds the secret "Shop password"')
    expect(picture.content.some((part) => part.type === "image")).toBe(false)

    // The once answer was used.
    expect(await owner(call("type", args))).toMatchObject({
      kind: "secret_use",
    })
  })

  it("logs a use the owner's answer made with the secret's name and site, never its value", async () => {
    const { tab, opened } = await open("/login")
    await always()

    // Outside a gateway call (as when the owner allowed it on PCP's page),
    // the use gets a line of its own.
    await call("type", {
      tab,
      ref: refOf(opened, /textbox "Password"/),
      text: { $secret: "Shop password" },
    })

    await expect.poll(async () => (await logDays()).length).toBe(1)
    const { entries } = await readRequestLog(ctx.vaultId)
    expect(entries).toMatchObject([
      {
        tokenId,
        tool: "type",
        secret: "Shop password",
        origin: site.origin,
        ok: true,
      },
    ])
    expect(JSON.stringify(entries)).not.toContain(VALUE)
  })

  it("never shows a password field's value, typed by anyone", async () => {
    const { tab, opened } = await open("/login")

    const typed = await call("type", {
      tab,
      ref: refOf(opened, /textbox "Password"/),
      text: "plain-typed-password",
    })

    expect(textOf(typed)).toMatch(
      /textbox "Password" .*\[ref=\w+\]: \[password\]/,
    )
    expect(textOf(await call("snapshot", { tab }))).not.toContain(
      "plain-typed-password",
    )
  })

  it("refuses a field in a frame from another site", async () => {
    await grantSecretUse(ctx, {
      tokenId,
      secretId,
      origin: framed.origin,
      level: "always",
    })
    await always()
    const { tab } = await open("/framed")
    // The frame's elements come with the snapshot once it has loaded.
    let snapshot = await call("snapshot", { tab })
    for (
      let tries = 0;
      !/Inner password/.test(textOf(snapshot)) && tries < 20;
      tries++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      snapshot = await call("snapshot", { tab })
    }

    const refused = await call("type", {
      tab,
      ref: refOf(snapshot, /textbox "Inner password"/),
      text: { $secret: "Shop password" },
    })

    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain(`in a frame from ${framed.origin}`)
    const frame = runningBrowser(ctx.vaultId)!
      .tabs.get(tab)!
      .page.frames()
      .find((candidate) => candidate.url().startsWith(framed.origin))!
    expect(await frame.locator("input").inputValue()).toBe("")
  })

  it("lets screenshots be taken again once the field changes or the page moves on", async () => {
    await always()
    const { tab, opened } = await open("/login")
    const password = refOf(opened, /textbox "Password"/)
    const secret = { tab, ref: password, text: { $secret: "Shop password" } }

    await call("type", secret)
    expect((await call("screenshot", { tab })).isError).toBe(true)

    await call("type", { tab, ref: password, text: "something else" })
    const after = await call("screenshot", { tab })
    expect(after.isError, textOf(after)).toBeUndefined()
    expect(after.content.some((part) => part.type === "image")).toBe(true)

    await call("type", secret)
    expect((await call("screenshot", { tab })).isError).toBe(true)
    await call("navigate", { tab, url: `${site.origin}/elsewhere` })
    expect((await call("screenshot", { tab })).isError).toBeUndefined()
  })

  it("shows a value the page repeats as the secret's name too", async () => {
    await always()
    const { tab, opened } = await open("/mirror")

    const typed = await call("type", {
      tab,
      ref: refOf(opened, /textbox "Token"/),
      text: { $secret: "Shop password" },
    })

    expect(textOf(typed)).toContain("You typed [secret: Shop password]")
    expect(textOf(typed)).not.toContain(VALUE)
    for (const read of [
      await call("read_page", { tab }),
      await call("tabs", { action: "list" }),
      await call("back", { tab }),
    ]) {
      expect(textOf(read)).not.toContain(VALUE)
    }
  })

  it("types a one-time code secret's code of the moment, never its seed", async () => {
    await createSecret(ctx, { name: "Shop codes", value: SEED, kind: "totp" })
    await always("Shop codes")
    const { tab, opened } = await open("/login")

    const typed = await call("type", {
      tab,
      ref: refOf(opened, /textbox "Code"/),
      text: { $secret: "Shop codes" },
    })

    const code = await fieldValue(tab, "#code")
    expect(code).toMatch(/^\d{6}$/)
    expect(textOf(typed)).not.toContain(code)
    expect(textOf(typed)).toContain("[secret: Shop codes]")
    expect(textOf(typed)).not.toContain(SEED)
  })

  it("takes a secret only as type's text, and from a wrapper only where it is bound", async () => {
    await always()
    const { tab, opened } = await open("/login")
    const ref = refOf(opened, /textbox "Password"/)

    await expect(
      call("press_key", { tab, key: { $secret: "Shop password" } }),
    ).rejects.toThrow(/only as type's text/)
    await expect(
      call("navigate", { tab, url: { $secret: "Shop password" } }),
    ).rejects.toThrow(/only as type's text/)
    await expect(
      call("type", {
        tab,
        ref,
        text: "x",
        submit: { $secret: "Shop password" },
      }),
    ).rejects.toThrow(/only as type's text/)

    // A wrapper's call with no binding for it.
    await expect(
      callServerTool(
        ctx,
        server,
        "type",
        { tab, ref, text: { $secret: "Shop password" } },
        { publicUrl: PUBLIC_URL, tokenId, secrets: [] },
      ),
    ).rejects.toThrow(/has not allowed the secret "Shop password"/)
    expect(await fieldValue(tab, "#pw")).toBe("")

    // With one, as the owner approved it.
    const typed = await callServerTool(
      ctx,
      server,
      "type",
      { tab, ref, text: { $secret: "Shop password" } },
      {
        publicUrl: PUBLIC_URL,
        tokenId,
        secrets: [
          {
            pointer: "/text",
            name: "Shop password",
            secretId,
            template: "{{secret}}",
            url: server.url,
          },
        ],
      },
    )
    expect(typed.isError, textOf(typed)).toBeUndefined()
    expect(await fieldValue(tab, "#pw")).toBe(VALUE)

    await expect(
      call("type", { tab, ref, text: { $secret: "No such secret" } }),
    ).rejects.toThrow(/no secret called "No such secret"/)
  })
})
