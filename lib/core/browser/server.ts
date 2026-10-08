import type { McpServer } from "@/lib/generated/prisma/client"

import { storeTools, type SyncResult } from "../catalogue"
import type { VaultContext } from "../context"
import { db } from "../db"
import { PcpError } from "../errors"
import { newId } from "../ids"
import {
  BROWSER_URL,
  normalizeNameAndDescription,
  setServerStatus,
  slugify,
  uniqueSlug,
} from "../servers"
import { chromiumExecutable } from "./executable"
import { browserTools } from "./tools"

/**
 * The browser's row in the registry: a server of kind "browser", one per
 * vault, added by the owner. Its tools are fixed (tools.ts), so they are
 * written when it is added, when PCP starts (instrumentation.ts: a newer
 * version may have changed them) and whenever it is checked; checking it
 * is finding Chromium on this machine.
 */

export const BROWSER_NAME = "Browser"
export const BROWSER_DESCRIPTION =
  "A web browser on the machine PCP runs on, shared by assistants, each with tabs of its own: open pages, read them, click, type and fill in forms, keeping its sign-ins between conversations. The owner decides which sites each token opens, and can watch any tab and take it over."

export async function findBrowserServer(
  ctx: VaultContext,
): Promise<McpServer | null> {
  return db().mcpServer.findFirst({
    where: { vaultId: ctx.vaultId, kind: "browser" },
  })
}

/**
 * The vault's browser, enabled, when a token reaches it: the token is the
 * vault's own, neither revoked nor expired, and has every server or the
 * browser among its servers (as owner.ts lists the tokens a tab can go
 * to). For what an answer may tell the token (its tools' names); it
 * decides nothing.
 */
export async function tokenReachesBrowser(
  ctx: VaultContext,
  tokenId: string,
): Promise<McpServer | null> {
  const server = await findBrowserServer(ctx)

  if (!server?.enabled) {
    return null
  }

  const token = await db().apiToken.findFirst({
    where: {
      id: tokenId,
      vaultId: ctx.vaultId,
      revokedAt: null,
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        {
          OR: [
            { allowAllServers: true },
            { servers: { some: { serverId: server.id } } },
          ],
        },
      ],
    },
    select: { id: true },
  })

  return token ? server : null
}

export async function syncBrowserTools(
  server: Pick<McpServer, "id">,
): Promise<SyncResult> {
  const toolCount = await storeTools(server.id, browserTools())

  if (!(await chromiumExecutable())) {
    const message =
      "Chromium is not installed on the machine PCP runs on; install it on the Browser page."
    await setServerStatus(server.id, "error", message, {
      lastSyncedAt: new Date(),
    })
    return { status: "error", message, toolCount }
  }

  await setServerStatus(server.id, "ok", "", { lastSyncedAt: new Date() })
  return { status: "ok", message: "", toolCount }
}

/**
 * Every vault's browser row checked again: Chromium belongs to the
 * machine, so installing it readies them all.
 */
export async function syncAllBrowserTools(): Promise<void> {
  const servers = await db().mcpServer.findMany({
    where: { kind: "browser" },
    select: { id: true },
  })

  for (const server of servers) {
    await syncBrowserTools(server)
  }
}

/** Adds the vault's browser; there is only ever one. */
export async function createBrowserServer(
  ctx: VaultContext,
): Promise<{ id: string }> {
  if (await findBrowserServer(ctx)) {
    throw new PcpError("conflict", "The browser is already added.")
  }

  const id = newId()

  await db().mcpServer.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      kind: "browser",
      name: BROWSER_NAME,
      slug: await uniqueSlug(ctx.vaultId, slugify(BROWSER_NAME)),
      description: BROWSER_DESCRIPTION,
      url: BROWSER_URL,
      authType: "none",
    },
  })
  await syncBrowserTools({ id })

  return { id }
}

/** The browser's name and description, which assistants read. */
export async function updateBrowserServer(
  ctx: VaultContext,
  input: { name: string; description: string },
): Promise<void> {
  const server = await findBrowserServer(ctx)

  if (!server) {
    throw new PcpError("not_found", "The browser is not added.")
  }

  const { name, description } = normalizeNameAndDescription(input)
  await db().mcpServer.update({
    where: { id: server.id },
    data: { name, description },
  })
}
