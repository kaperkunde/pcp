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
  SshHostError,
  defaultSshDeps,
  sshCheck,
  sshExec,
  type SshDeps,
  type SshIdentity,
  type SshTarget,
} from "./client"
import {
  certificateDate,
  certificateProblem,
  fingerprint,
  generateOwnKey,
  parseCertificateLine,
  parsePublicKeyLine,
  parsePublicKeyLines,
  publicKeyLine,
  type SshCertificate,
} from "./keys"
import {
  MAX_CA_TEXT_CHARS,
  MAX_CERTIFICATE_CHARS,
  MAX_HOST_CAS,
  MAX_OUTPUT_BYTES,
  MAX_USERNAME_CHARS,
} from "./limits"
import { parseRunCommand, RUN_COMMAND, sshTools } from "./tools"
import { SshFormatError } from "./wire"

/**
 * SSH servers: servers of kind "ssh", which an assistant runs commands on.
 * Only the owner adds one, in PCP: there is no register_server for it, since
 * a shell on a machine is more than any assistant should be able to ask
 * for in a sentence.
 *
 * Signing in is by certificate only, both ways (client.ts). PCP makes its
 * own Ed25519 key for each server, kept as a managed secret that only
 * upstream.ts decrypts; the owner signs its public half with their user CA
 * and pastes the certificate back. The host proves itself with a host
 * certificate from a CA the owner gave. Nothing here reads the private key:
 * upstream.ts hands in an SshIdentity.
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
  /** The host CA keys, one OpenSSH line each. */
  hostCas: string
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

/** The host CA keys, as PCP stores them: one canonical line each. */
export function normalizeHostCas(text: string): string {
  if (text.length > MAX_CA_TEXT_CHARS) {
    throw invalid("That is more text than CA keys take.")
  }

  let keys

  try {
    keys = parsePublicKeyLines(text)
  } catch (error) {
    throw invalid(
      `A host CA key cannot be read: ${error instanceof Error ? error.message : "it is malformed"}`,
    )
  }

  if (keys.length === 0) {
    throw invalid(
      "Paste the public key of the CA that signs this server's host certificate (the .pub file, or its @cert-authority line from known_hosts).",
    )
  }

  if (keys.length > MAX_HOST_CAS) {
    throw invalid(`Give at most ${MAX_HOST_CAS} host CA keys.`)
  }

  const lines = [...new Set(keys.map((key) => publicKeyLine(key)))]
  return lines.join("\n")
}

function normalize(input: SshServerInput) {
  const { name, description } = normalizeNameAndDescription(input)

  return {
    name,
    description,
    url: formatSshAddress(parseSshAddress(input.host, input.port)),
    authUsername: validateLogin(input.username),
    sshHostCas: normalizeHostCas(input.hostCas),
  }
}

/** The managed secret holding a server's key: named after it, like OAuth's. */
export function sshKeySecretName(serverId: string): string {
  return `ssh/${serverId}`
}

const AWAITING_CERTIFICATE =
  "Waiting for a certificate: sign PCP's key with your user CA and paste it on this page."

/**
 * Adds an SSH server, with a new key of PCP's own for it. It has no
 * certificate yet, so nothing can run until the owner pastes one.
 */
