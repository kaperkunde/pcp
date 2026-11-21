import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import { listBrowserOrigins } from "./browser-secrets"
import type { VaultContext } from "./context"
import { db } from "./db"
import { buildGatewayServer } from "./gateway"
import { decidePermission, getPermissionView } from "./permissions"
import { secretNameWhere } from "./secret-meta"
import { createSecret, readSecretValue } from "./secrets"
import { entryCall } from "./test-handles"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// PCP's own request_secret (#162), as an assistant meets it through
// execute_write: a secret the owner stores on PCP's page, typed in or made
// by PCP there, its sites optional, its value never handed back.

const PUBLIC_URL = "http://localhost:3000"

let cleanup: () => Promise<void>
let ctx: VaultContext
let client: Client

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    serverIds: [],
  })
  const scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, []).connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
})

afterEach(async () => {
  await client.close()
  await cleanup()
})

async function request(args: Record<string, unknown>) {
  const result = await client.callTool(entryCall("request_secret", args))
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("")

  return { isError: result.isError === true, text }
}

async function newest() {
  const row = await db().permissionRequest.findFirstOrThrow({
    orderBy: { createdAt: "desc" },
  })

  return {
    row,
    view: (await getPermissionView(ctx, row.id, { publicUrl: PUBLIC_URL }))!,
  }
}

describe("request_secret, PCP's own", () => {
  it("asks for a secret with no sites, saved or not, and made by PCP when the owner keeps generate", async () => {
    const asked = await request({
      name: "Docling key",
      purpose: "The key the Docling service is set up with.",
      generate: { format: "alphanumeric", length: 40 },
    })

    expect(asked.isError).toBe(false)
    expect(asked.text).toContain("Not done yet")
    expect(asked.text).toContain(`${PUBLIC_URL}/permissions/`)
    const { row, view } = await newest()
    expect(row.serverId).toBeNull()
    expect(view.title).toBe('Store the secret "Docling key"?')
    expect(view.lines).toContain(
      "No sites yet: the browser types it only after asking you each time (Once, or Always at this site, which adds the site). It is sent to a server, a service or a wrapper only where you approve one that names it, which you are shown as also allowing it there.",
    )
    expect(view.secretToEnter).toMatchObject({
      name: "Docling key",
      origins: [],
      generate: { format: "alphanumeric", length: 40 },
    })
    expect(view.decisions).toEqual([
      { value: "allow_once", label: "Save it" },
      { value: "decline", label: "Not now" },
    ])

    const done = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
      generate: view.secretToEnter!.generate,
    })

    expect(done.isError).not.toBe(true)
    const secret = await db().secret.findFirstOrThrow({
      where: secretNameWhere(ctx, "Docling key"),
    })
    const value = await readSecretValue(ctx, secret.id)
    expect(value).toMatch(/^[A-Za-z0-9]{40}$/)
    expect(JSON.stringify(done)).toContain(
      "It has no sites yet, so the browser types it only after asking the owner each time: Once types it that one time, Always at this site adds the site (change_secret_scope proposes sites).",
    )
    expect(JSON.stringify(done)).toContain("PCP made its value itself")
    expect(JSON.stringify(done)).not.toContain(value)
    expect(JSON.stringify(await newest())).not.toContain(value)
    expect((await listBrowserOrigins(ctx)).get(secret.id)).toBeUndefined()
  })

  it("takes sites, a login name and a password the owner types, as the browser's did", async () => {
    await request({
      name: "Shop password",
      purpose: "To sign in to the shop.",
      origins: ["https://shop.example/login"],
      username: "ada@example.com",
    })
    const { row, view } = await newest()
    expect(view.secretToEnter).toMatchObject({
      origins: ["https://shop.example"],
      username: "ada@example.com",
    })
    expect(view.decisions.map((decision) => decision.value)).toEqual([
      "allow_once",
      "allow_for",
      "always",
      "decline",
    ])

    const done = await decidePermission(ctx, row.id, "always", {
      publicUrl: PUBLIC_URL,
      secretValue: "typed-by-ada",
      loginName: "ada@example.com",
    })

    expect(done.isError).not.toBe(true)
    expect(JSON.stringify(done)).not.toContain("typed-by-ada")
    expect(JSON.stringify(done)).toContain(
      '{\\"$secret\\": \\"Shop password\\"}',
    )
  })

  it("is refused before the owner is asked: a name PCP holds, codes without sites, a recipe that cannot be made", async () => {
    await createSecret(ctx, { name: "Taken", value: "v" })

    for (const [args, refused] of [
      [{ name: "Taken", purpose: "x" }, /never writes over one/],
      [
        { name: "Codes", purpose: "x", kind: "totp" },
        /These arguments do not fit|origins/,
      ],
      [
        { name: "Codes", purpose: "x", kind: "totp", origins: [] },
        /name the sites they are typed at/,
      ],
      [
        {
          name: "Made",
          purpose: "x",
          generate: { format: "hex", exclude: "a" },
        },
        /not hex/,
      ],
    ] as const) {
      const asked = await request(args)

      expect(asked.isError, JSON.stringify(args)).toBe(true)
      expect(asked.text).toMatch(refused)
    }

    expect(await db().permissionRequest.count()).toBe(0)
  })
})
