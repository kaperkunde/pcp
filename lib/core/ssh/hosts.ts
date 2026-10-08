import { isIP } from "node:net"

import type { CallToolResult } from "@modelcontextprotocol/server"

import type { McpServer } from "@/lib/generated/prisma/client"

import { storeTools, type SyncResult } from "../catalogue"
import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, isPcpError, PcpError } from "../errors"
import { newId } from "../ids"
import { errorToolResult, jsonToolResult } from "../json-result"
import { makeRedactor } from "../openapi/redact"
import {
  getServer,
  kindNoun,
  normalizeNameAndDescription,
  setServerStatus,
  slugify,
  uniqueSlug,
} from "../servers"
import { deleteManagedSecret, writeManagedSecret } from "../secrets"
import {
  SshAuthError,
  SshHostKeyError,
  sshCheck,
  sshExec,
  type HostSeen,
  type SshIdentity,
  type SshTarget,
} from "./client"
import { fingerprint, generateOwnKey, keyType } from "./keys"
import { MAX_OUTPUT_BYTES, MAX_USERNAME_CHARS } from "./limits"
import { parseRunCommand, RUN_COMMAND, sshTools } from "./tools"

/**
 * SSH servers: servers of kind "ssh", which an assistant runs commands on.
 * Only the owner adds one, in PCP: there is no register_server for it, since
 * a shell on a machine is more than any assistant should be able to ask
 * for in a sentence.
 *
 * PCP signs in with a key of its own, never a password: an Ed25519 key made
 * for each server, kept as a managed secret that only upstream.ts decrypts,
 * whose public half the owner adds to the login's authorized_keys. The
 * server's host key is pinned the first time PCP finishes a key exchange
 * with it, and shown to the owner; another key is refused until they forget
 * the pinned one. Nothing here reads the private key: upstream.ts hands in
 * an SshIdentity.
 */

export const DEFAULT_SSH_PORT = 22

export type SshServerInput = {
  name: string
  description?: string
  /** A host name or address, optionally with :port or as ssh://host:port. */
  host: string
  /** Overrides a port in `host`; empty is 22. */
  port?: string | number | null
  username: string
}

export type SshAddress = { host: string; port: number }

const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

function parsePort(raw: string | number): number {
  const port = typeof raw === "number" ? raw : Number(raw.trim())

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalid("The port is a number from 1 to 65535.")
  }

  return port
}

/** Where the server is: a host name or address, and a port. */
export function parseSshAddress(
  raw: string,
  portOverride?: string | number | null,
): SshAddress {
  let text = raw.trim()

  if (!text) {
    throw invalid("Enter the server's host name or address.")
  }

  if (text.startsWith("ssh://")) {
    text = text.slice("ssh://".length).replace(/\/$/, "")
  }

  if (text.includes("@")) {
    throw invalid("Enter the login in its own field, not as user@host.")
  }

  let host = text
  let port: number = DEFAULT_SSH_PORT
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text)

  if (bracketed) {
    host = bracketed[1]!
    port = bracketed[2] ? parsePort(bracketed[2]) : DEFAULT_SSH_PORT
  } else if (text.split(":").length === 2) {
    const [name, number] = text.split(":")
    host = name!
    port = parsePort(number!)
  }

  host = host.toLowerCase()

  if (isIP(host) === 0 && !HOST_NAME.test(host)) {
    throw invalid(
      "Enter a host name (like build.example.com) or an IP address.",
    )
  }

  if (
    portOverride !== undefined &&
    portOverride !== null &&
    String(portOverride).trim() !== ""
  ) {
    port = parsePort(portOverride)
  }

  return { host, port }
}

export function formatSshAddress({ host, port }: SshAddress): string {
  return `ssh://${host.includes(":") ? `[${host}]` : host}:${port}`
}

/** The login, as POSIX and OpenSSH allow one (and Active Directory's @). */
export function validateLogin(raw: string): string {
  const login = raw.trim()

  if (!login) {
    throw invalid("Enter the login PCP signs in as.")
  }

  if (login.length > MAX_USERNAME_CHARS) {
    throw invalid(`Keep the login under ${MAX_USERNAME_CHARS} characters.`)
  }

  if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*\$?$/.test(login)) {
    throw invalid(
      "A login uses letters, digits, dots, dashes, underscores and @, and does not start with a dash or a dot.",
    )
  }

  return login
}

function normalize(input: SshServerInput) {
  const { name, description } = normalizeNameAndDescription(input)

  return {
    name,
    description,
    url: formatSshAddress(parseSshAddress(input.host, input.port)),
    authUsername: validateLogin(input.username),
  }
}

/** The managed secret holding a server's key: named after it, like OAuth's. */
export function sshKeySecretName(serverId: string): string {
  return `ssh/${serverId}`
}

