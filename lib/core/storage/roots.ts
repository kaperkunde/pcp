import type { CallToolResult } from "@modelcontextprotocol/server"

import type { McpServer, StorageRoot } from "@/lib/generated/prisma/client"

import { storeTools, type SyncResult } from "../catalogue"
import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, isPcpError, PcpError } from "../errors"
import { newId } from "../ids"
import { jsonToolResult } from "../json-result"
import {
  bareType,
  decodeText,
  charsetOf,
  fileMediaType,
  isTextType,
} from "../media-types"
import { markdownLink } from "../owner-link"
import { loadResourceLimits } from "../resources/state"
import { missingResultMessage } from "../result-handles"
import {
  getServer,
  kindNoun,
  normalizeNameAndDescription,
  setServerStatus,
  slugify,
  STORAGE_URL,
  uniqueSlug,
} from "../servers"
import { SshAuthError, SshHostKeyError } from "../ssh/client"
import { validateLogin } from "../ssh/hosts"
import { handleOf, type BytesKeeper, type ResultOpener } from "../tool-results"
import {
  argumentsResult,
  familyError,
  refusalOf,
  withNotes,
} from "../tools/family"
import { openFolder, type StorageFolder } from "./files"
import { DEFAULT_FIND_RESULTS, MAX_GET_TEXT_CHARS } from "./limits"
import { globMatcher, normalizeRootPath, splitPath } from "./paths"
import { FileTooLargeError, type RemoteFs } from "./sftp"
import { isStorageWrite, storageTool, storageTools } from "./tools"

/**
 * Storage roots: servers of kind "storage", each a folder on one of the
 * owner's SSH servers that assistants read and write files in, over SFTP
 * on PCP's own SSH connection (ssh/client.ts openSftp). Only the owner adds
 * or changes one, on its SSH server's page: there is no register_server for
 * it, as for the SSH server itself.
 *
 * Every path is confined to the root by files.ts. SFTP writes as the SSH
 * login: "write as" names whose files the owner wants these to be, and the
 * page says when that is not the login (PCP adds no sudo); the umask is
 * PCP's own, set on what it makes. Nothing here reads PCP's key:
 * upstream.ts hands in a way to open an SFTP session (`connect`), on a
 * host whose key the owner pinned, with the key a request handed in.
 */

export type StorageRootInput = {
  name: string
  description?: string
  /** The folder, an absolute path on the SSH server. */
  path: string
  /** Whose files these should be; empty is the SSH login. */
  writeAs?: string | null
  /** As an octal text ("002") or a number; empty is 002. */
  umask?: string | number | null
  readOnly: boolean
}

export type LoadedStorage = {
  server: McpServer
  root: StorageRoot
  /** The SSH server; null once it was deleted. */
  host: McpServer | null
}

/** Opens an SFTP session on the root's SSH server, for one request. */
export type StorageConnect = () => Promise<RemoteFs>

const DEFAULT_UMASK = 0o002

export function parseUmask(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return DEFAULT_UMASK
  }

  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0 || raw > 0o777) {
      throw invalid("A umask is three octal digits, like 002 or 022.")
    }
    return raw
  }

  const text = raw.trim()

  if (!/^0?[0-7]{1,3}$/.test(text)) {
    throw invalid("A umask is three octal digits, like 002 or 022.")
  }

  return Number.parseInt(text, 8)
}

export function formatUmask(umask: number): string {
  return umask.toString(8).padStart(3, "0")
}

function normalize(input: StorageRootInput) {
  const { name, description } = normalizeNameAndDescription(input)
  const writeAs = (input.writeAs ?? "").trim()

  return {
    name,
    description,
    path: normalizeRootPath(input.path),
    writeAs: writeAs === "" ? "" : validateLogin(writeAs),
    umask: parseUmask(input.umask),
    readOnly: input.readOnly,
  }
}

async function sshHost(ctx: VaultContext, hostId: string): Promise<McpServer> {
  const host = await db().mcpServer.findFirst({
    where: { id: hostId, vaultId: ctx.vaultId },
  })

  if (!host || host.kind !== "ssh") {
    throw invalid("Choose one of your SSH servers for the folder.")
  }

  return host
}

