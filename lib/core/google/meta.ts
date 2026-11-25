import type { VaultContext } from "../context"
import { asBytes, decryptString, encryptString } from "../crypto"
import { db } from "../db"
import { PcpError } from "../errors"
import { newId } from "../ids"
import { setServerStatus } from "../servers"
import { writeServer } from "../server-meta"
import {
  defaultGoogleProducts,
  isGoogleProductId,
  type GoogleProductId,
} from "./products"

/**
 * The vault's Google sign-in (an `oauth_account` row, provider "google"):
 * what is kept in the row's sealed meta, and the plain facts around it. No
 * secret is read here: the client's secret and the tokens are decrypted in
 * secrets.ts and used in upstream.ts only.
 */

export const GOOGLE_PROVIDER = "google"

export type GoogleStatus = "disconnected" | "connected" | "needs_reconnect"

/** What the row seals (AES-256-GCM, "oauth_account:<id>"). */
export type GoogleMeta = {
  /** The owner's OAuth client ID with Google. */
  clientId: string
  /** The products the owner chose, which have a server each. */
  products: GoogleProductId[]
  /** The scopes Google granted, as it last said. */
  granted: string[]
  /** The Google account PCP is signed in as, when Google said. */
  email: string | null
}

export type GoogleAccount = GoogleMeta & {
  id: string
  vaultId: string
  status: GoogleStatus
  connectedAt: Date | null
  clientSecretId: string | null
  tokensId: string | null
}

const BLANK: GoogleMeta = {
  clientId: "",
  products: defaultGoogleProducts(),
  granted: [],
  email: null,
}

export function accountAad(id: string): string {
  return `oauth_account:${id}`
}

export function sealMeta(
  ctx: VaultContext,
  id: string,
  meta: GoogleMeta,
): Uint8Array<ArrayBuffer> {
  return asBytes(encryptString(ctx.dek, JSON.stringify(meta), accountAad(id)))
}

function openMeta(ctx: VaultContext, id: string, blob: Uint8Array): GoogleMeta {
  try {
    const raw = JSON.parse(
      decryptString(ctx.dek, Buffer.from(blob), accountAad(id)),
    ) as Partial<GoogleMeta>

    return {
      clientId: typeof raw.clientId === "string" ? raw.clientId : "",
      products: (Array.isArray(raw.products) ? raw.products : []).filter(
        (product): product is GoogleProductId =>
          typeof product === "string" && isGoogleProductId(product),
      ),
      granted: (Array.isArray(raw.granted) ? raw.granted : []).filter(
        (scope): scope is string => typeof scope === "string",
      ),
      email: typeof raw.email === "string" ? raw.email : null,
    }
  } catch {
    return { ...BLANK, products: [] }
  }
}

function toStatus(value: string): GoogleStatus {
  return value === "connected" || value === "needs_reconnect"
    ? value
    : "disconnected"
}

type Row = NonNullable<Awaited<ReturnType<typeof findRow>>>

function findRow(vaultId: string) {
  return db().oAuthAccount.findUnique({
    where: { vaultId_provider: { vaultId, provider: GOOGLE_PROVIDER } },
  })
}

function open(ctx: VaultContext, row: Row): GoogleAccount {
  return {
    ...openMeta(ctx, row.id, row.meta),
    id: row.id,
    vaultId: row.vaultId,
    status: toStatus(row.status),
    connectedAt: row.connectedAt,
    clientSecretId: row.clientSecretId,
    tokensId: row.tokensId,
  }
}

/** The vault's Google sign-in, or null while the owner has set none up. */
export async function loadGoogleAccount(
  ctx: VaultContext,
): Promise<GoogleAccount | null> {
  const row = await findRow(ctx.vaultId)

  return row ? open(ctx, row) : null
}

/** A Google account by id, of this vault. */
export async function requireGoogleAccountById(
  ctx: VaultContext,
  id: string,
): Promise<GoogleAccount> {
  const row = await db().oAuthAccount.findFirst({
    where: { id, vaultId: ctx.vaultId, provider: GOOGLE_PROVIDER },
  })

  if (!row) {
    throw new PcpError("state", "Google is not set up in PCP.")
  }

  return open(ctx, row)
}

/** Writes the sealed part and the plain columns of the account. */
export async function writeGoogleAccount(
  ctx: VaultContext,
  id: string,
  change: Partial<GoogleMeta> & {
    status?: GoogleStatus
    connectedAt?: Date | null
    clientSecretId?: string | null
    tokensId?: string | null
  },
): Promise<GoogleAccount> {
  const { status, connectedAt, clientSecretId, tokensId, ...meta } = change

  return db().$transaction(async (tx) => {
    const row = await tx.oAuthAccount.findFirst({
      where: { id, vaultId: ctx.vaultId },
    })

    if (!row) {
      throw new PcpError("state", "Google is not set up in PCP.")
    }

    const next = { ...openMeta(ctx, id, row.meta), ...meta }
    const saved = await tx.oAuthAccount.update({
      where: { id },
      data: {
        meta: sealMeta(ctx, id, next),
        ...(status !== undefined ? { status } : {}),
        ...(connectedAt !== undefined ? { connectedAt } : {}),
        ...(clientSecretId !== undefined ? { clientSecretId } : {}),
        ...(tokensId !== undefined ? { tokensId } : {}),
      },
    })

    return open(ctx, saved)
  })
}

/** The account, made the first time the owner saves their client. */
export async function ensureGoogleAccount(
  ctx: VaultContext,
): Promise<GoogleAccount> {
  const existing = await findRow(ctx.vaultId)

  if (existing) {
    return open(ctx, existing)
  }

  const id = newId()
  const row = await db().oAuthAccount.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      provider: GOOGLE_PROVIDER,
      meta: sealMeta(ctx, id, BLANK),
    },
  })

  return open(ctx, row)
}

/** The servers bound to the account, by id. */
export async function boundServerIds(
  ctx: VaultContext,
  accountId: string,
): Promise<string[]> {
  return (
    await db().mcpServer.findMany({
      where: { vaultId: ctx.vaultId, accountId },
      select: { id: true },
    })
  ).map((server) => server.id)
}

/**
 * Makes the servers bound to the account say what the account says: signed
 * in (`oauthConnectedAt` set, which is what "connected" means for a server),
 * or not, with the status line saying to connect Google.
 */
export async function syncBoundServers(
  ctx: VaultContext,
  accountId: string,
  state: { connected: true; at: Date } | { connected: false; message: string },
): Promise<void> {
  const ids = await boundServerIds(ctx, accountId)

  for (const id of ids) {
    if (state.connected) {
      await writeServer(ctx, id, { oauthConnectedAt: state.at })
    } else {
      await writeServer(ctx, id, { oauthConnectedAt: null })
      await setServerStatus(ctx, id, "auth_required", state.message)
    }
  }
}

export const RECONNECT_MESSAGE =
  "Google needs to be connected again: open Google in PCP and choose Connect."
