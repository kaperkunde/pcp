import type { VaultContext } from "../context"
import { db } from "../db"
import { isPcpError, PcpError } from "../errors"
import {
  isPassOnlyEntry,
  openEncryptedFolder,
  openMeta,
  sweepPending,
} from "./encrypted"
import { openFolder, type Entry, type StorageFolder } from "./files"
import {
  CONVERT_BUDGET_MS,
  CONVERT_BATCH_FILES,
  MAX_DEPTH,
  OBJECTS_FOLDER,
} from "./limits"
import { isPartName, joinRelative, splitPath } from "./paths"
import { storeRoom } from "./quota"
import {
  loadStorageRoot,
  newWrappedStoreKey,
  storeKeyOf,
  storePath,
  type LoadedStorage,
  type StorageConnect,
  type StoreMode,
} from "./roots"

/**
 * The owner's conversion of a store, either way: a plain folder encrypted
 * (each file sealed into an object and put in the index, then the plain
 * file removed) or an encrypted store made plain again (each file written
 * back under its name, then its entry and object removed). Nothing is
 * removed before what replaces it is whole.
 *
 * It runs inside the owner's requests, a batch at a time within
 * CONVERT_BUDGET_MS and CONVERT_BATCH_FILES, never on a timer: the page
 * calls again until it is done. Between batches the store is marked as
 * converting (`storage_root.converting`) and refuses every tool, so nothing
 * else changes it meanwhile; a batch cut short (a closed page, a lost
 * connection) is picked up where it stopped, as what was converted is no
 * longer where the walk looks. Links and other things that are not files
 * or folders are left where they are and named.
 */

export type ConversionStep = {
  /** The store is in the mode asked for now. */
  done: boolean
  /** Files converted in this batch. */
  files: number
  /** What was left as it is, with why: a link, a name already taken. */
  skipped: string[]
  message: string
}

type Budget = { until: number; files: number }

function spent(budget: Budget): boolean {
  return budget.files <= 0 || Date.now() >= budget.until
}

function label(path: string): string {
  return path === "" ? "the top" : path
}

/** A folder's parent path, "" for the top. */
function parentOf(path: string): string {
  return joinRelative(splitPath(path).slice(0, -1))
}

/**
 * One batch of converting `loaded` to `to`. `connect` opens its backend
 * with the key the owner's request handed in (upstream.ts).
 */