/** Adds a folder on an SSH server as a storage root, with its tools. */
export async function createStorageRoot(
  ctx: VaultContext,
  hostId: string,
  input: StorageRootInput,
): Promise<{ id: string }> {
  const host = await sshHost(ctx, hostId)
  const data = normalize(input)
  const id = newId()

  await db().mcpServer.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      kind: "storage",
      slug: await uniqueSlug(ctx.vaultId, slugify(data.name)),
      name: data.name,
      description: data.description,
      url: STORAGE_URL,
      readOnly: data.readOnly,
      storageRoot: {
        create: {
          hostId: host.id,
          path: data.path,
          writeAs: data.writeAs,
          umask: data.umask,
        },
      },
    },
  })

  const loaded = await loadStorageRoot(ctx, id)
  await storeTools(id, toolsOf(loaded))
  return { id }
}

/** Saves a root's settings; its tools follow read-only. */
export async function updateStorageRoot(
  ctx: VaultContext,
  id: string,
  input: StorageRootInput,
): Promise<void> {
  await loadStorageRoot(ctx, id)
  const data = normalize(input)

  await db().mcpServer.update({
    where: { id },
    data: {
      name: data.name,
      description: data.description,
      readOnly: data.readOnly,
      storageRoot: {
        update: { path: data.path, writeAs: data.writeAs, umask: data.umask },
      },
    },
  })
  await storeTools(id, toolsOf(await loadStorageRoot(ctx, id)))
}

export async function loadStorageRoot(
  ctx: VaultContext,
  id: string,
): Promise<LoadedStorage> {
  const server = await getServer(ctx, id)

  if (server.kind !== "storage") {
    throw new PcpError(
      "state",
      `This is ${kindNoun(server.kind)}, not a storage folder.`,
    )
  }

  const root = await db().storageRoot.findUnique({
    where: { serverId: id },
    include: { host: true },
  })

  if (!root) {
    throw new PcpError("state", `${server.name} has lost its folder settings.`)
  }

  const { host, ...own } = root
  return { server, root: own, host }
}

/** The roots on one SSH server, for its page. */
export async function listStorageRoots(
  ctx: VaultContext,
  hostId: string,
): Promise<StorageRootView[]> {
  const rows = await db().storageRoot.findMany({
    where: { hostId, server: { vaultId: ctx.vaultId } },
    include: { server: true, host: true },
    orderBy: { path: "asc" },
  })

  return rows.map((row) => viewOf(row.server, row, row.host))
}

export type StorageRootView = {
  id: string
  name: string
  path: string
  writeAs: string
  umask: string
  readOnly: boolean
  host: { id: string; name: string; login: string } | null
  /** "write as" names someone else than the SSH login. */
  loginDiffers: boolean
  status: string
  statusMessage: string
}

function viewOf(
  server: McpServer,
  root: StorageRoot,
  host: McpServer | null,
): StorageRootView {
  const login = host?.authUsername ?? ""

  return {
    id: server.id,
    name: server.name,
    path: root.path,
    writeAs: root.writeAs,
    umask: formatUmask(root.umask),
    readOnly: server.readOnly,
    host: host ? { id: host.id, name: host.name, login } : null,
    loginDiffers: root.writeAs !== "" && root.writeAs !== login,
    status: server.status,
    statusMessage: server.statusMessage,
  }
}

export function storageRootView(loaded: LoadedStorage): StorageRootView {
  return viewOf(loaded.server, loaded.root, loaded.host)
}

function toolsOf(loaded: LoadedStorage) {
  return storageTools({
    folder: loaded.root.path,
    host: loaded.host?.name ?? "its SSH server",
    readOnly: loaded.server.readOnly,
  })
}

function pageOf(server: Pick<McpServer, "id" | "name">, publicUrl: string) {
  return markdownLink(
    `Open ${server.name}'s page in PCP`,
    `${publicUrl.replace(/\/+$/, "")}/servers/${server.id}`,
  )
}

/**
 * Why PCP does not reach the root now, for an assistant, or null when it
 * can: its SSH server gone, or its host key not pinned by the owner yet.
 */
export function unreachableReason(
  loaded: LoadedStorage,
  publicUrl: string,
): string | null {
  const { server, host } = loaded

  if (!host) {
    return `${server.name}'s SSH server is no longer in PCP, so PCP cannot reach the folder. The owner adds the folder again on an SSH server's page.`
  }

  if (!host.sshHostKey) {
    return `PCP has not pinned ${host.name}'s host key yet, so it does not connect: the owner checks the SSH server on its page first.\n${pageOf(host, publicUrl)}`
  }

  return null
}

/** Opens the root's folder on a session `connect` makes, and closes it after. */
export async function withFolder<T>(
  loaded: LoadedStorage,
  connect: StorageConnect,
  run: (folder: StorageFolder) => Promise<T>,
): Promise<T> {
  const fs = await connect()

  try {
    const folder = await openFolder(fs, loaded.root.path, {
      umask: loaded.root.umask,
    })
    return await run(folder)
  } finally {
    fs.end()
  }
}

