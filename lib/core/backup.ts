import { gunzipSync, gzipSync } from "node:zlib"

import type { HostSetting, Prisma } from "@/lib/generated/prisma/client"

import {
  checkReferences,
  EnvelopeSchema,
  EXPORT_AAD,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  type ExportedHostKey,
  type ExportPayload,
  type ExportPayloadJson,
  type ExportPreview,
  isExportedHostKey,
  PayloadSchema,
  previewOf,
  RESTORE_CHUNK_ROWS,
  RESTORE_SPEC_CHUNK_ROWS,
  rowJson,
} from "./backup-format"
import {
  EXPORT_FILE_SUFFIX,
  MAX_EXPORT_FILE_BYTES,
  MAX_EXPORT_PAYLOAD_BYTES,
} from "./constants"
import type { VaultContext } from "./context"
import {
  CryptoError,
  decrypt,
  deriveKek,
  encrypt,
  newScryptParams,
} from "./crypto"
import { db } from "./db"
import { invalid, isPcpError, PcpError } from "./errors"
import { listMigrations } from "./migrate"
import { DDNS_CONFIG_KEY, DDNS_STATUS_KEY } from "./network/ddns"
import { TLS_CONFIG_KEY, TLS_STATUS_KEY } from "./network/tls"
import { SETTING_PUBLIC_URL } from "./settings"
import { validatePassword } from "./vault"
import { PCP_VERSION } from "./version"

/**
 * Exporting everything PCP holds to one file, and restoring from one.
 *
 * The export is the vault's rows as they are (lib/core/backup-format.ts):
 * nothing is decrypted to make it, and the data key leaves only wrapped, in
 * the grants for the password, the recovery key and the API tokens, so those
 * three keep working wherever the file is restored. The rows are compressed
 * and encrypted under the export password, with scrypt as for the password
 * grant. Reading the file takes that password; reading what is in it then
 * takes one of the vault's own credentials, as it does on disk.
 *
 * A restore replaces: the vault it is aimed at (or the empty database of a
 * PCP not set up yet) is wiped and the file's rows written in its place, in
 * one transaction. Sessions are not in a file and do not survive one.
 */

const NOT_AN_EXPORT = "That is not a PCP export."
const DAMAGED = "That export file is damaged."
const NEWER = "This export was made by a newer PCP. Update PCP, then try again."
const WRONG_PASSWORD =
  "That export password is not right, or the file is damaged."

export type RestoreTarget =
  /** A PCP not set up yet: the file's vault becomes its owner's. */
  | { into: "fresh" }
  /** A signed-in owner's vault, replaced whole. */
  | { into: "vault"; vaultId: string }

export function exportFileName(at: Date): string {
  return `pcp-export-${at.toISOString().slice(0, 10)}${EXPORT_FILE_SUFFIX}`
}

/** The export file. Needs the vault id only: no row is decrypted. */
export async function exportVault(
  ctx: VaultContext,
  exportPassword: string,
): Promise<Buffer> {
  const problem = validatePassword(exportPassword)

  if (problem) {
    throw invalid(problem)
  }

  const payload = await readVault(ctx.vaultId)

  return encodeExport(payload, exportPassword)
}

/**
 * The vault's rows, read in one transaction so they agree with each other
 * (a token made while this runs is in the file with its key, or not at all).
 */
async function readVault(vaultId: string): Promise<ExportPayloadJson> {
  const byVault = { where: { vaultId } }
  const byServer = { where: { server: { vaultId } } }
  const byToken = { where: { token: { vaultId } } }

  return db().$transaction(
    async (tx) => {
      const vault = await tx.vault.findUniqueOrThrow({ where: { id: vaultId } })
      const settings = await tx.setting.findMany(byVault)
      const host = await tx.hostSetting.findMany({
        where: { key: { in: [DDNS_CONFIG_KEY, TLS_CONFIG_KEY] } },
      })

      return {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        pcp: PCP_VERSION,
        schema: latestMigration(),
        exportedAt: new Date().toISOString(),
        publicUrl:
          settings.find((row) => row.key === SETTING_PUBLIC_URL)?.value ?? null,
        vault: rowJson(vault),
        tables: {
          keyGrants: (
            await tx.keyGrant.findMany({
              where: {
                vaultId,
                kind: { in: ["password", "recovery", "api_token"] },
              },
            })
          ).map(rowJson),
          apiTokens: (await tx.apiToken.findMany(byVault)).map(rowJson),
          apiTokenServers: (await tx.apiTokenServer.findMany(byToken)).map(
            rowJson,
          ),
          apiTokenToolAccess: (
            await tx.apiTokenToolAccess.findMany(byToken)
          ).map(rowJson),
          vaultToolAccess: (await tx.vaultToolAccess.findMany(byVault)).map(
            rowJson,
          ),
          webFetchRules: (await tx.webFetchRule.findMany(byVault)).map(rowJson),
          permissionRequests: (
            await tx.permissionRequest.findMany(byVault)
          ).map(rowJson),
          memories: (await tx.memory.findMany(byVault)).map(rowJson),
          secrets: (await tx.secret.findMany(byVault)).map(rowJson),
          servers: (await tx.mcpServer.findMany(byVault)).map(rowJson),
          serverAuthHeaders: (await tx.serverAuthHeader.findMany(byServer)).map(
            rowJson,
          ),
          tools: (await tx.mcpTool.findMany(byServer)).map(rowJson),
          openApiSpecs: (await tx.openApiSpec.findMany(byServer)).map(rowJson),
          settings: settings.map(rowJson),
        },
        host: host.filter(isExportedHostRow).map(rowJson),
      }
    },
    { timeout: 60_000 },
  )
}

