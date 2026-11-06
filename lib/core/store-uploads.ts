import type { FileLink } from "@/lib/generated/prisma/client"

import type { VaultContext } from "./context"
import { asBytes, decrypt, decryptString, encryptString } from "./crypto"
import { db } from "./db"
import { isPcpError } from "./errors"
import { fileAad, keyAad, storePathAad } from "./file-links"
import type { StorageFolder } from "./storage/files"
import { joinRelative, splitPath } from "./storage/paths"

/**
 * Uploads into a store: a receive_file link or an upload page
 * (create_upload_link) made with a destination, a store and a folder in
 * it. The file arrives as any upload does (file-links.ts, upload-links.ts),
 * held under the link's key, which the public request that brings it has
 * and nothing else; it becomes a kept result when the token uses its
 * handle, as always. Besides, the first request that holds the vault's key
 * after it arrived (check_upload, any call to /mcp, any of the owner's
 * pages, through `after()`) saves it in that folder: unwrapped with the
 * vault key, written through the store's own StorageFolder (encrypted per
 * store, confined, never over a file already there: a name taken gets
 * " (2)" and so on). Never on a timer: nothing holds the key in between.
 *
 * The folder, then the path the file got, is kept encrypted under the
 * vault's key (`file_link_store_path:<id>`), so the database names no file
 * of an encrypted store. The row stays, with the path, until its day is
 * up, so check_upload can say where each file went; once the file is both
 * saved and kept, its bytes go from the row.
 */

/** Tries for one file: a name taken gets " (2)" up to this. */
const MAX_NAME_TRIES = 20
/** A file that could not be saved is tried again after this. */
const RETRY_AFTER_MS = 5 * 60_000
/** Files saved in one go. */
const BATCH = 20

/** A folder or path in a store, as a link row keeps it. */
export function sealStorePath(
  ctx: VaultContext,
  id: string,
  path: string,
): Uint8Array<ArrayBuffer> {
  return asBytes(encryptString(ctx.dek, path, storePathAad(id)))
}

export function openStorePath(
  ctx: VaultContext,
  row: Pick<FileLink, "id" | "storePath">,
): string | null {
  return row.storePath
    ? decryptString(ctx.dek, Buffer.from(row.storePath), storePathAad(row.id))
    : null
}

/** A destination folder as given: its names, `..` refused; "" the top. */
export function cleanFolder(raw: string | undefined): string {
  return joinRelative(splitPath(raw ?? ""))
}

/** Opens a store by its server id for one run (upstream.ts). */
export type StoreOpener = <T>(
  storeId: string,
  run: (folder: StorageFolder) => Promise<T>,
) => Promise<T>

export type Delivery =
  | { resultId: string; storeId: string; path: string }
  | { resultId: string; storeId: string; error: string }

/** The name to try the nth time: "scan.pdf", "scan (2).pdf", … */
export function nameTry(name: string, attempt: number): string {
  if (attempt === 1) return name
  const dot = name.lastIndexOf(".")
  return dot > 0
    ? `${name.slice(0, dot)} (${attempt})${name.slice(dot)}`
    : `${name} (${attempt})`
}

async function saveOne(
  folder: StorageFolder,
  dir: string,
  name: string,
  bytes: Buffer,
): Promise<string> {
  if (dir) {
    await folder.makeFolder(dir, { parents: true })
  }

  for (let attempt = 1; ; attempt++) {
    const at = joinRelative([...splitPath(dir), nameTry(name, attempt)])

    try {
      return (await folder.save(at, bytes, { overwrite: false })).path
    } catch (error) {
      if (
        attempt < MAX_NAME_TRIES &&
        isPcpError(error) &&
        error.code === "conflict"
      ) {
        continue
      }
      throw error
    }
  }
}

const failedAt = new Map<string, number>()
const running = new Map<string, Promise<Delivery[]>>()

/**
 * Saves the files that arrived for a store and are not there yet: all of
 * the vault's, or one token's or one upload page's. One run per vault at a
 * time; a file that failed waits RETRY_AFTER_MS unless `retryNow` is
 * asked for (check_upload).
 */
