import fs from "node:fs/promises"
import path from "node:path"

import { db } from "../db"
import { OBJECT_ID } from "./crypt"
import {
  MAX_USAGE_ENTRIES,
  OBJECTS_FOLDER,
  PART_FILE_AGE_MS,
  PART_SUFFIX,
  PENDING_SWEEP_AGE_MS,
} from "./limits"
import { storageDir } from "./local"

/**
 * The cleanup's part for stores in PCP's data folder (lib/core/cleanup/):
 * what a request left behind there, removed by its dates and names alone,
 * with no key and nothing read. Stores on an SSH server are swept by the
 * next request that opens them (encrypted.ts sweepPending), since only a
 * request holds the key to reach them.
 *
 * - The folder of a store that is gone (deleted, or its vault deleted).
 * - Objects an encrypted store let go of, or a write never finished
 *   (storage_pending past its age), with their part files.
 * - Part files (`*.pcp-part`) older than PART_FILE_AGE_MS: a write cut off
 *   before it was renamed into place.
 */

export type StoreCleanup = { removed: number; freedBytes: number }

async function sizeOf(at: string): Promise<number> {
  return (await fs.lstat(at).catch(() => null))?.size ?? 0
}

async function removeTree(at: string): Promise<number> {
  let bytes = 0
  const walk = async (dir: string) => {
    for (const entry of await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => [])) {
      const child = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(child)
      else bytes += await sizeOf(child)
    }
  }
  await walk(at)
  await fs.rm(at, { recursive: true, force: true })
  return bytes
}

export async function pruneLocalStores(
  now = new Date(),
): Promise<StoreCleanup> {
  const top = storageDir()
  const result: StoreCleanup = { removed: 0, freedBytes: 0 }
  const dirs = await fs.readdir(top, { withFileTypes: true }).catch(() => [])

  if (dirs.length === 0) {
    return result
  }

  const stores = new Set(
    (
      await db().storageRoot.findMany({
        where: { backend: "local" },
        select: { serverId: true },
      })
    ).map((row) => row.serverId),
  )

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const at = path.join(top, dir.name)

    if (!stores.has(dir.name)) {
      result.freedBytes += await removeTree(at)
      result.removed++
      continue
    }

    // Objects let go of, or never finished.
    const pending = await db().storagePending.findMany({
      where: {
        serverId: dir.name,
        createdAt: { lt: new Date(now.getTime() - PENDING_SWEEP_AGE_MS) },
      },
    })

    for (const row of pending) {
      if (OBJECT_ID.test(row.objectId)) {
        const object = path.join(
          at,
          OBJECTS_FOLDER,
          row.objectId.slice(0, 2),
          row.objectId,
        )
        result.freedBytes += await sizeOf(object)
        await fs.rm(object, { force: true })
      }
      await db().storagePending.deleteMany({
        where: { objectId: row.objectId },
      })
      result.removed++
    }

    // Part files of writes that were cut off.
    let seen = 0
    const queue = [at]

    while (queue.length > 0 && seen < MAX_USAGE_ENTRIES) {
      const folder = queue.shift()!

      for (const entry of await fs
        .readdir(folder, { withFileTypes: true })
        .catch(() => [])) {
        if (++seen > MAX_USAGE_ENTRIES) break
        const child = path.join(folder, entry.name)

        if (entry.isDirectory()) {
          queue.push(child)
        } else if (entry.isFile() && entry.name.endsWith(PART_SUFFIX)) {
          const stat = await fs.lstat(child).catch(() => null)

          if (stat && now.getTime() - stat.mtimeMs > PART_FILE_AGE_MS) {
            result.freedBytes += stat.size
            await fs.rm(child, { force: true })
            result.removed++
          }
        }
      }
    }
  }

  return result
}

/** What the local stores take on the disk, for the cleanup's overview. */
export async function localStoresBytes(): Promise<number> {
  let total = 0
  let seen = 0
  const queue = [storageDir()]

  while (queue.length > 0 && seen < MAX_USAGE_ENTRIES) {
    const folder = queue.shift()!

    for (const entry of await fs
      .readdir(folder, { withFileTypes: true })
      .catch(() => [])) {
      if (++seen > MAX_USAGE_ENTRIES) break
      const child = path.join(folder, entry.name)
      if (entry.isDirectory()) queue.push(child)
      else if (entry.isFile()) total += await sizeOf(child)
    }
  }

  return total
}