/** What the owner does before PCP can sign in, for a login. */
function addKeyNote(username: string): string {
  return `Add PCP's key to ${username}'s ~/.ssh/authorized_keys on the server, then check the sign-in.`
}

/**
 * Adds an SSH server, with a new key of PCP's own for it. Nothing can sign
 * in until the owner adds that key on the server.
 */
export async function createSshServer(
  ctx: VaultContext,
  input: SshServerInput,
): Promise<{ id: string }> {
  const data = normalize(input)
  const id = newId()
  const slug = await uniqueSlug(ctx.vaultId, slugify(data.name))
  const key = generateOwnKey(`pcp-${slug}`)
  const secret = await writeManagedSecret(ctx, {
    name: sshKeySecretName(id),
    description: `PCP's SSH key for ${data.name}.`,
    value: key.privateKey,
    kind: "ssh_key",
  })

  try {
    await db().mcpServer.create({
      data: {
        id,
        vaultId: ctx.vaultId,
        kind: "ssh",
        slug,
        ...data,
        authType: "key",
        authSecretId: secret.id,
        sshPublicKey: key.publicKey,
      },
    })
  } catch (error) {
    await deleteManagedSecret(ctx, secret.id)
    throw error
  }

  return { id }
}

async function sshServer(ctx: VaultContext, id: string) {
  const existing = await getServer(ctx, id)

  if (existing.kind !== "ssh") {
    throw new PcpError(
      "state",
      `This is ${kindNoun(existing.kind)}; change it in its own settings.`,
    )
  }

  return existing
}

/**
 * Saves a server's settings. Another address is another host: its key is
 * pinned afresh. `reconnect` says it should be checked again.
 */
export async function updateSshServer(
  ctx: VaultContext,
  id: string,
  input: SshServerInput,
): Promise<{ reconnect: boolean }> {
  const existing = await sshServer(ctx, id)
  const data = normalize(input)
  const moved = data.url !== existing.url

  await db().mcpServer.update({
    where: { id },
    data: { ...data, ...(moved ? { sshHostKey: null } : {}) },
  })

  return { reconnect: moved || data.authUsername !== existing.authUsername }
}

/**
 * Forgets the pinned host key, for a server whose key was changed on
 * purpose: the next connection pins the key it shows then.
 */
export async function forgetSshHostKey(
  ctx: VaultContext,
  id: string,
): Promise<void> {
  await sshServer(ctx, id)
  await db().mcpServer.update({
    where: { id },
    data: { sshHostKey: null, status: "unknown", statusMessage: "" },
  })
}

/**
 * Makes PCP a new key for the server, for when the old one may have been
 * seen. The owner adds the new one on the server (and removes the old).
 */
export async function replaceSshKey(
  ctx: VaultContext,
  id: string,
): Promise<void> {
  const existing = await sshServer(ctx, id)
  const key = generateOwnKey(`pcp-${existing.slug}`)
  const secret = await writeManagedSecret(ctx, {
    name: sshKeySecretName(id),
    description: `PCP's SSH key for ${existing.name}.`,
    value: key.privateKey,
    kind: "ssh_key",
  })

  await db().mcpServer.update({
    where: { id },
    data: {
      authSecretId: secret.id,
      sshPublicKey: key.publicKey,
      status: "auth_required",
      statusMessage: addKeyNote(existing.authUsername ?? ""),
    },
  })
}

/** What the server's page shows: nothing of it is secret. */
export type SshServerView = {
  host: string
  port: number
  username: string
  publicKey: string
  publicKeyFingerprint: string
  /** The pinned host key; null until PCP first connected. */
  hostKey: { type: string; fingerprint: string } | null
}

export function sshServerView(
  server: Pick<
    McpServer,
    "url" | "authUsername" | "sshPublicKey" | "sshHostKey"
  >,
): SshServerView {
  const address = parseSshAddress(server.url)

  return {
    host: address.host,
    port: address.port,
    username: server.authUsername ?? "",
    publicKey: server.sshPublicKey ?? "",
    publicKeyFingerprint: server.sshPublicKey
      ? fingerprint(server.sshPublicKey)
      : "",
    hostKey: server.sshHostKey
      ? {
          type: keyType(server.sshHostKey),
          fingerprint: fingerprint(server.sshHostKey),
        }
      : null,
  }
}

/** Where to connect, as whom, and the host key to expect. */
export function sshTarget(server: McpServer): SshTarget {
  return {
    ...parseSshAddress(server.url),
    username: server.authUsername ?? "",
    hostKey: server.sshHostKey,
  }
}

/**
 * Pins the host key a connection proved, the first time there is one. Only
 * while the row still has no key and the same address, so a key seen for
 * an address the owner has since changed is not kept for the new one.
 */