export async function deliverStoreUploads(
  ctx: VaultContext,
  options: {
    open: StoreOpener
    tokenId?: string
    uploadLinkId?: string
    resultIds?: string[]
    retryNow?: boolean
  },
  now = new Date(),
): Promise<Delivery[]> {
  const before = running.get(ctx.vaultId)

  if (before) {
    // A request's after() leaves it to the run under way; check_upload
    // waits for it and looks again.
    if (!options.retryNow) return []
    await before.catch(() => [])
  }

  const run = deliver(ctx, options, now)
  running.set(ctx.vaultId, run)

  try {
    return await run
  } finally {
    if (running.get(ctx.vaultId) === run) running.delete(ctx.vaultId)
  }
}

async function deliver(
  ctx: VaultContext,
  {
    open,
    tokenId,
    uploadLinkId,
    resultIds,
    retryNow = false,
  }: {
    open: StoreOpener
    tokenId?: string
    uploadLinkId?: string
    resultIds?: string[]
    retryNow?: boolean
  },
  now: Date,
): Promise<Delivery[]> {
  const rows = (
    await db().fileLink.findMany({
      where: {
        vaultId: ctx.vaultId,
        kind: "upload",
        storeId: { not: null },
        receivedAt: { not: null },
        deliveredAt: null,
        ciphertext: { not: null },
        expiresAt: { gt: now },
        ...(tokenId ? { tokenId } : {}),
        ...(uploadLinkId ? { uploadLinkId } : {}),
        ...(resultIds ? { resultId: { in: resultIds } } : {}),
      },
      orderBy: { receivedAt: "asc" },
      take: BATCH,
    })
  ).filter(
    (row) =>
      retryNow || now.getTime() - (failedAt.get(row.id) ?? 0) >= RETRY_AFTER_MS,
  )
  const byStore = new Map<string, FileLink[]>()

  for (const row of rows) {
    byStore.set(row.storeId!, [...(byStore.get(row.storeId!) ?? []), row])
  }

  const done: Delivery[] = []

  for (const [storeId, links] of byStore) {
    try {
      await open(storeId, async (folder) => {
        for (const link of links) {
          try {
            const key = decrypt(
              ctx.dek,
              Buffer.from(link.wrappedKey!),
              keyAad(link.id),
            )
            const bytes = decrypt(
              key,
              Buffer.from(link.ciphertext!),
              fileAad(link.id),
            )
            const path = await saveOne(
              folder,
              openStorePath(ctx, link) ?? "",
              link.name || `upload-${now.toISOString().slice(0, 10)}`,
              bytes,
            )

            await db().fileLink.updateMany({
              where: { id: link.id, deliveredAt: null },
              data: {
                deliveredAt: now,
                storePath: sealStorePath(ctx, link.id, path),
              },
            })
            // Kept already: the row holds no bytes any more.
            await db().fileLink.updateMany({
              where: { id: link.id, claimedAt: { not: null } },
              data: { ciphertext: null },
            })
            failedAt.delete(link.id)
            done.push({ resultId: link.resultId, storeId, path })
          } catch (error) {
            failedAt.set(link.id, now.getTime())
            done.push({ resultId: link.resultId, storeId, error: words(error) })
          }
        }
      })
    } catch (error) {
      for (const link of links) {
        if (done.some((each) => each.resultId === link.resultId)) continue
        failedAt.set(link.id, now.getTime())
        done.push({ resultId: link.resultId, storeId, error: words(error) })
      }
    }
  }

  return done
}

function words(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

/** Where a page's or a token's files went, by result id. */
export async function savedPlaces(
  ctx: VaultContext,
  where: { uploadLinkId?: string; resultIds?: string[] },
): Promise<Map<string, { storeId: string; path: string | null }>> {
  const rows = await db().fileLink.findMany({
    where: {
      vaultId: ctx.vaultId,
      kind: "upload",
      storeId: { not: null },
      receivedAt: { not: null },
      ...(where.uploadLinkId ? { uploadLinkId: where.uploadLinkId } : {}),
      ...(where.resultIds ? { resultId: { in: where.resultIds } } : {}),
    },
    select: {
      id: true,
      resultId: true,
      storeId: true,
      storePath: true,
      deliveredAt: true,
    },
  })

  return new Map(
    rows.map((row) => [
      row.resultId,
      {
        storeId: row.storeId!,
        path: row.deliveredAt ? openStorePath(ctx, row) : null,
      },
    ]),
  )
}