function isExportedHostRow(
  row: HostSetting,
): row is HostSetting & { key: ExportedHostKey } {
  return isExportedHostKey(row.key)
}

function latestMigration(): string {
  const names = listMigrations()
  const last = names[names.length - 1]

  if (!last) {
    throw new Error("prisma/migrations is empty")
  }

  return last
}

/** Compresses and encrypts a payload into the file. Split out for tests. */
export async function encodeExport(
  payload: ExportPayloadJson,
  exportPassword: string,
): Promise<Buffer> {
  const packed = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"))
  const kdf = newScryptParams()
  const key = await deriveKek(exportPassword, kdf)
  const envelope = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    kdf,
    data: encrypt(key, packed, EXPORT_AAD).toString("base64"),
  }

  return Buffer.from(JSON.stringify(envelope), "utf8")
}

/**
 * Opens an export file: the rows it holds, checked, and what to tell the
 * owner about them. Every way it can fail is a message for the owner.
 */
export async function readExport(
  file: Buffer,
  exportPassword: string,
): Promise<{ payload: ExportPayload; preview: ExportPreview }> {
  if (file.length > MAX_EXPORT_FILE_BYTES) {
    throw invalid(
      `That file is larger than ${MAX_EXPORT_FILE_BYTES / 1024 / 1024} MB.`,
    )
  }

  const raw = parseJson(file, NOT_AN_EXPORT)

  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as { format?: unknown }).format !== EXPORT_FORMAT
  ) {
    throw invalid(NOT_AN_EXPORT)
  }

  const { version } = raw as { version?: unknown }

  if (typeof version === "number" && version > EXPORT_VERSION) {
    throw new PcpError("state", NEWER)
  }

  const envelope = EnvelopeSchema.safeParse(raw)

  if (!envelope.success) {
    throw invalid(DAMAGED)
  }

  const key = await deriveKek(exportPassword, envelope.data.kdf)
  let packed: Buffer

  try {
    packed = decrypt(key, Buffer.from(envelope.data.data, "base64"), EXPORT_AAD)
  } catch (error) {
    if (error instanceof CryptoError) {
      throw new PcpError("unauthorized", WRONG_PASSWORD)
    }

    throw error
  }

  let json: Buffer

  try {
    json = gunzipSync(packed, { maxOutputLength: MAX_EXPORT_PAYLOAD_BYTES })
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw invalid("That export is too large to restore.")
    }

    throw invalid(DAMAGED)
  }

  const parsed = PayloadSchema.safeParse(parseJson(json, DAMAGED))

  if (!parsed.success) {
    if (
      parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")
    ) {
      throw new PcpError("state", NEWER)
    }

    const first = parsed.error.issues[0]
    throw invalid(
      `${DAMAGED} (${first ? `${first.path.join(".")}: ${first.message}` : "unreadable"})`,
    )
  }

  if (!listMigrations().includes(parsed.data.schema)) {
    throw new PcpError("state", NEWER)
  }

  checkReferences(parsed.data)

  return { payload: parsed.data, preview: previewOf(parsed.data) }
}

function parseJson(buffer: Buffer, orElse: string): unknown {
  try {
    return JSON.parse(buffer.toString("utf8"))
  } catch {
    throw invalid(orElse)
  }
}

/**
 * Writes the file's rows in place of the target's, in one transaction: the
 * target is wiped table by table (never relying on cascades alone), then
 * the rows go in, parents before children. The host's network settings are
 * replaced only when asked; the status rows describing this machine go
 * either way, since the settings they describe may be new.
 */
