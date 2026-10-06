import { randomSecret, safeEqual, sha256Hex } from "../crypto"
import { db } from "../db"
import { isLocalHostname } from "../local-address"
import { describeFetchError, discard, readCapped } from "../openapi/http"
import { send } from "../openapi/transport"
import { PCP_VERSION } from "../version"
import { invalidClient, OAuthError } from "./errors"
import {
  MAX_CLIENT_NAME_LENGTH,
  MAX_METADATA_DOCUMENT_BYTES,
  MAX_REDIRECT_URIS,
  MAX_UNUSED_REGISTRATIONS,
  MAX_URI_LENGTH,
  METADATA_DOCUMENT_TIMEOUT_MS,
  UNUSED_REGISTRATION_TTL_MS,
} from "./limits"

/**
 * The clients of PCP's authorization server: the assistants that may ask
 * the owner to sign them in. There are two kinds, and neither gets anything
 * until the owner approves a sign-in on PCP's page:
 *
 * - A client whose client_id is the https URL of its metadata document
 *   (Client ID Metadata Documents, which Claude uses). PCP reads the
 *   document when the owner is shown the request, and again when they
 *   approve it, from public addresses only, following no redirect. Nothing
 *   about it is stored apart from the token it ends up with.
 * - A client that registered itself (RFC 7591). Anyone may register, so
 *   registrations no sign-in has used are pruned after a day and their
 *   number is capped. A client secret, when it asked for one, is kept as
 *   its SHA-256.
 */

export type AuthMethod = "none" | "client_secret_basic" | "client_secret_post"

export type OAuthClientInfo = {
  id: string
  /** What the client calls itself. Anyone can say "Claude". */
  name: string
  redirectUris: string[]
  authMethod: AuthMethod
  /** The client_id is the URL of its metadata document. */
  fromDocument: boolean
  /**
   * The host the client really is: its document's host, or for a
   * registered client the host its first redirect URI sends the owner to.
   */
  host: string
}

/** How a request to the token or revocation endpoint authenticated. */
export type ClientCredentials = {
  clientId: string | null
  secret: string | null
  method: AuthMethod
}

export type DocumentFetcher = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>

/** Public addresses only, checked as the socket connects; no redirects. */
const fetchPublic: DocumentFetcher = (url, init) =>
  send(url, init, { publicOnly: true })

const REGISTERED_CLIENT_PREFIX = "pcp_client_"
const CLIENT_SECRET_PREFIX = "pcp_cs_"
const AUTH_METHODS = new Set<AuthMethod>([
  "none",
  "client_secret_basic",
  "client_secret_post",
])
/** Fields a metadata document must not have: it is public. */
const FORBIDDEN_DOCUMENT_FIELDS = ["client_secret", "client_secret_expires_at"]

/** A client_id that names a metadata document (an https URL). */
export function isMetadataDocumentId(clientId: string): boolean {
  return /^https:\/\//i.test(clientId)
}

function hostOf(uri: string): string {
  try {
    const url = new URL(uri)
    return url.host || url.protocol.replace(/:$/, "")
  } catch {
    return uri
  }
}

function cleanName(value: unknown, fallback: string): string {
  // Nothing that does not show on screen: control and format characters
  // (zero-width spaces, direction overrides).
  const name =
    typeof value === "string"
      ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()
      : ""

  return (name || fallback).slice(0, MAX_CLIENT_NAME_LENGTH)
}

