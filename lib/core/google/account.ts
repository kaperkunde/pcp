import { createHash, randomBytes } from "node:crypto"

import type { VaultContext } from "../context"
import { asBytes, decryptString, encryptString, randomSecret } from "../crypto"
import { db } from "../db"
import { ensureDefinition } from "../definition-rows"
import { invalid, PcpError } from "../errors"
import { newId } from "../ids"
import { oauthRedirectUrl } from "../oauth-client"
import { SECRET_META_SELECT, secretName } from "../secret-meta"
import { resolveSecretRef } from "../secret-refs"
import {
  createSecretNamedAfter,
  deleteSecret,
  validateSecretValue,
} from "../secrets"
import { serverCreateData } from "../server-meta"
import { deleteServer, slugify, uniqueSlug } from "../servers"
import {
  exchangeGoogleCode,
  revokeGoogleSignIn,
  syncServerTools,
} from "../upstream"
import { getServer } from "../servers"
import { googleEndpoints } from "./endpoints"
import {
  boundServerIds,
  ensureGoogleAccount,
  loadGoogleAccount,
  syncBoundServers,
  writeGoogleAccount,
  type GoogleAccount,
} from "./meta"
import {
  coveredProducts,
  GOOGLE_IDENTITY_SCOPES,
  GOOGLE_PRODUCTS,
  isGoogleProductId,
  scopesOf,
  type GoogleProductId,
} from "./products"

/**
 * Connect Google once (kaperkunde/pcp#179): the owner gives PCP their own
 * Google OAuth client, ticks the products they want, and signs in to Google
 * one time. PCP then keeps one MCP server per product (Google's own, at
 * googleapis.com), all sending the account's access token.
 *
 * Only the owner does any of this, on their own page (app/(dashboard)/
 * servers/google): there is no tool an assistant calls to set up, change or
 * disconnect it, `register_server` has no way to make one, and a linked
 * repository's document never carries one. An assistant's only part is
 * what it always has: a bound server that needs connecting answers with a
 * link to that page.
 */

/** How long a sign-in in flight waits for the owner to come back. */
const STATE_TTL_MS = 15 * 60 * 1000

export const GOOGLE_CLIENT_ID_PATTERN =
  /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/

/** The consumer name the secret's scope shows for the Google account. */
export const GOOGLE_CONSUMER_NAME = "Google account"

/** What the owner gives on the Google page. */
export type GoogleSettingsInput = {
  clientId: string
  /** A text secret of the owner's, by id. */
  clientSecretId?: string | null
  /** A secret typed into the form, saved as a new one. */
  clientSecretValue?: string | null
  products: readonly string[]
}

export type GoogleSettingsResult = {
  account: GoogleAccount
  /** Products chosen whose scopes Google has not granted yet. */
  needsConsent: boolean
  /** The client changed, so the sign-in it made ended. */
  signedOut: boolean
}

function cleanProducts(products: readonly string[]): GoogleProductId[] {
  const unknown = products.find((product) => !isGoogleProductId(product))

  if (unknown !== undefined) {
    throw invalid(
      `"${unknown.slice(0, 40)}" is not a Google product PCP knows.`,
    )
  }

  return GOOGLE_PRODUCTS.filter((product) => products.includes(product.id)).map(
    (product) => product.id,
  )
}

/**
 * Picks the client secret: one of the owner's text secrets, by id, through
 * the one check a secret named for a use goes through (secret-refs.ts). The
 * owner's own pick on their page is the grant (`scope: "granted"`), so the
 * account joins the secret's scope by using it.
 */
async function pickClientSecret(
  ctx: VaultContext,
  account: GoogleAccount,
  secretId: string,
): Promise<string> {
  const row = await db().secret.findFirst({
    where: { id: secretId, vaultId: ctx.vaultId },
    select: SECRET_META_SELECT,
  })

  if (!row) {
    throw invalid("That secret does not exist.")
  }

  const resolved = await resolveSecretRef(ctx, secretName(ctx, row), {
    kind: "google_account",
    consumer: { id: account.id, name: GOOGLE_CONSUMER_NAME },
    scope: "granted",
  })

  if (!resolved) {
    throw invalid("Pick a text secret that holds the client secret.")
  }

  return resolved.id
}

/**
 * Saves the owner's client and the products they want. A client ID that
 * changes ends the sign-in it made (Google's tokens belong to the client);
 * a product taken away disables its server; a product added gets its server
 * at once when Google already granted its scopes, and otherwise waits for
 * the owner to connect (`needsConsent`).
 */