export async function convertStoreStep(
  ctx: VaultContext,
  loaded: LoadedStorage,
  connect: StorageConnect,
  to: StoreMode,
  {
    budgetMs = CONVERT_BUDGET_MS,
    maxFiles = CONVERT_BATCH_FILES,
  }: { budgetMs?: number; maxFiles?: number } = {},
): Promise<ConversionStep> {
  const { server } = loaded

  if (server.readOnly) {
    throw new PcpError(
      "state",
      `${server.name} is read-only in PCP: turn that off to convert it.`,
    )
  }

  if (loaded.root.mode === to && loaded.root.converting === "") {
    return {
      done: true,
      files: 0,
      skipped: [],
      message: `${server.name} is ${to} already.`,
    }
  }

  // A file saved from a part keep named stays encrypted (#158): a plain
  // folder has nowhere to keep its mark. Said before anything starts.
  if (to === "plain" && loaded.root.converting !== "plain") {
    const held = await passOnlyFiles(ctx, server.id, 6)

    if (held.length > 0) {
      const names = held.slice(0, 5)
      throw new PcpError(
        "state",
        `${server.name} holds files saved from results PCP never reads out (${names.join(", ")}${held.length > 5 ? ", and more" : ""}), which a plain folder cannot keep so: delete them first, then make it plain.`,
      )
    }
  }

  // Marked first, with a key to encrypt under: from here every tool waits.
  if (
    loaded.root.converting !== to ||
    (to === "encrypted" && !loaded.root.storeKey)
  ) {
    await db().storageRoot.update({
      where: { serverId: server.id },
      data: {
        converting: to,
        ...(loaded.root.storeKey
          ? {}
          : { storeKey: newWrappedStoreKey(ctx, server.id) }),
      },
    })
    loaded = await loadStorageRoot(ctx, server.id)
  }

  const fs = await connect()

  try {
    const path = await storePath(loaded)
    const plain = await openFolder(fs, path, { umask: loaded.root.umask })
    const encrypted = await openEncryptedFolder(
      ctx,
      {
        serverId: server.id,
        storeKey: storeKeyOf(ctx, loaded),
        rootReal: plain.rootReal,
        umask: loaded.root.umask,
        room: () => storeRoom(loaded),
      },
      fs,
    )
    const budget: Budget = { until: Date.now() + budgetMs, files: maxFiles }
    const skipped: string[] = []
    const before = maxFiles

    const finished =
      to === "encrypted"
        ? await encryptFolder(plain, encrypted, "", 0, budget, skipped)
        : await decryptFolder(plain, encrypted, "", 0, budget, skipped)
    const files = before - budget.files
    const complete =
      finished &&
      (to === "encrypted" ||
        (await db().storageEntry.count({ where: { serverId: server.id } })) ===
          0)

    if (!complete) {
      return {
        done: false,
        files,
        skipped,
        message: `${to === "encrypted" ? "Encrypted" : "Decrypted"} ${files} ${files === 1 ? "file" : "files"}; more to go.${skippedWords(skipped)}`,
      }
    }

    if (to === "plain") {
      // The objects' folder goes with the last of them.
      await sweepPending(
        { serverId: server.id, rootReal: plain.rootReal },
        fs,
        { all: true },
      )
      await plain.remove(OBJECTS_FOLDER, { recursive: true }).catch((error) => {
        if (!isPcpError(error) || error.code !== "not_found") throw error
      })
    }

    await db().storageRoot.update({
      where: { serverId: server.id },
      data: {
        mode: to,
        converting: "",
        ...(to === "plain" ? { storeKey: null } : {}),
      },
    })

    return {
      done: true,
      files,
      skipped,
      message: `${server.name} is ${to === "encrypted" ? "encrypted" : "plain"} now.${skippedWords(skipped)}`,
    }
  } finally {
    fs.end()
  }
}

/** How many entries of the index the pass-only check opens at once. */
const PASS_ONLY_PAGE = 500

/**
 * The names of up to `most` files of an encrypted store saved from a
 * pass-only kept result (#158), by the row's mark or the sealed one, which a
 * database write alone cannot clear: the marked rows first, then the index
 * a page at a time, stopping once it found as many.
 */
async function passOnlyFiles(
  ctx: VaultContext,
  serverId: string,
  most: number,
): Promise<string[]> {
  const found = new Map<string, string>()
  const select = { id: true, meta: true, passOnly: true } as const

  for (const row of await db().storageEntry.findMany({
    where: { serverId, folder: false, passOnly: true },
    select,
    take: most,
  })) {
    found.set(row.id, openMeta(ctx, row).n)
  }

  let after: string | undefined

  while (found.size < most) {
    const page = await db().storageEntry.findMany({
      where: {
        serverId,
        folder: false,
        passOnly: false,
        ...(after ? { id: { gt: after } } : {}),
      },
      select,
      orderBy: { id: "asc" },
      take: PASS_ONLY_PAGE,
    })

    for (const row of page) {
      const meta = openMeta(ctx, row)
      if (isPassOnlyEntry(row, meta)) found.set(row.id, meta.n)
      if (found.size >= most) break
    }

    if (page.length < PASS_ONLY_PAGE) break
    after = page[page.length - 1]!.id
  }

  return [...found.values()]
}

function skippedWords(skipped: string[]): string {
  if (skipped.length === 0) return ""
  const shown = skipped.slice(0, 5).join("; ")
  return ` Left as they are: ${shown}${skipped.length > 5 ? `, and ${skipped.length - 5} more` : ""}.`
}

/**
 * Encrypts what is under a plain folder, deepest first: each file into the
 * index, then removed; each folder once it is empty. True when it went
 * through the whole folder.
 */