/**
 * Whether a URI may be a redirect URI: https, http to this computer
 * (a client on the owner's machine), or an app's own private-use scheme
 * (reverse domain, `com.example.app:/callback`). Never a fragment or a
 * login in the URL.
 */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri || uri.length > MAX_URI_LENGTH) {
    return "Each redirect URI must be a URL of at most 2000 characters."
  }

  let url: URL

  try {
    url = new URL(uri)
  } catch {
    return `${uri} is not an absolute URL.`
  }

  if (url.hash || uri.includes("#")) {
    return `${uri} has a fragment, which a redirect URI must not.`
  }

  if (url.username || url.password) {
    return `${uri} carries a login, which a redirect URI must not.`
  }

  if (url.protocol === "https:") {
    return null
  }

  if (url.protocol === "http:") {
    const host = url.hostname.replace(/^\[|\]$/g, "")
    return host === "localhost" || host === "127.0.0.1" || host === "::1"
      ? null
      : `${uri} is plain http to another computer; use https.`
  }

  const scheme = url.protocol.slice(0, -1)
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+$/i.test(scheme)
    ? null
    : `${uri} uses a scheme PCP does not send codes to.`
}

function redirectUrisFrom(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_REDIRECT_URIS
  ) {
    throw new OAuthError(
      "invalid_redirect_uri",
      `redirect_uris must list between 1 and ${MAX_REDIRECT_URIS} URIs.`,
    )
  }

  for (const uri of value) {
    const problem = redirectUriProblem(uri)

    if (problem) {
      throw new OAuthError("invalid_redirect_uri", problem)
    }
  }

  return [...new Set(value as string[])]
}

function checkGrantAndResponseTypes(
  metadata: Record<string, unknown>,
  error: string,
): void {
  const grants = metadata.grant_types
  const responses = metadata.response_types

  if (
    grants !== undefined &&
    (!Array.isArray(grants) ||
      !grants.every(
        (grant) => grant === "authorization_code" || grant === "refresh_token",
      ) ||
      !grants.includes("authorization_code"))
  ) {
    throw new OAuthError(
      error,
      "grant_types may name authorization_code and refresh_token only.",
    )
  }

  if (
    responses !== undefined &&
    (!Array.isArray(responses) ||
      !responses.every((type) => type === "code") ||
      responses.length === 0)
  ) {
    throw new OAuthError(error, 'response_types may name "code" only.')
  }
}

function optionalUri(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value !== "string" || value.length > MAX_URI_LENGTH) {
    throw new OAuthError("invalid_client_metadata", `${field} must be a URL.`)
  }

  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error()
  } catch {
    throw new OAuthError("invalid_client_metadata", `${field} must be a URL.`)
  }

  return value
}

export type RegistrationResponse = {
  client_id: string
  client_id_issued_at: number
  client_secret?: string
  client_secret_expires_at?: number
  client_name: string
  redirect_uris: string[]
  client_uri?: string
  token_endpoint_auth_method: AuthMethod
  grant_types: string[]
  response_types: string[]
}

/**
 * Dynamic client registration (RFC 7591). Takes the parsed JSON body; the
 * route has checked its size. A client that does not say how it
 * authenticates gets a secret, as the RFC's default (client_secret_basic)
 * has it.
 */
export async function registerClient(
  body: unknown,
): Promise<RegistrationResponse> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OAuthError(
      "invalid_client_metadata",
      "Send the client's metadata as a JSON object.",
    )
  }

  const metadata = body as Record<string, unknown>
  const redirectUris = redirectUrisFrom(metadata.redirect_uris)
  checkGrantAndResponseTypes(metadata, "invalid_client_metadata")

  const requested = metadata.token_endpoint_auth_method ?? "client_secret_basic"

  if (
    typeof requested !== "string" ||
    !AUTH_METHODS.has(requested as AuthMethod)
  ) {
    throw new OAuthError(
      "invalid_client_metadata",
      "token_endpoint_auth_method must be none, client_secret_basic or client_secret_post.",
    )
  }

  const authMethod = requested as AuthMethod
  const clientUri = optionalUri(metadata.client_uri, "client_uri")
  const name = cleanName(metadata.client_name, hostOf(redirectUris[0]))

  await pruneUnusedClients()

  const waiting = await db().oAuthClient.count({ where: { lastUsedAt: null } })

  if (waiting >= MAX_UNUSED_REGISTRATIONS) {
    throw new OAuthError(
      "temporarily_unavailable",
      "Too many clients have registered without signing in; try again tomorrow.",
      429,
    )
  }

  const id = `${REGISTERED_CLIENT_PREFIX}${randomSecret(16)}`
  const secret =
    authMethod === "none" ? null : `${CLIENT_SECRET_PREFIX}${randomSecret()}`
  const created = await db().oAuthClient.create({
    data: {
      id,
      name,
      redirectUris: JSON.stringify(redirectUris),
      clientUri,
      authMethod,
      secretHash: secret ? sha256Hex(secret) : null,
    },
  })

  return {
    client_id: id,
    client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: name,
    redirect_uris: redirectUris,
    ...(clientUri ? { client_uri: clientUri } : {}),
    token_endpoint_auth_method: authMethod,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }
}

