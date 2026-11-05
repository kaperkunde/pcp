import type { CallToolResult } from "@modelcontextprotocol/server"

import type { McpServer, StorageRoot } from "@/lib/generated/prisma/client"

import { storeTools, type SyncResult } from "../catalogue"
import type { VaultContext } from "../context"
import { asBytes, CryptoError } from "../crypto"
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
import { roomForLink } from "../file-links"
import { shareRefusal, shareStoreFile } from "../store-links"
import { handleOf, type BytesKeeper, type ResultOpener } from "../tool-results"
import {
  argumentsResult,
  familyError,
  refusalOf,
  withNotes,
} from "../tools/family"
import { newKey, unwrapStoreKey, wrapStoreKey } from "./crypt"
import { openEncryptedFolder } from "./encrypted"
import { openFolder, type StorageFolder } from "./files"
import { DEFAULT_FIND_RESULTS, MAX_GET_TEXT_CHARS } from "./limits"
import { ensureLocalStoreDir, localFs } from "./local"
import { globMatcher, normalizeRootPath, splitPath } from "./paths"
import { storeRoom } from "./quota"
import { FileTooLargeError, type RemoteFs } from "./sftp"
import { isStorageWrite, storageTool, storageTools } from "./tools"

/**
 * Stores: servers of kind "storage", each a place assistants read and write
 * files in. A store's backend is a folder on one of the owner's SSH
 * servers, over SFTP on PCP's own SSH connection (ssh/client.ts openSftp),
 * or PCP's own data folder (the local store, one per vault, which PCP makes
 * itself: ensureOwnStore). Its mode is plain (the files as they are, which
 * other apps read too) or encrypted (opaque objects and an encrypted index,
 * encrypted.ts). Only the owner adds or changes one, on its SSH server's
 * page: there is no register_server for it, as for the SSH server itself;
 * and only the owner converts one either way (convert.ts).
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
  /** The SSH server; null for the local store, or once it was deleted. */
  host: McpServer | null
}

/**
 * Opens the store's backend for one request: an SFTP session on its SSH
 * server, or the data folder for the local store.
 */
export type StorageConnect = () => Promise<RemoteFs>

export type StoreBackend = "sftp" | "local"
export type StoreMode = "plain" | "encrypted"

export function isLocalStore(root: Pick<StorageRoot, "backend">): boolean {
  return root.backend === "local"
}

export function isEncryptedStore(root: Pick<StorageRoot, "mode">): boolean {
  return root.mode === "encrypted"
}

/** The local store's backend: the data folder, no key needed. */
export const localConnect: StorageConnect = async () => localFs()

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
  const loaded = await loadStorageRoot(ctx, id)

  if (isLocalStore(loaded.root)) {
    throw new PcpError(
      "state",
      "PCP's own store is in its data folder: its name and description are changed like any server's.",
    )
  }

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
      `This is ${kindNoun(server.kind)}, not a store.`,
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
  backend: StoreBackend
  mode: StoreMode
  /** While the owner converts it: the mode it is going to. */
  converting: StoreMode | null
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
    backend: isLocalStore(root) ? "local" : "sftp",
    mode: isEncryptedStore(root) ? "encrypted" : "plain",
    converting:
      root.converting === "encrypted" || root.converting === "plain"
        ? root.converting
        : null,
    loginDiffers:
      !isLocalStore(root) && root.writeAs !== "" && root.writeAs !== login,
    status: server.status,
    statusMessage: server.statusMessage,
  }
}

export function storageRootView(loaded: LoadedStorage): StorageRootView {
  return viewOf(loaded.server, loaded.root, loaded.host)
}