function pinner(server: McpServer) {
  return async (seen: HostSeen) => {
    if (server.sshHostKey || !seen.hostKey) {
      return
    }

    await db().mcpServer.updateMany({
      where: { id: server.id, sshHostKey: null, url: server.url },
      data: { sshHostKey: seen.hostKey },
    })
  }
}

/** The server's page in PCP, where its key and host key are. */
function pageOf(server: McpServer, publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/servers/${server.id}`
}

function seconds(ms: number): string {
  const count = ms / 1000
  return `${count} second${count === 1 ? "" : "s"}`
}

/** The status and the words for the assistant, from a failure. */
async function fail(
  server: McpServer,
  error: unknown,
  { publicUrl, redact }: { publicUrl: string; redact: string[] },
): Promise<{ status: "auth_required" | "error"; message: string }> {
  const scrub = makeRedactor(redact)
  const reason = scrub
    .text(error instanceof Error ? error.message : String(error))
    .slice(0, 400)

  if (error instanceof SshAuthError) {
    await setServerStatus(server.id, "auth_required", reason)
    return {
      status: "auth_required",
      message: `${server.name} did not let PCP sign in. ${reason} The owner finds PCP's key on its page:\n${pageOf(server, publicUrl)}`,
    }
  }

  if (error instanceof SshHostKeyError) {
    await setServerStatus(server.id, "error", reason)
    return {
      status: "error",
      message: `PCP did not connect. ${reason} Its page:\n${pageOf(server, publicUrl)}`,
    }
  }

  const message = `${server.name} could not be reached: ${reason}`
  await setServerStatus(server.id, "error", message)
  return { status: "error", message }
}

/**
 * Stores the server's tool and checks that PCP can sign in, pinning the
 * host key on the first connection.
 */
export async function syncSshTools(
  server: McpServer,
  identity: SshIdentity,
  { publicUrl }: { publicUrl: string },
): Promise<SyncResult> {
  const target = sshTarget(server)
  const toolCount = await storeTools(
    server.id,
    sshTools({ host: target.host, username: target.username }),
  )

  try {
    await sshCheck(target, identity, pinner(server))
    await setServerStatus(server.id, "ok", "", { lastSyncedAt: new Date() })
    return { status: "ok", message: "", toolCount }
  } catch (error) {
    if (isPcpError(error)) {
      throw error
    }

    if (error instanceof SshAuthError) {
      const message = `${server.name} turned down PCP's key. ${addKeyNote(target.username)}`
      await setServerStatus(server.id, "auth_required", message)
      return { status: "auth_required", message, toolCount }
    }

    return {
      ...(await fail(server, error, { publicUrl, redact: [] })),
      toolCount,
    }
  }
}

/**
 * Runs a call to the server's tool. The arguments are checked before
 * anything connects; what the command writes is passed on as it is, with
 * anything in `redact` (a wrapper's secret placed in the call) taken out.
 */
export async function callSshTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  {
    identity,
    publicUrl,
    redact = [],
  }: {
    identity: SshIdentity
    publicUrl: string
    redact?: string[]
  },
): Promise<CallToolResult> {
  if (toolName !== RUN_COMMAND) {
    throw invalid(`${server.name} has no tool called ${toolName}.`)
  }

  const call = parseRunCommand(args)

  try {
    const result = await sshExec(
      sshTarget(server),
      identity,
      {
        command: call.command,
        stdin: call.stdin,
        timeoutMs: call.timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      },
      pinner(server),
    )

    if (server.status !== "ok") {
      await setServerStatus(server.id, "ok", "", { lastSyncedAt: new Date() })
    }

    return jsonToolResult(
      {
        exit_code: result.exitCode,
        ...(result.signal ? { signal: result.signal } : {}),
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
        ...(result.truncated
          ? {
              truncated: `The command wrote more than ${MAX_OUTPUT_BYTES / 1024 / 1024} MB: PCP asked the server to end it and disconnected. This is what it wrote first.`,
            }
          : {}),
        ...(result.timedOut
          ? {
              timed_out: `The command ran past its ${seconds(call.timeoutMs)}: PCP asked the server to end it and disconnected.`,
            }
          : {}),
      },
      { redact },
    )
  } catch (error) {
    if (isPcpError(error)) {
      throw error
    }

    const failure = await fail(server, error, { publicUrl, redact })

    // What the owner has to fix (PCP's key, a changed host key) is answered
    // with their page's link; a server PCP could not reach is an error.
    if (error instanceof SshAuthError || error instanceof SshHostKeyError) {
      return errorToolResult(failure.message, { redact })
    }

    throw new PcpError("upstream", failure.message)
  }
}