/** Registrations no sign-in has used within a day. */
export async function pruneUnusedClients(): Promise<number> {
  const result = await db().oAuthClient.deleteMany({
    where: {
      lastUsedAt: null,
      createdAt: { lt: new Date(Date.now() - UNUSED_REGISTRATION_TTL_MS) },
    },
  })

  return result.count
}

/**
 * The client a sign-in names, for the owner's page: a registered one from
 * the database, or one whose metadata document PCP reads now. Throws an
 * OAuthError (invalid_client) that the page shows the owner: with no
 * trustworthy redirect URI, nothing goes back to the client.
 */
export async function findClient(
  clientId: string,
  fetcher: DocumentFetcher = fetchPublic,
): Promise<OAuthClientInfo> {
  if (isMetadataDocumentId(clientId)) {
    return fetchClientMetadata(clientId, fetcher)
  }

  const row = await db().oAuthClient.findUnique({ where: { id: clientId } })

  if (!row) {
    throw invalidClient("PCP does not know this client.")
  }

  const redirectUris = JSON.parse(row.redirectUris) as string[]

  return {
    id: row.id,
    name: row.name,
    redirectUris,
    authMethod: row.authMethod as AuthMethod,
    fromDocument: false,
    host: hostOf(redirectUris[0] ?? ""),
  }
}

/** Notes that a sign-in was approved for a registered client. */
export async function markClientUsed(clientId: string): Promise<void> {
  if (!isMetadataDocumentId(clientId)) {
    await db().oAuthClient.updateMany({
      where: { id: clientId },
      data: { lastUsedAt: new Date() },
    })
  }
}

/**
 * Checks the client of a token or revocation request. A registered client
 * with a secret must present it the way it registered; a public client (one
 * with a metadata document, or registered with `none`) presents none.
 * Returns the client_id.
 */
export async function authenticateClient(
  credentials: ClientCredentials,
): Promise<string> {
  const { clientId, secret, method } = credentials

  if (!clientId) {
    throw invalidClient("Name the client (client_id).")
  }

  if (isMetadataDocumentId(clientId)) {
    if (secret !== null) {
      throw invalidClient("A client with a metadata document has no secret.")
    }

    return clientId
  }

  const row = await db().oAuthClient.findUnique({ where: { id: clientId } })

  if (!row) {
    throw invalidClient("PCP does not know this client.")
  }

  if (row.authMethod === "none") {
    if (secret !== null) {
      throw invalidClient("This client registered without a secret.")
    }

    return clientId
  }

  if (
    method !== row.authMethod ||
    secret === null ||
    !row.secretHash ||
    !safeEqual(sha256Hex(secret), row.secretHash)
  ) {
    throw invalidClient("The client's secret is missing or wrong.")
  }

  return clientId
}

/**
 * A client_id URL as the Client ID Metadata Document draft allows it:
 * https, a path, no fragment, no login, no dot segments, and not a name on
 * the local network. Where it resolves to is checked again as PCP connects.
 */