function toolsOf(loaded: LoadedStorage) {
  return storageTools({
    where: isLocalStore(loaded.root)
      ? `${loaded.server.name}, PCP's own store`
      : `the folder ${loaded.root.path} on ${loaded.host?.name ?? "its SSH server"}`,
    encrypted: isEncryptedStore(loaded.root),
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

  if (isLocalStore(loaded.root)) {
    return null
  }

  if (!host) {
    return `${server.name}'s SSH server is no longer in PCP, so PCP cannot reach the folder. The owner adds the folder again on an SSH server's page.`
  }

  if (!host.sshHostKey) {
    return `PCP has not pinned ${host.name}'s host key yet, so it does not connect: the owner checks the SSH server on its page first.\n${pageOf(host, publicUrl)}`
  }

  return null
}

/** The store's folder on its backend, as configured. */
export async function storePath(loaded: LoadedStorage): Promise<string> {
  return isLocalStore(loaded.root)
    ? ensureLocalStoreDir(loaded.server.id)
    : loaded.root.path
}

/** The store key, for an encrypted store, unwrapped for this request. */
export function storeKeyOf(ctx: VaultContext, loaded: LoadedStorage): Buffer {
  if (!loaded.root.storeKey) {
    throw new PcpError("state", `${loaded.server.name} has lost its key.`)
  }

  return unwrapStoreKey(ctx.dek, loaded.server.id, loaded.root.storeKey)
}

/** A new store key, wrapped under the vault key, for the row. */
export function newWrappedStoreKey(
  ctx: VaultContext,
  serverId: string,
): Uint8Array<ArrayBuffer> {
  return asBytes(wrapStoreKey(ctx.dek, serverId, newKey()))
}

/** A store being converted refuses everything but its conversion. */
export function convertingRefusal(loaded: LoadedStorage): string | null {
  const to = loaded.root.converting

  return to === "encrypted" || to === "plain"
    ? `${loaded.server.name} is being ${to === "encrypted" ? "encrypted" : "decrypted"}: the owner finishes that on its page in PCP, and its files are there again after.`
    : null
}

/**
 * Opens a store on a session `connect` makes: its files, plain or
 * encrypted, behind the same calls. `end` closes the session; until then a
 * stream read from it may go on (a download).
 */
export async function openStoreFolder(
  ctx: VaultContext,
  loaded: LoadedStorage,
  connect: StorageConnect,
  { converting = false }: { converting?: boolean } = {},
): Promise<{ folder: StorageFolder; fs: RemoteFs; end: () => void }> {
  const refusal = convertingRefusal(loaded)

  if (refusal && !converting) {
    throw new PcpError("state", refusal)
  }

  const fs = await connect()

  try {
    const path = await storePath(loaded)
    const folder = isEncryptedStore(loaded.root)
      ? await openEncrypted(ctx, loaded, fs, path)
      : await openFolder(fs, path, { umask: loaded.root.umask })
    return { folder, fs, end: () => fs.end() }
  } catch (error) {
    fs.end()
    throw error
  }
}

/** An encrypted store's index and objects, its folder checked first. */
export async function openEncrypted(
  ctx: VaultContext,
  loaded: LoadedStorage,
  fs: RemoteFs,
  path: string,
): Promise<StorageFolder> {
  // The folder itself is checked as a plain one is (there, a folder); its
  // real path is where the objects go.
  const top = await openFolder(fs, path, { umask: loaded.root.umask })

  return openEncryptedFolder(
    ctx,
    {
      serverId: loaded.server.id,
      storeKey: storeKeyOf(ctx, loaded),
      rootReal: top.rootReal,
      umask: loaded.root.umask,
      room: () => storeRoom(loaded),
    },
    fs,
  )
}

/** Opens the store on a session `connect` makes, and closes it after. */
export async function withFolder<T>(
  ctx: VaultContext,
  loaded: LoadedStorage,
  connect: StorageConnect,
  run: (folder: StorageFolder) => Promise<T>,
): Promise<T> {
  const { folder, end } = await openStoreFolder(ctx, loaded, connect)

  try {
    return await run(folder)
  } finally {
    end()
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
  ctx: VaultContext,
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
    await withFolder(ctx, loaded, connect, async (folder) => {
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
      const message = isLocalStore(loaded.root)
        ? error.message
        : `${loaded.root.path}: ${error.message}`
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
  ctx: VaultContext,
  loaded: LoadedStorage,
  toolName: string,
  args: Record<string, unknown>,
  {
    connect,
    publicUrl,
    tokenId,
    keepBytes,
    open,
  }: {
    connect: StorageConnect
    publicUrl: string
    /** The token calling: share_file's link is its own. */
    tokenId?: string
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

    // A link only for a token that moves files by link, with room for one.
    if (toolName === "share_file") {
      const refused = await shareRefusal(ctx, tokenId)

      if (refused) {
        return familyError(refused, "forbidden", { notes })
      }

      await roomForLink(ctx, tokenId!, new Date())
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

  const unreachable =
    unreachableReason(loaded, publicUrl) ?? convertingRefusal(loaded)

  if (unreachable) {
    return familyError(unreachable, "state", { notes })
  }

  if (upload) {
    const room = await storeRoom(loaded)

    if (room !== null && upload.length > room) {
      return familyError(
        `${server.name} has room for ${bytesWords(Math.max(0, room))} more bytes, less than that file. Delete files there, or the owner raises the store's size in PCP's settings, under Resources.`,
        "state",
        { notes },
      )
    }
  }

  try {
    const value = await withFolder(ctx, loaded, connect, (folder) =>
      toolName === "share_file"
        ? shareFile(ctx, folder, loaded, a, {
            tokenId: tokenId!,
            publicUrl,
            fileBytes,
          })
        : runTool(folder, loaded, toolName, a, {
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
    // A stored file that does not open was changed outside PCP: the
    // store itself is reachable.
    if (error instanceof CryptoError) {
      return familyError(
        `${server.name}: ${error.message}. It was changed outside PCP; nothing was read.`,
        "state",
        { notes },
      )
    }

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

/** share_file: a public link to one file (store-links.ts). */
async function shareFile(
  ctx: VaultContext,
  folder: StorageFolder,
  loaded: LoadedStorage,
  a: Record<string, unknown>,
  {
    tokenId,
    publicUrl,
    fileBytes,
  }: { tokenId: string; publicUrl: string; fileBytes: number },
): Promise<unknown> {
  const link = await shareStoreFile(ctx, {
    tokenId,
    publicUrl,
    storeId: loaded.server.id,
    folder,
    // PCP's own store, encrypted: read in place with the file's key alone.
    // Anywhere else only a request with PCP's key reaches it: copied now.
    direct: isLocalStore(loaded.root) && isEncryptedStore(loaded.root),
    path: typeof a.path === "string" ? a.path : "",
    minutes:
      typeof a.expires_in_minutes === "number"
        ? a.expires_in_minutes
        : undefined,
    downloads:
      typeof a.max_downloads === "number" ? a.max_downloads : undefined,
    maxBytes: fileBytes,
  })

  return {
    url: link.url,
    name: link.name,
    type: link.mediaType,
    size: link.size,
    expiresAt: link.expiresAt.toISOString(),
    downloads: link.maxDownloads,
    note: link.copied
      ? "Anyone holding the link can download the file until it expires: give it only to whom it is for. PCP copied the file for the link, so later changes to it do not reach the link."
      : "Anyone holding the link can download the file until it expires: give it only to whom it is for. The link ends early if the file is changed or deleted.",
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

// ---- PCP's own store --------------------------------------------------------

/** The name PCP gives its own store. */
export const OWN_STORE_NAME = "PCP files"
const OWN_STORE_DESCRIPTION =
  "PCP's own file store, in its data folder on this machine: files kept for good, encrypted, until they are deleted."

/** The vault's local store's server id, or null when there is none yet. */
export async function findOwnStore(ctx: VaultContext): Promise<string | null> {
  const row = await db().storageRoot.findFirst({
    where: { backend: "local", server: { vaultId: ctx.vaultId } },
    select: { serverId: true },
    orderBy: { createdAt: "asc" },
  })

  return row?.serverId ?? null
}

const making = new Map<string, Promise<string>>()

/**
 * PCP's own store, made when the vault has none: at setup, and for a vault
 * from before stores on its first request. Encrypted, in the data folder,
 * with its tools; one per vault (two requests at once make one).
 */
export async function ensureOwnStore(ctx: VaultContext): Promise<string> {
  const found = await findOwnStore(ctx)

  if (found) {
    return found
  }

  const pending = making.get(ctx.vaultId)

  if (pending) {
    return pending
  }

  const made = (async () => {
    const again = await findOwnStore(ctx)

    if (again) {
      return again
    }

    const id = newId()

    await db().mcpServer.create({
      data: {
        id,
        vaultId: ctx.vaultId,
        kind: "storage",
        slug: await uniqueSlug(ctx.vaultId, slugify(OWN_STORE_NAME)),
        name: OWN_STORE_NAME,
        description: OWN_STORE_DESCRIPTION,
        url: STORAGE_URL,
        status: "ok",
        storageRoot: {
          create: {
            path: "",
            backend: "local",
            mode: "encrypted",
            storeKey: newWrappedStoreKey(ctx, id),
            umask: 0o077,
          },
        },
      },
    })
    await storeTools(id, toolsOf(await loadStorageRoot(ctx, id)))
    return id
  })()

  making.set(ctx.vaultId, made)

  try {
    return await made
  } finally {
    making.delete(ctx.vaultId)
  }
}

/** Every store of the vault, for the owner's Files pages. */
export async function listStores(
  ctx: VaultContext,
): Promise<StorageRootView[]> {
  const rows = await db().storageRoot.findMany({
    where: { server: { vaultId: ctx.vaultId } },
    include: { server: true, host: true },
  })

  return rows
    .map((row) => viewOf(row.server, row, row.host))
    .sort((a, b) =>
      a.backend !== b.backend
        ? a.backend === "local"
          ? -1
          : 1
        : a.name.localeCompare(b.name),
    )
}