export async function createSshServer(
  ctx: VaultContext,
  input: SshServerInput,
): Promise<{ id: string }> {
  const data = normalize(input)
  const id = newId()
  const slug = await uniqueSlug(ctx.vaultId, slugify(data.name))
  const { privatePem, key } = generateOwnKey()
  const secret = await writeManagedSecret(ctx, {
    name: sshKeySecretName(id),
    description: `PCP's SSH key for ${data.name}.`,
    value: privatePem,
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
        authType: "certificate",
        authSecretId: secret.id,
        sshPublicKey: publicKeyLine(key.publicKey, `pcp-${slug}`),
        status: "auth_required",
        statusMessage: AWAITING_CERTIFICATE,
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
 * Saves a server's settings. `reconnect` says it should be checked again:
 * its address, login or host CAs changed.
 */
export async function updateSshServer(
  ctx: VaultContext,
  id: string,
  input: SshServerInput,
): Promise<{ reconnect: boolean }> {
  const existing = await sshServer(ctx, id)
  const data = normalize(input)

  await db().mcpServer.update({ where: { id }, data })

  return {
    reconnect:
      data.url !== existing.url ||
      data.authUsername !== existing.authUsername ||
      data.sshHostCas !== existing.sshHostCas,
  }
}

/**
 * Takes the certificate the owner's CA made for PCP's key. It must be a
 * user certificate for that very key and this login, and valid now or
 * later; whether the server trusts its CA, only signing in tells.
 */
export async function setSshCertificate(
  ctx: VaultContext,
  id: string,
  text: string,
): Promise<void> {
  const existing = await sshServer(ctx, id)
  const line = text.trim()

  if (!line) {
    throw invalid(
      "Paste the certificate ssh-keygen wrote (the -cert.pub file).",
    )
  }

  if (line.length > MAX_CERTIFICATE_CHARS) {
    throw invalid("That is more text than a certificate takes.")
  }

  let certificate: SshCertificate

  try {
    certificate = parseCertificateLine(line)
  } catch (error) {
    throw invalid(
      `The certificate cannot be read: ${error instanceof Error ? error.message : "it is malformed"}`,
    )
  }

  const own = existing.sshPublicKey
    ? parsePublicKeyLine(existing.sshPublicKey)
    : null

  if (!own || !certificate.publicKey.blob.equals(own.blob)) {
    throw invalid(
      "That certificate is for another key. Sign the key shown on this page (PCP's), not one of yours.",
    )
  }

  const problem = certificateProblemFor(
    certificate,
    existing.authUsername ?? "",
    {
      // A certificate that starts later is kept; it is used once it is valid.
      allowFuture: true,
    },
  )

  if (problem) {
    throw invalid(`That certificate cannot be used. ${problem}`)
  }

  await db().mcpServer.update({
    where: { id },
    data: {
      sshCertificate: certificateLineOf(line),
      status: "unknown",
      statusMessage: "",
    },
  })
}

/** The line as stored: type and base64, without the comment. */
function certificateLineOf(line: string): string {
  return line.split(/\s+/).slice(0, 2).join(" ")
}

function certificateProblemFor(
  certificate: SshCertificate,
  username: string,
  { allowFuture = false }: { allowFuture?: boolean } = {},
): string | null {
  const now = new Date()
  const at = allowFuture
    ? new Date(
        Math.max(
          now.getTime(),
          (certificateDate(certificate.validAfter)?.getTime() ?? 0) + 1000,
        ),
      )
    : now

  return identityProblemOf(certificate, username, at)
}

/** Type, dates and principal; the key is checked where it is known. */
function identityProblemOf(
  certificate: SshCertificate,
  username: string,
  now: Date,
): string | null {
  return certificateProblem(certificate, {
    type: "user",
    principal: username,
    authorities: null,
    now,
  })
}

/**
 * Makes PCP a new key for the server, for when the old one may have been
 * seen. Its certificate goes with it: the owner signs the new key.
 */
export async function replaceSshKey(
  ctx: VaultContext,
  id: string,
): Promise<void> {
  const existing = await sshServer(ctx, id)
  const { privatePem, key } = generateOwnKey()
  const secret = await writeManagedSecret(ctx, {
    name: sshKeySecretName(id),
    description: `PCP's SSH key for ${existing.name}.`,
    value: privatePem,
    kind: "ssh_key",
  })

  await db().mcpServer.update({
    where: { id },
    data: {
      authSecretId: secret.id,
      sshPublicKey: publicKeyLine(key.publicKey, `pcp-${existing.slug}`),
      sshCertificate: null,
      status: "auth_required",
      statusMessage: AWAITING_CERTIFICATE,
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
  hostCas: Array<{ line: string; fingerprint: string }>
  certificate: {
    line: string
    keyId: string
    serial: string
    principals: string[]
    validAfter: Date | null
    validBefore: Date | null
    criticalOptions: Array<{ name: string; value: string }>
    extensions: string[]
    authority: string
    /** Why it cannot be used now; null when it can. */
    problem: string | null
  } | null
}

export function sshServerView(
  server: Pick<
    McpServer,
    "url" | "authUsername" | "sshPublicKey" | "sshHostCas" | "sshCertificate"
  >,
  now = new Date(),
): SshServerView {
  const address = parseSshAddress(server.url)
  const own = server.sshPublicKey
    ? parsePublicKeyLine(server.sshPublicKey)
    : null
  let certificate: SshServerView["certificate"] = null

  if (server.sshCertificate) {
    try {
      const read = parseCertificateLine(server.sshCertificate)
      certificate = {
        line: server.sshCertificate,
        keyId: read.keyId,
        serial: read.serial.toString(),
        principals: read.principals,
        validAfter: certificateDate(read.validAfter),
        validBefore: certificateDate(read.validBefore),
        criticalOptions: read.criticalOptions,
        extensions: read.extensions,
        authority: fingerprint(read.signatureKey),
        problem:
          own && !read.publicKey.blob.equals(own.blob)
            ? "It is for another key than PCP's."
            : identityProblemOf(read, server.authUsername ?? "", now),
      }
    } catch (error) {
      certificate = {
        line: server.sshCertificate,
        keyId: "",
        serial: "",
        principals: [],
        validAfter: null,
        validBefore: null,
        criticalOptions: [],
        extensions: [],
        authority: "",
        problem:
          error instanceof SshFormatError
            ? error.message
            : "It cannot be read.",
      }
    }
  }

  return {
    host: address.host,
    port: address.port,
    username: server.authUsername ?? "",
    publicKey: server.sshPublicKey ?? "",
    publicKeyFingerprint: own ? fingerprint(own) : "",
    hostCas: (server.sshHostCas ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => ({
        line,
        fingerprint: fingerprint(parsePublicKeyLine(line)),
      })),
    certificate,
  }
}

/** Where to connect and whom to trust, from the server's row. */
export function sshTarget(server: McpServer): SshTarget {
  const address = parseSshAddress(server.url)

  return {
    ...address,
    username: server.authUsername ?? "",
    hostAuthorities: parsePublicKeyLines(server.sshHostCas ?? ""),
  }
}

function seconds(ms: number): string {
  const count = ms / 1000
  return `${count} second${count === 1 ? "" : "s"}`
}

/** The server's page in PCP, where its certificate is pasted. */
function pageOf(server: McpServer, publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/servers/${server.id}`
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
      message: `${server.name} did not let PCP sign in. ${reason} The owner gives PCP a new certificate on its page:\n${pageOf(server, publicUrl)}`,
    }
  }

  if (error instanceof SshHostError) {
    await setServerStatus(server.id, "error", reason)
    return {
      status: "error",
      message: `PCP did not connect: ${reason} The owner checks the server's host CA on its page:\n${pageOf(server, publicUrl)}`,
    }
  }

  const message = `${server.name} could not be reached: ${reason}`
  await setServerStatus(server.id, "error", message)
  return { status: "error", message }
}

/**
 * Stores the server's tool and checks that PCP can sign in. Without a
 * certificate the tool is there, and answers that the owner has to give one.
 */
export async function syncSshTools(
  server: McpServer,
  identity: SshIdentity | null,
  { publicUrl, deps = defaultSshDeps }: { publicUrl: string; deps?: SshDeps },
): Promise<SyncResult> {
  const target = sshTarget(server)
  const toolCount = await storeTools(
    server.id,
    sshTools({ host: target.host, username: target.username }),
  )

  if (!identity) {
    await setServerStatus(server.id, "auth_required", AWAITING_CERTIFICATE)
    return { status: "auth_required", message: AWAITING_CERTIFICATE, toolCount }
  }

  try {
    await sshCheck(target, identity, deps)
    await setServerStatus(server.id, "ok", "", { lastSyncedAt: new Date() })
    return { status: "ok", message: "", toolCount }
  } catch (error) {
    if (isPcpError(error)) {
      throw error
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
    deps = defaultSshDeps,
  }: {
    identity: SshIdentity | null
    publicUrl: string
    redact?: string[]
    deps?: SshDeps
  },
): Promise<CallToolResult> {
  if (toolName !== RUN_COMMAND) {
    throw invalid(`${server.name} has no tool called ${toolName}.`)
  }

  const call = parseRunCommand(args)

  if (!identity) {
    return errorToolResult(
      `${server.name} has no certificate for PCP yet, so nothing can run there. The owner signs PCP's key and pastes the certificate on its page:\n${pageOf(server, publicUrl)}`,
    )
  }

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
      deps,
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

    // What the owner has to fix (the certificate, the host's) is answered
    // with their page's link; a server PCP could not reach is an error.
    if (error instanceof SshAuthError || error instanceof SshHostError) {
      return errorToolResult(failure.message, { redact })
    }

    throw new PcpError("upstream", failure.message)
  }
}