export function metadataDocumentUrlProblem(clientId: string): string | null {
  if (clientId.length > MAX_URI_LENGTH) {
    return "The client's address is too long."
  }

  if (/\/(?:\.|%2e)(?:\.|%2e)?(?:\/|$|\?)/i.test(clientId)) {
    return "The client's address must not contain dot segments."
  }

  if (clientId.includes("#") || clientId.includes("\\")) {
    return "The client's address must not contain a fragment."
  }

  let url: URL

  try {
    url = new URL(clientId)
  } catch {
    return "The client's address is not a URL."
  }

  if (url.protocol !== "https:") {
    return "The client's address must use https."
  }

  if (url.username || url.password) {
    return "The client's address must not contain a login."
  }

  if (!/^https:\/\/[^/?#]+\/[^?#]*/i.test(clientId) || url.pathname === "/") {
    return "The client's address must have a path."
  }

  if (isLocalHostname(url.hostname)) {
    return "The client's address must be on the internet."
  }

  return null
}

/**
 * Reads and checks a client's metadata document. Its client_id must be the
 * URL it came from, it must list its redirect URIs, and it must not claim a
 * secret: anyone can read it.
 */
export async function fetchClientMetadata(
  clientId: string,
  fetcher: DocumentFetcher = fetchPublic,
): Promise<OAuthClientInfo> {
  const problem = metadataDocumentUrlProblem(clientId)

  if (problem) {
    throw invalidClient(problem)
  }

  const host = new URL(clientId).host
  let response: Response

  try {
    response = await fetcher(clientId, {
      signal: AbortSignal.timeout(METADATA_DOCUMENT_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        "user-agent": `pcp/${PCP_VERSION} (oauth)`,
      },
    })
  } catch (error) {
    throw invalidClient(
      `PCP could not read the client's metadata at ${host}: ${describeFetchError(error, METADATA_DOCUMENT_TIMEOUT_MS)}.`,
    )
  }

  if (response.status !== 200) {
    await discard(response)
    throw invalidClient(
      `The client's metadata at ${host} answered HTTP ${response.status}${response.status >= 300 && response.status < 400 ? " (PCP follows no redirect)" : ""}.`,
    )
  }

  const type = response.headers.get("content-type") ?? ""

  if (!/^application\/([\w.-]+\+)?json\s*(;|$)/i.test(type)) {
    await discard(response)
    throw invalidClient(`The client's metadata at ${host} is not JSON.`)
  }

  const read = await readCapped(response, MAX_METADATA_DOCUMENT_BYTES)

  if (read.truncated) {
    throw invalidClient(
      `The client's metadata at ${host} is larger than ${MAX_METADATA_DOCUMENT_BYTES / 1024} KB.`,
    )
  }

  let document: unknown

  try {
    document = JSON.parse(new TextDecoder().decode(read.bytes))
  } catch {
    throw invalidClient(`The client's metadata at ${host} is not JSON.`)
  }

  return checkClientMetadata(clientId, document)
}

/** The checks on a metadata document, apart from reading it. */
export function checkClientMetadata(
  clientId: string,
  document: unknown,
): OAuthClientInfo {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw invalidClient("The client's metadata is not a JSON object.")
  }

  const metadata = document as Record<string, unknown>

  if (metadata.client_id !== clientId) {
    throw invalidClient(
      "The client's metadata names another client_id than its own address.",
    )
  }

  for (const field of FORBIDDEN_DOCUMENT_FIELDS) {
    if (field in metadata) {
      throw invalidClient(`The client's metadata must not contain ${field}.`)
    }
  }

  const method = metadata.token_endpoint_auth_method ?? "none"

  if (method !== "none") {
    throw invalidClient(
      "PCP supports clients with a metadata document only without a secret or key (token_endpoint_auth_method none).",
    )
  }

  let redirectUris: string[]

  try {
    redirectUris = redirectUrisFrom(metadata.redirect_uris)
    checkGrantAndResponseTypes(metadata, "invalid_client")
  } catch (error) {
    throw invalidClient(
      error instanceof Error
        ? `The client's metadata is not usable: ${error.message}`
        : "The client's metadata is not usable.",
    )
  }

  const host = new URL(clientId).host

  return {
    id: clientId,
    name: cleanName(metadata.client_name, host),
    redirectUris,
    authMethod: "none",
    fromDocument: true,
    host,
  }
}
