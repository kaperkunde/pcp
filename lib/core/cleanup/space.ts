import { db } from "../db"
import { getHostSetting, setHostSetting } from "../host-settings"
import { localStoresBytes } from "../storage/cleanup"
import { MIN_RECLAIM_BYTES, MIN_RECLAIM_SHARE } from "./limits"

/**
 * Gives the disk back what a cleanup freed. SQLite keeps the pages of rows
 * it deleted for later rows, so a day of large kept results leaves the
 * database file as large as it was; and the write-ahead log keeps what was
 * written until a checkpoint. After each cleanup the log is checkpointed and
 * truncated, and when enough of the file is free pages (MIN_RECLAIM_BYTES,
 * or MIN_RECLAIM_SHARE of it) the file is rebuilt without them (VACUUM).
 *
 * Nothing is read but the database's own page counts.
 */

type Pages = { pageSize: number; pageCount: number; freePages: number }

async function pragma(name: string): Promise<number> {
  const rows = await db().$queryRawUnsafe<Array<Record<string, unknown>>>(
    `PRAGMA ${name}`,
  )
  const value = rows[0] ? Object.values(rows[0])[0] : 0

  return Number(value ?? 0)
}

async function pages(): Promise<Pages> {
  return {
    pageSize: await pragma("page_size"),
    pageCount: await pragma("page_count"),
    freePages: await pragma("freelist_count"),
  }
}

/**
 * The host setting that says the database was rebuilt once since
 * secure_delete was turned on (lib/core/db.ts): pages freed before then may
 * still hold what was deleted, so the first cleanup rebuilds the file
 * whatever its free pages come to. A flag of the machine's, nothing of a
 * vault.
 */
export const SCRUBBED_KEY = "db.scrubbed"

async function checkpoint(): Promise<void> {
  await db().$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)")
}

/**
 * Bytes the database file gave back to the disk. `force` rebuilds the file
 * however little of it is free: for when what matters is that removed rows
 * leave no trace, not the space.
 */
export async function reclaimSpace({
  force = false,
}: { force?: boolean } = {}): Promise<number> {
  await checkpoint()

  const before = await pages()
  const free = before.freePages * before.pageSize
  const size = before.pageCount * before.pageSize
  const firstSince = (await getHostSetting(SCRUBBED_KEY)) === null

  if (
    !force &&
    !firstSince &&
    (free === 0 ||
      (free < MIN_RECLAIM_BYTES && free < size * MIN_RECLAIM_SHARE))
  ) {
    return 0
  }

  await vacuum()

  if (firstSince) {
    await setHostSetting(SCRUBBED_KEY, new Date().toISOString())
  }

  const after = await pages()

  return Math.max(0, size - after.pageCount * after.pageSize)
}

async function vacuum(): Promise<void> {
  await db().$executeRawUnsafe("VACUUM")
  // VACUUM writes the new file through the log too.
  await checkpoint()
}

/**
 * After the owner removed something (a server, a secret, the vault): the
 * write-ahead log still holds the pages as they were before, so it is
 * checkpointed and truncated; with `rebuild`, the file is rebuilt too
 * (VACUUM), for when a whole vault's rows went. secure_delete has already
 * zeroed the rows in the pages themselves. Outside any transaction, one at
 * a time with the cleanup (scrubFreedPages in ./runtime.ts).
 */
export async function scrub({ rebuild }: { rebuild: boolean }): Promise<void> {
  if (rebuild) {
    await reclaimSpace({ force: true })
    return
  }

  await checkpoint()
}

/**
 * What PCP's own store takes in the data folder (lib/core/storage/), beside
 * the database: its files, counted after the cleanup removed what it left
 * behind. Nothing is read but the files' sizes.
 */
export async function storesSpace(): Promise<{ storeBytes?: number }> {
  try {
    const bytes = await localStoresBytes()
    return bytes > 0 ? { storeBytes: bytes } : {}
  } catch {
    return {}
  }
}