export async function saveGoogleSettings(
  ctx: VaultContext,
  input: GoogleSettingsInput,
  { publicUrl }: { publicUrl: string },
): Promise<GoogleSettingsResult> {
  const clientId = input.clientId.trim()

  if (!GOOGLE_CLIENT_ID_PATTERN.test(clientId) || clientId.length > 200) {
    throw invalid(
      "That is not a Google client ID. It ends in .apps.googleusercontent.com.",
    )
  }

  const products = cleanProducts(input.products)
  const typed = input.clientSecretValue?.trim()
  const existing = await loadGoogleAccount(ctx)

  if (!typed && !input.clientSecretId && !existing?.clientSecretId) {
    throw invalid("Give the client secret: pick one you saved, or type it.")
  }

  if (typed) {
    const problem = validateSecretValue(typed)

    if (problem) {
      throw invalid(problem)
    }
  }

  let account = await ensureGoogleAccount(ctx)

  // The new secret is made first and removed again if the rest fails, so
  // nothing is left behind that the owner did not end up with.
  const made = typed
    ? await createSecretNamedAfter(ctx, {
        base: "Google client secret",
        value: typed,
        description: `The client secret of the Google client ${clientId}.`,
      })
    : null

  try {
    const clientSecretId = made
      ? await pickClientSecret(ctx, account, made.id)
      : input.clientSecretId
        ? await pickClientSecret(ctx, account, input.clientSecretId)
        : account.clientSecretId

    const clientChanged =
      account.clientId !== "" && account.clientId !== clientId
    let signedOut = false

    if (clientChanged && account.status !== "disconnected") {
      await revokeGoogleSignIn(ctx, account.id)
      signedOut = true
    }

    const previousSecretId = account.clientSecretId
    account = await writeGoogleAccount(ctx, account.id, {
      clientId,
      products,
      clientSecretId,
    })

    // A secret the account no longer uses and PCP made for it is removed.
    if (made && previousSecretId && previousSecretId !== made.id) {
      await deleteSecret(ctx, previousSecretId).catch(() => {})
    }

    await applyProducts(ctx, account, { publicUrl })

    const covered = coveredProducts(products, account.granted)

    return {
      account: (await loadGoogleAccount(ctx)) ?? account,
      needsConsent:
        products.length > 0 &&
        (account.status !== "connected" || covered.length !== products.length),
      signedOut,
    }
  } catch (error) {
    if (made) {
      await deleteSecret(ctx, made.id).catch(() => {})
    }

    // An account this call made, whose client was never saved, goes again.
    if ((await loadGoogleAccount(ctx))?.clientId === "") {
      await db().oAuthAccount.deleteMany({ where: { id: account.id } })
    }

    throw error
  }
}

/** The address Google sends the owner back to: the one every sign-in uses. */
export function googleRedirectUrl(publicUrl: string): string {
  return oauthRedirectUrl(publicUrl)
}

type Flow = {
  verifier: string
  redirectUri: string
  products: GoogleProductId[]
  scopes: string[]
}

function flowAad(id: string): string {
  return `oauth_account_state:${id}`
}

/**
 * The address to send the owner's browser to for Google's consent: PKCE
 * (S256), the state that names this flow, offline access with a consent
 * screen (so Google hands out a refresh token), and earlier grants kept
 * (`include_granted_scopes`). No `resource`: Google's servers do not use
 * one. When Google already holds a sign-in, only what the chosen products
 * still lack is asked for.
 */
export async function startGoogleConnect(
  ctx: VaultContext,
  { publicUrl }: { publicUrl: string },
): Promise<{ redirectTo: string }> {
  const account = await loadGoogleAccount(ctx)

  if (!account || !account.clientId || !account.clientSecretId) {
    throw new PcpError(
      "state",
      "Save your Google client ID and secret first, then connect.",
    )
  }

  if (account.products.length === 0) {
    throw new PcpError("state", "Choose at least one Google product first.")
  }

  const wanted = scopesOf(account.products)
  const missing = wanted.filter((scope) => !account.granted.includes(scope))
  const scopes = [
    ...GOOGLE_IDENTITY_SCOPES,
    ...(account.status === "connected" && missing.length > 0
      ? missing
      : wanted),
  ]
  const stateId = randomSecret(24)
  const verifier = randomBytes(48).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const redirectUri = googleRedirectUrl(publicUrl)
  const flow: Flow = {
    verifier,
    redirectUri,
    products: account.products,
    scopes,
  }

  await db().oAuthAccountState.create({
    data: {
      id: stateId,
      accountId: account.id,
      data: asBytes(
        encryptString(ctx.dek, JSON.stringify(flow), flowAad(stateId)),
      ),
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  })

  const url = new URL(googleEndpoints().authorize)

  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", account.clientId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", scopes.join(" "))
  url.searchParams.set("state", stateId)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "consent")
  url.searchParams.set("include_granted_scopes", "true")

  return { redirectTo: url.toString() }
}