/** A connection failure as the root's status and words for the assistant. */
async function failure(
  loaded: LoadedStorage,
  error: unknown,
  publicUrl: string,
): Promise<{ status: "auth_required" | "error"; message: string }> {
  const reason = (error instanceof Error ? error.message : String(error)).slice(
    0,
    400,
  )
  const host = loaded.host!

  if (error instanceof SshAuthError) {
    const message = `${host.name} did not let PCP sign in. ${reason} The owner finds PCP's key on its page:\n${pageOf(host, publicUrl)}`
    await setServerStatus(loaded.server.id, "auth_required", message)
    return { status: "auth_required", message }
  }

  if (error instanceof SshHostKeyError) {
    const message = `PCP did not connect. ${reason} Its page:\n${pageOf(host, publicUrl)}`
    await setServerStatus(loaded.server.id, "error", message)
    return { status: "error", message }
  }

  const message = `${loaded.server.name} could not be reached: ${reason}`
  await setServerStatus(loaded.server.id, "error", message)
  return { status: "error", message }
}

/**
 * Stores the root's tools. When the owner asked (`connect` given), checks
 * that the folder is there and, unless it is read-only, that PCP can write
 * in it. A read for an assistant only stores the tools.
 */
export async function syncStorageTools(
  loaded: LoadedStorage,
  connect: StorageConnect | null,
  { publicUrl }: { publicUrl: string },
): Promise<SyncResult> {
  const toolCount = await storeTools(loaded.server.id, toolsOf(loaded))
  const unreachable = unreachableReason(loaded, publicUrl)

  if (unreachable) {
    await setServerStatus(loaded.server.id, "error", unreachable)
    return { status: "error", message: unreachable, toolCount }
  }

  if (!connect) {
    return {
      status: loaded.server.status === "ok" ? "ok" : "error",
      message: loaded.server.statusMessage,
      toolCount,
    }
  }

  try {
    await withFolder(loaded, connect, async (folder) => {
      if (!loaded.server.readOnly) {
        await folder.probeWrite()
      }
    })
    await setServerStatus(loaded.server.id, "ok", "", {
      lastSyncedAt: new Date(),
    })
    return { status: "ok", message: "", toolCount }
  } catch (error) {
    if (isPcpError(error)) {
      const message = `${loaded.root.path}: ${error.message}`
      await setServerStatus(loaded.server.id, "error", message)
      return { status: "error", message, toolCount }
    }

    return { ...(await failure(loaded, error, publicUrl)), toolCount }
  }
}

function bytesWords(count: number): string {
  return new Intl.NumberFormat("en").format(count)
}

/**
 * Runs one of a root's tools for an assistant. The arguments are checked
 * before anything connects; a file to save is read from the token's kept
 * results before anything connects too (`open`), and a file read is kept
 * for the token (`keepBytes`), never passed through the answer whole.
 */