async function encryptFolder(
  plain: StorageFolder,
  encrypted: StorageFolder,
  path: string,
  depth: number,
  budget: Budget,
  skipped: string[],
): Promise<boolean> {
  const listing = await plain.list(path)

  for (const entry of listing.entries) {
    if (spent(budget)) return false

    // The objects are the encrypted store's own.
    if (depth === 0 && entry.name === OBJECTS_FOLDER) continue

    if (isPartName(entry.name)) {
      skipped.push(`${entry.path} (a file still being written)`)
      continue
    }

    if (entry.type === "folder") {
      if (depth >= MAX_DEPTH) {
        skipped.push(`${entry.path} (deeper than ${MAX_DEPTH} folders)`)
        continue
      }

      await encrypted.makeFolder(entry.path, { parents: true })

      if (
        !(await encryptFolder(
          plain,
          encrypted,
          entry.path,
          depth + 1,
          budget,
          skipped,
        ))
      ) {
        return false
      }

      const left = await plain.list(entry.path, 1)
      if (left.entries.length === 0) {
        await plain.remove(entry.path, { recursive: false })
      }
      continue
    }

    if (entry.type !== "file") {
      skipped.push(`${entry.path} (a link or something other than a file)`)
      continue
    }

    await encryptFile(plain, encrypted, entry, skipped)
    budget.files--
  }

  // A listing cut at its most: what is left comes in the next batch.
  return !listing.truncated
}

async function encryptFile(
  plain: StorageFolder,
  encrypted: StorageFolder,
  entry: Entry,
  skipped: string[],
): Promise<void> {
  const opened = await plain.open(entry.path)

  try {
    await encrypted.makeFolder(parentOf(entry.path), { parents: true })
    await encrypted.saveFrom(entry.path, opened.stream, { overwrite: false })
  } catch (error) {
    opened.stream.destroy()

    if (!isPcpError(error) || error.code !== "conflict") throw error

    // Encrypted by a batch cut short after it was put in the index: the
    // same file, so the plain one goes. Anything else stays and is named.
    const there = await encrypted
      .list(parentOf(entry.path))
      .then((listing) => listing.entries.find((e) => e.name === entry.name))

    if (there?.type !== "file" || there.size !== entry.size) {
      skipped.push(
        `${entry.path} (the encrypted store has another file of that name)`,
      )
      return
    }
  }

  await plain.remove(entry.path, { recursive: false })
}

/**
 * Decrypts what is under a folder of the index, deepest first: each file
 * written back under its name, then its entry removed; each folder made
 * plain once it is empty. True when it went through the whole folder.
 */
async function decryptFolder(
  plain: StorageFolder,
  encrypted: StorageFolder,
  path: string,
  depth: number,
  budget: Budget,
  skipped: string[],
): Promise<boolean> {
  const listing = await encrypted.list(path)

  for (const entry of listing.entries) {
    if (spent(budget)) return false

    if (entry.type === "folder") {
      await plain.makeFolder(entry.path, { parents: true })

      if (
        !(await decryptFolder(
          plain,
          encrypted,
          entry.path,
          depth + 1,
          budget,
          skipped,
        ))
      ) {
        return false
      }

      const left = await encrypted.list(entry.path, 1)
      if (left.entries.length === 0) {
        await encrypted.remove(entry.path, { recursive: false })
      }
      continue
    }

    await decryptFile(plain, encrypted, entry, skipped)
    budget.files--
  }

  return !listing.truncated
}

async function decryptFile(
  plain: StorageFolder,
  encrypted: StorageFolder,
  entry: Entry,
  skipped: string[],
): Promise<void> {
  const opened = await encrypted.open(entry.path)

  // A plain file has nowhere to keep the mark of a part keep named (#158):
  // it stays encrypted until it is deleted.
  if (opened.passOnly) {
    opened.stream.destroy()
    skipped.push(
      `${label(entry.path)} (saved from a result PCP never reads out, which a plain folder cannot keep so: delete it to finish)`,
    )
    return
  }

  try {
    await plain.makeFolder(parentOf(entry.path), { parents: true })
    await plain.saveFrom(entry.path, opened.stream, { overwrite: false })
  } catch (error) {
    opened.stream.destroy()

    if (!isPcpError(error) || error.code !== "conflict") throw error

    const there = await plain
      .list(parentOf(entry.path))
      .then((listing) => listing.entries.find((e) => e.name === entry.name))

    if (there?.type !== "file" || there.size !== entry.size) {
      skipped.push(`${label(entry.path)} (a plain file of that name is there)`)
      return
    }
  }

  await encrypted.remove(entry.path, { recursive: false })
}
