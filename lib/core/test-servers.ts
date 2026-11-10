import type { VaultContext } from "./context"
import { db } from "./db"
import { openServer } from "./server-meta"

/**
 * Tests: a server of the vault by its name, opened, with its headers and
 * tools. Names are sealed (#96), so a query cannot find one by name.
 */
export async function serverNamed(ctx: VaultContext, name: string) {
  const rows = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId },
    include: {
      authHeaders: { orderBy: { position: "asc" } },
      tools: { orderBy: { name: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  })
  const found = rows
    .map((row) => openServer(ctx, row))
    .find((row) => row.name === name)

  if (!found) {
    throw new Error(`No server named ${name}.`)
  }

  return found
}

/** Tests: the vault's only (or first) server, opened. */
export async function firstServer(ctx: VaultContext) {
  return openServer(
    ctx,
    await db().mcpServer.findFirstOrThrow({
      where: { vaultId: ctx.vaultId },
      orderBy: { createdAt: "asc" },
    }),
  )
}