export async function callStorageTool(
  loaded: LoadedStorage,
  toolName: string,
  args: Record<string, unknown>,
  {
    connect,
    publicUrl,
    keepBytes,
    open,
  }: {
    connect: StorageConnect
    publicUrl: string
    keepBytes?: BytesKeeper
    open?: ResultOpener
  },
): Promise<CallToolResult> {
  const { server } = loaded
  const tool = storageTool(toolName)
  const label = `${server.slug}/${toolName}`

  if (!tool) {
    return familyError(
      `${server.name} has no tool called ${toolName}.`,
      "not_found",
    )
  }

  if (server.readOnly && isStorageWrite(toolName)) {
    return familyError(
      `${server.name} is read-only in PCP; ${toolName} would change files.`,
      "forbidden",
    )
  }

  const checked = tool.check(args)

  if (!checked.fits) {
    return argumentsResult(label, checked.problems, { notes: checked.notes })
  }

  const a = checked.args as Record<string, unknown>
  const notes = checked.notes
  let matcher: ((name: string) => boolean) | null = null
  let upload: Buffer | null = null
  const { fileBytes } = await loadResourceLimits()

  try {
    // Every path is read before anything connects: `..` never reaches
    // the server.
    for (const key of ["path", "from", "to"]) {
      if (typeof a[key] === "string") splitPath(a[key])
    }

    if (toolName === "find_files") {
      matcher = globMatcher(String(a.name), {
        caseSensitive: a.case_sensitive === true,
      })
    }

    // Read before anything connects: an unknown id writes nothing.
    if (toolName === "save_file") {
      if (a.text !== undefined) {
        upload = Buffer.from(String(a.text), "utf8")
      } else {
        const id = (a.file as { $result: string }).$result

        if (!open) {
          throw invalid(
            "save_file's file is a result PCP kept for this token, and this call cannot read it.",
          )
        }

        const opened = await open(id)

        if (!opened) {
          throw invalid(missingResultMessage())
        }

        upload = opened.bytes()
      }

      if (upload.length > fileBytes) {
        throw invalid(
          `That file is ${bytesWords(upload.length)} bytes, more than PCP saves at once (${bytesWords(fileBytes)}). The owner can raise that in PCP's settings, under Resources.`,
        )
      }
    }
  } catch (error) {
    const refused = refusalOf(error, label, notes)
    if (refused) return refused
    throw error
  }

  const unreachable = unreachableReason(loaded, publicUrl)

  if (unreachable) {
    return familyError(unreachable, "state", { notes })
  }

  try {
    const value = await withFolder(loaded, connect, (folder) =>
      runTool(folder, loaded, toolName, a, {
        matcher,
        upload,
        fileBytes,
        keepBytes,
      }),
    )

    if (server.status !== "ok") {
      await setServerStatus(server.id, "ok", "", { lastSyncedAt: new Date() })
    }

    return withNotes(jsonToolResult(value), notes)
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      return familyError(
        `That file is ${bytesWords(error.readSoFar)} bytes or more, more than PCP keeps of one file (${bytesWords(fileBytes)}). The owner can raise that in PCP's settings, under Resources.`,
        "validation",
        { notes },
      )
    }

    const refused = refusalOf(error, label, notes)
    if (refused) return refused

    if (isPcpError(error)) throw error

    const failed = await failure(loaded, error, publicUrl)

    if (error instanceof SshAuthError || error instanceof SshHostKeyError) {
      return familyError(failed.message, "state", { notes })
    }

    throw new PcpError("upstream", failed.message)
  }
}

async function runTool(
  folder: StorageFolder,
  loaded: LoadedStorage,
  toolName: string,
  a: Record<string, unknown>,
  {
    matcher,
    upload,
    fileBytes,
    keepBytes,
  }: {
    matcher: ((name: string) => boolean) | null
    upload: Buffer | null
    fileBytes: number
    keepBytes?: BytesKeeper
  },
): Promise<unknown> {
  const path = typeof a.path === "string" ? a.path : ""

  switch (toolName) {
    case "list_folder":
      return folder.list(
        path,
        typeof a.limit === "number" ? a.limit : undefined,
      )

    case "find_files":
      return folder.find(path, matcher!, {
        type: a.type === "file" || a.type === "folder" ? a.type : undefined,
        limit: typeof a.limit === "number" ? a.limit : DEFAULT_FIND_RESULTS,
      })

    case "get_file": {
      const read = await folder.read(path, fileBytes)
      const type = fileMediaType(read.name, read.bytes)
      const text = isTextType(type)
        ? decodeText(read.bytes, charsetOf(type))
        : null
      const meta = {
        path: read.path,
        name: read.name,
        size: read.bytes.length,
        type: bareType(type),
        modified: read.modified,
      }

      if (!keepBytes) {
        if (text === null) {
          throw new PcpError(
            "state",
            `${read.name} is ${bareType(type)}; PCP passes on a file like this only as a kept result, which this call cannot make.`,
          )
        }

        return { ...meta, text }
      }

      const kept = await keepBytes({
        bytes: read.bytes,
        mediaType: type,
        name: read.name,
        serverId: loaded.server.id,
        toolName,
      })

      return {
        ...meta,
        result: handleOf(kept),
        ...(text === null
          ? {
              note: `PCP keeps this file for you: pass {"$result": "${kept.id}"} where a tool wants it (save_file's file, send_email's attachments, the browser's upload_file, an API's file field), or read it in a program with pcp.read.`,
            }
          : {
              text: text.slice(0, MAX_GET_TEXT_CHARS),
              truncated: text.length > MAX_GET_TEXT_CHARS,
            }),
      }
    }

    case "save_file": {
      const saved = await folder.save(path, upload!, {
        overwrite: a.overwrite === true,
      })
      return { ...saved, saved: saved.replaced ? "replaced" : "created" }
    }

    case "make_folder":
      return folder.makeFolder(path, { parents: a.parents === true })

    case "move":
      return folder.move(String(a.from), String(a.to), {
        overwrite: a.overwrite === true,
      })

    case "delete":
      return folder.remove(path, { recursive: a.recursive === true })
  }

  throw new PcpError("not_found", `There is no tool called ${toolName}.`)
}