/** Whether this callback is a Google sign-in's, and of this vault. */
export async function googleStateFor(
  ctx: VaultContext,
  params: URLSearchParams,
): Promise<boolean> {
  const stateId = params.get("state")

  if (!stateId) {
    return false
  }

  const state = await db().oAuthAccountState.findUnique({
    where: { id: stateId },
    select: { account: { select: { vaultId: true } } },
  })

  return state !== null && state.account.vaultId === ctx.vaultId
}

function readFlow(ctx: VaultContext, id: string, blob: Uint8Array): Flow {
  try {
    return JSON.parse(
      decryptString(ctx.dek, Buffer.from(blob), flowAad(id)),
    ) as Flow
  } catch {
    throw new PcpError("state", "This sign-in link is not one PCP started.")
  }
}

/**
 * Handles Google's redirect back to PCP: the state names the flow, the code
 * is exchanged for tokens, and the servers of the chosen products are made
 * (or enabled) and read.
 */
export async function finishGoogleConnect(
  ctx: VaultContext,
  params: URLSearchParams,
  { publicUrl }: { publicUrl: string },
): Promise<{ account: GoogleAccount; added: string[] }> {
  const stateId = params.get("state") ?? ""
  const state = stateId
    ? await db().oAuthAccountState.findUnique({
        where: { id: stateId },
        include: { account: { select: { vaultId: true } } },
      })
    : null

  if (!state || state.account.vaultId !== ctx.vaultId) {
    throw new PcpError(
      "state",
      "This sign-in link is not one PCP started. Try connecting again.",
    )
  }

  const forget = () =>
    db().oAuthAccountState.deleteMany({ where: { id: stateId } })

  if (state.expiresAt.getTime() < Date.now()) {
    await forget()
    throw new PcpError(
      "state",
      "This sign-in took too long. Try connecting again.",
    )
  }

  const error = params.get("error")

  if (error) {
    await forget()
    throw new PcpError(
      "upstream",
      `Google did not connect (${error.slice(0, 60)}${error === "access_denied" ? ": you did not allow it" : ""}).`,
    )
  }

  const code = params.get("code")

  if (!code) {
    throw new PcpError("state", "The sign-in came back without a code.")
  }

  // A sign-in that names who answered must name Google (RFC 9207).
  const issuer = params.get("iss")

  if (
    issuer !== null &&
    issuer.replace(/\/+$/, "") !== googleEndpoints().issuer
  ) {
    await forget()
    throw new PcpError("state", "That sign-in did not come from Google.")
  }

  const flow = readFlow(ctx, stateId, state.data)

  try {
    const { granted, email } = await exchangeGoogleCode(ctx, state.accountId, {
      code,
      verifier: flow.verifier,
      redirectUri: flow.redirectUri,
    })
    const now = new Date()
    const account = await writeGoogleAccount(ctx, state.accountId, {
      status: "connected",
      connectedAt: now,
      granted,
      email,
    })

    await syncBoundServers(ctx, account.id, { connected: true, at: now })
    const added = await applyProducts(ctx, account, { publicUrl })

    return { account: (await loadGoogleAccount(ctx)) ?? account, added }
  } finally {
    await forget()
  }
}

/**
 * Makes the account's servers match what is chosen and granted: a server
 * for each chosen product whose scopes Google granted (made, or enabled),
 * and the servers of the products taken away disabled. Reads the tools of
 * the ones just made or enabled. Returns the names of the products added.
 */
