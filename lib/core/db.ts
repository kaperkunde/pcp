import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3"

import { PrismaClient } from "@/lib/generated/prisma/client"

import { databaseUrl } from "./data-dir"

/**
 * The one database handle. Lazy, so the data directory is read when the
 * first query runs rather than when the module loads (tests point
 * PCP_DATA_DIR at a scratch directory first). A host that embeds lib/core
 * with another database swaps this module: nothing else in lib/core opens a
 * connection.
 */
let client: PrismaClient | undefined

function create(): PrismaClient {
  const adapter = new PrismaBetterSqlite3(
    { url: databaseUrl(), timeout: 5000 },
    { timestampFormat: "iso8601" },
  )

  return new PrismaClient({ adapter })
}

const globalForPrisma = globalThis as unknown as {
  pcpPrisma: PrismaClient | undefined
}

export function db(): PrismaClient {
  if (client) {
    return client
  }

  // Next's dev server re-evaluates modules on hot reload; keep one client
  // per process rather than one per reload.
  if (process.env.NODE_ENV !== "production" && globalForPrisma.pcpPrisma) {
    client = globalForPrisma.pcpPrisma
    return client
  }

  client = create()

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.pcpPrisma = client
  }

  return client
}

/** Tests: drop the cached client so the next call opens a fresh database. */
export async function resetDb(): Promise<void> {
  const current = client ?? globalForPrisma.pcpPrisma
  client = undefined
  globalForPrisma.pcpPrisma = undefined
  await current?.$disconnect()
}