export async function restoreExport(
  payload: ExportPayload,
  target: RestoreTarget,
  { restoreHostSettings }: { restoreHostSettings: boolean },
): Promise<void> {
  const { vault, tables, host } = payload

  try {
    await db().$transaction(
      async (tx) => {
        if (target.into === "fresh") {
          if ((await tx.vault.count()) > 0) {
            throw new PcpError("state", "PCP is already set up.")
          }
        } else {
          const existing = await tx.vault.findUnique({
            where: { id: target.vaultId },
            select: { id: true },
          })

          if (!existing) {
            throw new PcpError("state", "The vault to replace is gone.")
          }

          await wipeVault(tx, target.vaultId)
        }

        if (restoreHostSettings) {
          await tx.hostSetting.deleteMany({
            where: {
              key: {
                in: [
                  DDNS_CONFIG_KEY,
                  DDNS_STATUS_KEY,
                  TLS_CONFIG_KEY,
                  TLS_STATUS_KEY,
                ],
              },
            },
          })
          await tx.hostSetting.createMany({ data: host })
        }

        await tx.vault.create({ data: vault })
        await inChunks(tables.keyGrants, (data) =>
          tx.keyGrant.createMany({ data }),
        )
        await inChunks(tables.apiTokens, (data) =>
          tx.apiToken.createMany({ data }),
        )
        await inChunks(tables.secrets, (data) => tx.secret.createMany({ data }))
        await inChunks(tables.servers, (data) =>
          tx.mcpServer.createMany({ data }),
        )
        await inChunks(tables.serverAuthHeaders, (data) =>
          tx.serverAuthHeader.createMany({ data }),
        )
        await inChunks(tables.tools, (data) => tx.mcpTool.createMany({ data }))
        await inChunks(
          tables.openApiSpecs,
          (data) => tx.openApiSpec.createMany({ data }),
          RESTORE_SPEC_CHUNK_ROWS,
        )
        await inChunks(tables.apiTokenServers, (data) =>
          tx.apiTokenServer.createMany({ data }),
        )
        await inChunks(tables.apiTokenToolAccess, (data) =>
          tx.apiTokenToolAccess.createMany({ data }),
        )
        await inChunks(tables.vaultToolAccess, (data) =>
          tx.vaultToolAccess.createMany({ data }),
        )
        await inChunks(tables.webFetchRules, (data) =>
          tx.webFetchRule.createMany({ data }),
        )
        await inChunks(tables.permissionRequests, (data) =>
          tx.permissionRequest.createMany({ data }),
        )
        await inChunks(tables.memories, (data) =>
          tx.memory.createMany({ data }),
        )
        await inChunks(tables.settings, (data) =>
          tx.setting.createMany({ data }),
        )
      },
      { timeout: 60_000 },
    )
  } catch (error) {
    if (isPcpError(error)) {
      throw error
    }

    throw new PcpError(
      "state",
      `The export could not be written: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Everything of one vault, children before parents. */
async function wipeVault(
  tx: Prisma.TransactionClient,
  vaultId: string,
): Promise<void> {
  const byVault = { where: { vaultId } }
  const byServer = { where: { server: { vaultId } } }
  const byToken = { where: { token: { vaultId } } }

  await tx.setting.deleteMany(byVault)
  // Answers kept for read_result are not exported: a day's cache, bound to
  // the tokens this restore replaces.
  await tx.toolResult.deleteMany(byVault)
  await tx.memory.deleteMany(byVault)
  await tx.permissionRequest.deleteMany(byVault)
  await tx.webFetchRule.deleteMany(byVault)
  await tx.vaultToolAccess.deleteMany(byVault)
  await tx.apiTokenToolAccess.deleteMany(byToken)
  await tx.apiTokenServer.deleteMany(byToken)
  await tx.oAuthState.deleteMany(byServer)
  await tx.openApiSpec.deleteMany(byServer)
  await tx.mcpTool.deleteMany(byServer)
  await tx.serverAuthHeader.deleteMany(byServer)
  await tx.mcpServer.deleteMany(byVault)
  await tx.secret.deleteMany(byVault)
  await tx.apiToken.deleteMany(byVault)
  await tx.session.deleteMany(byVault)
  await tx.keyGrant.deleteMany(byVault)
  await tx.vault.delete({ where: { id: vaultId } })
}

async function inChunks<T>(
  rows: T[],
  write: (chunk: T[]) => Promise<unknown>,
  size = RESTORE_CHUNK_ROWS,
): Promise<void> {
  for (let at = 0; at < rows.length; at += size) {
    await write(rows.slice(at, at + size))
  }
}