async function applyProducts(
  ctx: VaultContext,
  account: GoogleAccount,
  { publicUrl }: { publicUrl: string },
): Promise<string[]> {
  const bound = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId, accountId: account.id },
    select: { id: true, enabled: true },
  })
  const rows = await Promise.all(
    bound.map(async (row) => ({
      id: row.id,
      enabled: row.enabled,
      url: (await getServer(ctx, row.id)).url,
    })),
  )
  const connected = account.status === "connected"
  const covered = new Set(coveredProducts(account.products, account.granted))
  const toRead: string[] = []
  const added: string[] = []

  for (const product of GOOGLE_PRODUCTS) {
    const address = googleEndpoints().mcp(product.id)
    const existing = rows.find((row) => row.url === address)

    if (!account.products.includes(product.id)) {
      if (existing?.enabled) {
        await db().mcpServer.update({
          where: { id: existing.id },
          data: { enabled: false },
        })
      }

      continue
    }

    if (!connected || !covered.has(product.id)) {
      continue
    }

    if (existing) {
      if (!existing.enabled) {
        await db().mcpServer.update({
          where: { id: existing.id },
          data: { enabled: true },
        })
        toRead.push(existing.id)
      }

      continue
    }

    const id = newId()

    await db().mcpServer.create({
      data: serverCreateData(ctx, {
        id,
        vaultId: ctx.vaultId,
        kind: "mcp",
        name: product.name,
        slug: await uniqueSlug(ctx, slugify(product.slug)),
        description: product.description,
        url: address,
        authType: "google",
        accountId: account.id,
        // Google's own servers: public addresses only, always.
        publicOnly: !googleEndpoints().privateAddresses,
        oauthConnectedAt: account.connectedAt ?? new Date(),
      }),
    })
    await ensureDefinition(ctx, id)
    toRead.push(id)
    added.push(product.name)
  }

  // Their tools, read now that PCP may. A product Google has not enabled in
  // the owner's project says so in its server's status, not here.
  await Promise.allSettled(
    toRead.map(async (id) =>
      syncServerTools(ctx, await getServer(ctx, id), { publicUrl }),
    ),
  )

  return added
}

/** Ends PCP's Google sign-in: revoked at Google, deleted here. */
export async function disconnectGoogle(
  ctx: VaultContext,
): Promise<{ revoked: boolean }> {
  const account = await loadGoogleAccount(ctx)

  if (!account) {
    throw new PcpError("state", "Google is not set up in PCP.")
  }

  return revokeGoogleSignIn(ctx, account.id)
}

/**
 * Takes Google out of PCP: signed out (and revoked), its servers removed,
 * and the client forgotten. The owner's client secret stays under Secrets,
 * which they can delete once nothing uses it.
 */
export async function removeGoogle(ctx: VaultContext): Promise<void> {
  const account = await loadGoogleAccount(ctx)

  if (!account) {
    return
  }

  if (account.status !== "disconnected") {
    await revokeGoogleSignIn(ctx, account.id)
  }

  for (const id of await boundServerIds(ctx, account.id)) {
    await deleteServer(ctx, id)
  }

  await db().oAuthAccount.delete({ where: { id: account.id } })
}

/** One product as the page shows it. */
export type GoogleProductView = {
  id: GoogleProductId
  name: string
  allows: string
  scopes: string[]
  chosen: boolean
  /** Google granted every scope it asks for. */
  granted: boolean
  server: {
    id: string
    enabled: boolean
    status: string
    toolCount: number
  } | null
}

export type GoogleView = {
  account: GoogleAccount | null
  redirectUrl: string
  products: GoogleProductView[]
  /** The client secret's name, for the form. */
  clientSecretName: string | null
}

/** What the Google page shows: the account, and each product with its server. */
export async function googleView(
  ctx: VaultContext,
  { publicUrl }: { publicUrl: string },
): Promise<GoogleView> {
  const account = await loadGoogleAccount(ctx)
  const chosen = account?.products ?? []
  const servers = account
    ? await db().mcpServer.findMany({
        where: { vaultId: ctx.vaultId, accountId: account.id },
        select: {
          id: true,
          enabled: true,
          status: true,
          _count: { select: { tools: true } },
        },
      })
    : []
  const opened = await Promise.all(
    servers.map(async (row) => ({
      row,
      url: (await getServer(ctx, row.id)).url,
    })),
  )
  const secret = account?.clientSecretId
    ? await db().secret.findFirst({
        where: { id: account.clientSecretId, vaultId: ctx.vaultId },
        select: SECRET_META_SELECT,
      })
    : null

  return {
    account,
    redirectUrl: googleRedirectUrl(publicUrl),
    clientSecretName: secret ? secretName(ctx, secret) : null,
    products: GOOGLE_PRODUCTS.map((product) => {
      const found = opened.find(
        (entry) => entry.url === googleEndpoints().mcp(product.id),
      )?.row

      return {
        id: product.id,
        name: product.name,
        allows: product.allows,
        scopes: [...product.scopes],
        chosen: account ? chosen.includes(product.id) : product.defaultOn,
        granted: product.scopes.every((scope) =>
          account?.granted.includes(scope),
        ),
        server: found
          ? {
              id: found.id,
              enabled: found.enabled,
              status: found.status,
              toolCount: found._count.tools,
            }
          : null,
      }
    }),
  }
}
