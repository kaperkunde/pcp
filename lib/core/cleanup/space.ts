import { db } from "../db"
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

/** Bytes the database file gave back to the disk. */
export async function reclaimSpace(): Promise<number> {
  await db().$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)")

  const before = await pages()
  const free = before.freePages * before.pageSize
  const size = before.pageCount * before.pageSize

  if (
    free === 0 ||
    (free < MIN_RECLAIM_BYTES && free < size * MIN_RECLAIM_SHARE)
  ) {
    return 0
  }

  await db().$executeRawUnsafe("VACUUM")
  // VACUUM writes the new file through the log too.
  await db().$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)")

  const after = await pages()

  return Math.max(0, size - after.pageCount * after.pageSize)
}
