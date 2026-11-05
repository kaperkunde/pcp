"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { invalid, PcpError } from "@/lib/core/errors"
import { getServer, renameServerSlug } from "@/lib/core/servers"
import type { StorageFolder } from "@/lib/core/storage/files"
import {
  createStorageRoot,
  updateStorageRoot,
  type StorageRootInput,
} from "@/lib/core/storage/roots"
import { syncServerTools, withStorageFolder } from "@/lib/core/upstream"
import { field, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

import type { ServerActionResult } from "./servers"

/**
 * Storage folders (lib/core/storage/): the owner adds one on an SSH
 * server's page, changes it on its own, and works with its files in its
 * file browser. Checking, enabling and removing one use the server actions
 * in ./servers: a storage folder is a server to them.
 */

function inputFrom(formData: FormData): StorageRootInput {
  return {
    name: field(formData, "name"),
    description: field(formData, "description"),
    path: field(formData, "path"),
    writeAs: field(formData, "writeAs"),
    umask: field(formData, "umask"),
    readOnly: field(formData, "readOnly") === "on",
  }
}

function revalidate(id: string, hostId?: string) {
  revalidatePath("/servers")
  revalidatePath(`/servers/${id}`)
  revalidatePath(`/servers/${id}/files`)
  if (hostId) revalidatePath(`/servers/${hostId}`)
  revalidatePath("/tokens/[id]", "page")
}

/** The owner's check: the folder is there, and PCP can write in it. */
async function check(
  ctx: Awaited<ReturnType<typeof requireContext>>,
  id: string,
): Promise<string> {
  const sync = await syncServerTools(ctx, await getServer(ctx, id), {
    publicUrl: await publicUrlFor(ctx),
    byOwner: true,
  })

  return sync.status === "ok" ? "PCP reached the folder." : sync.message
}

export async function createStorageRootAction(
  hostId: string,
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const result = await guarded(() =>
    createStorageRoot(ctx, hostId, inputFrom(formData)),
  )

  if (result.status !== "ok" || !result.id) {
    return result
  }

  await check(ctx, result.id)
  revalidate(result.id, hostId)
  redirect(`/servers/${result.id}`)
}

export async function updateStorageRootAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const id = field(formData, "id")

  const result = await guarded(async () => {
    await updateStorageRoot(ctx, id, inputFrom(formData))

    const slug = field(formData, "slug")
    if (slug) {
      await renameServerSlug(ctx, id, slug)
    }

    return { message: `Saved. ${await check(ctx, id)}` }
  })

  revalidate(id)
  return result
}

// ---- The file browser ------------------------------------------------------

export type FileActionResult = ServerActionResult

/** A path inside the folder, joined from where the browser is and a name. */
function inside(folder: string, name: string): string {
  const clean = name.trim()

  if (!clean || clean.includes("/")) {
    throw invalid("Enter a name, without a slash.")
  }

  return folder ? `${folder}/${clean}` : clean
}

/** Every action here changes files: a read-only folder refuses them all. */
async function inFolder<T>(
  id: string,
  run: (folder: StorageFolder) => Promise<T>,
): Promise<T> {
  const ctx = await requireContext()

  return withStorageFolder(
    ctx,
    id,
    { publicUrl: await publicUrlFor(ctx) },
    (folder, loaded) => {
      if (loaded.server.readOnly) {
        throw new PcpError(
          "forbidden",
          "This folder is read-only in PCP: turn that off under Advanced to change files here.",
        )
      }

      return run(folder)
    },
  )
}

/** Files the owner picked, saved into the folder the browser shows. */
export async function uploadFilesAction(
  id: string,
  folderPath: string,
  _previous: FileActionResult,
  formData: FormData,
): Promise<FileActionResult> {
  const result = await guarded(async () => {
    const files = formData
      .getAll("files")
      .filter((value): value is File => value instanceof File && value.size > 0)

    if (files.length === 0) {
      throw invalid("Choose a file to upload.")
    }

    const overwrite = field(formData, "overwrite") === "on"

    await inFolder(id, async (folder) => {
      for (const upload of files) {
        await folder.save(
          inside(folderPath, upload.name),
          Buffer.from(await upload.arrayBuffer()),
          { overwrite },
        )
      }
    })

    return {
      message: `Uploaded ${files.length === 1 ? files[0]!.name : `${files.length} files`}.`,
    }
  })

  revalidatePath(`/servers/${id}/files`)
  return result
}

export async function makeFolderAction(
  id: string,
  folderPath: string,
  _previous: FileActionResult,
  formData: FormData,
): Promise<FileActionResult> {
  const result = await guarded(async () => {
    const made = await inFolder(id, (folder) =>
      folder.makeFolder(inside(folderPath, field(formData, "name")), {
        parents: false,
      }),
    )

    return {
      message: made.existed ? "That folder is there already." : "Made.",
    }
  })

  revalidatePath(`/servers/${id}/files`)
  return result
}

/** Renames an entry in place, or moves it to another path in the folder. */
export async function moveEntryAction(
  id: string,
  from: string,
  _previous: FileActionResult,
  formData: FormData,
): Promise<FileActionResult> {
  const result = await guarded(async () => {
    const to = field(formData, "to").trim().replace(/^\/+/, "")

    if (!to) {
      throw invalid("Enter the new name or path.")
    }

    const moved = await inFolder(id, (folder) =>
      folder.move(from, to, { overwrite: false }),
    )
    return { message: `Moved to ${moved.to}.` }
  })

  revalidatePath(`/servers/${id}/files`)
  return result
}

export async function deleteEntryAction(
  id: string,
  path: string,
  recursive: boolean,
): Promise<FileActionResult> {
  const result = await guarded(async () => {
    const removed = await inFolder(id, (folder) =>
      folder.remove(path, { recursive }),
    )
    return { message: `Deleted ${removed.path}.` }
  })

  revalidatePath(`/servers/${id}/files`)
  return result
}
