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
 * written when it is added and whenever it is checked; checking it is
 * finding Chromium on this machine.
 */

export const BROWSER_NAME = "Browser"
export const BROWSER_DESCRIPTION =
  "A web browser on the machine PCP runs on, shared by assistants: open pages, read them, click, type and fill in forms, keeping its sign-ins between conversations. The owner decides which sites each token opens, and can watch any tab and take it over."

export async function findBrowserServer(
  ctx: VaultContext,
): Promise<McpServer | null> {
  return db().mcpServer.findFirst({
    where: { vaultId: ctx.vaultId, kind: "browser" },
  })
}

export async function syncBrowserTools(
  server: Pick<McpServer, "id">,
): Promise<SyncResult> {
  const toolCount = await storeTools(server.id, browserTools())

  if (!(await chromiumExecutable())) {
    const message =
      "Chromium is not installed on the machine PCP runs on; the Browser page says how to add it."
    await setServerStatus(server.id, "error", message, {
      lastSyncedAt: new Date(),
    })
    return { status: "error", message, toolCount }
  }

  await setServerStatus(server.id, "ok", "", { lastSyncedAt: new Date() })
  return { status: "ok", message: "", toolCount }
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
