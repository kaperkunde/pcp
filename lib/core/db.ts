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

/**
 * Set on every connection the client opens. SQLite keeps a deleted row's
 * bytes in the page it sat in, or in a free page, until something writes
 * over them; with secure_delete ON (not FAST, which leaves free-list pages
 * as they were) it writes zeros over them as it deletes, so what the owner
 * removes does not linger in the file. The write-ahead log keeps the older
 * page until a checkpoint: lib/core/cleanup/space.ts truncates it.
 */
export const CONNECTION_PRAGMAS = "PRAGMA secure_delete = ON;"

function create(): PrismaClient {
  const factory = new PrismaBetterSqlite3(
    { url: databaseUrl(), timeout: 5000 },
    { timestampFormat: "iso8601" },
  )
  // The adapter has no hook of its own for a new connection: every one it
  // hands Prisma runs the pragmas first.
  const connect = factory.connect.bind(factory)
  factory.connect = async () => {
    const adapter = await connect()
    await adapter.executeScript(CONNECTION_PRAGMAS)
    return adapter
  }

  return new PrismaClient({ adapter: factory })
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
