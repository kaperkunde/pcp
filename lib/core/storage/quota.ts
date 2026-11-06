import fs from "node:fs/promises"
import path from "node:path"

import type { StorageRoot } from "@/lib/generated/prisma/client"

import { db } from "../db"
import { loadResourceLimits } from "../resources/state"
import { localStoreDir } from "./local"
import { MAX_USAGE_ENTRIES } from "./limits"

/**
 * How much PCP's own store may hold (`resourceLimits().storeBytes`, picked
 * from the disk unless the owner set it on Settings → Resources) and how
 * much it holds. A store on an SSH server is bounded by that server's disk,
 * not by PCP: it has no quota here.
 */

/** What a local store takes on the disk now, in bytes. */
export async function storeUsage(store: {
  server: { id: string }
  root: Pick<StorageRoot, "backend" | "mode">
}): Promise<number> {
  if (store.root.mode === "encrypted") {
    const sum = await db().storageEntry.aggregate({
      where: { serverId: store.server.id },
      _sum: { storedBytes: true },
    })
    return sum._sum.storedBytes ?? 0
  }

  return folderBytes(localStoreDir(store.server.id))
}

/**
 * The bytes of the files under a folder, never following a link, looking
 * at no more than MAX_USAGE_ENTRIES entries.
 */
export async function folderBytes(top: string): Promise<number> {
  let total = 0
  let seen = 0
  const queue = [top]

  while (queue.length > 0 && seen < MAX_USAGE_ENTRIES) {
    const dir = queue.shift()!
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => [])

    for (const entry of entries) {
      if (++seen > MAX_USAGE_ENTRIES) break
      const at = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        queue.push(at)
      } else if (entry.isFile()) {
        total += (await fs.lstat(at).catch(() => null))?.size ?? 0
      }
    }
  }

  return total
}

/**
 * How many more bytes a store may take, or null for a store with no quota
 * (on an SSH server).
 */
export async function storeRoom(store: {
  server: { id: string }
  root: Pick<StorageRoot, "backend" | "mode">
}): Promise<number | null> {
  if (store.root.backend !== "local") {
    return null
  }

  const { storeBytes } = await loadResourceLimits()
  return storeBytes - (await storeUsage(store))
}
