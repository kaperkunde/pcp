import type { OAuthClientMetadata } from "@modelcontextprotocol/client"

import { invalid } from "./errors"

/**
 * How PCP identifies itself to an OAuth server, for any provider: nothing
 * here knows a provider by name. The MCP authorization spec lists the ways
 * a client gets a client ID; PCP tries them in this order:
 *
 * 1. preregistered: the owner created a client with the provider and gave
 *    PCP its ID (and secret). Always wins.
 * 2. stored: PCP registered itself earlier, by either of the next two.
 * 3. dynamic: the server has a registration endpoint (RFC 7591).
 * 4. metadata-document: the server fetches PCP's client metadata from a URL
 *    that is the client ID (OAuth Client ID Metadata Documents). Needs PCP
 *    on a public https address. The spec ranks it above dynamic
 *    registration; PCP does not, because PCP is often reachable only on a
 *    private network, where the server could not fetch the document and a
 *    connection that registration would have made fails instead.
 * 5. needs-client: none of the above. The owner has to create a client
 *    with the provider; the server's page says how.
 */

export type RegistrationMethod =
  "preregistered" | "stored" | "dynamic" | "metadata-document" | "needs-client"

export function chooseRegistration({
  clientId,
  storedClient,
  metadata,
  metadataUrl,
}: {
  clientId: string | null
  storedClient: boolean
  /** The authorization server's metadata; undefined when it publishes none. */
  metadata:
    | {
        registration_endpoint?: string
        client_id_metadata_document_supported?: boolean
      }
    | undefined
  /** Where PCP's client metadata document is, or null off https. */
  metadataUrl: string | null
}): RegistrationMethod {
  if (clientId) {
    return "preregistered"
  }

  if (storedClient) {
    return "stored"
  }

  // A server without metadata gets the SDK's guess (POST /register); a
  // refusal there ends up as needs-client too (startOAuth).
  if (!metadata || metadata.registration_endpoint) {
    return "dynamic"
  }

  if (metadata.client_id_metadata_document_supported === true && metadataUrl) {
    return "metadata-document"
  }

  return "needs-client"
}

function base(publicUrl: string): string {
  return publicUrl.replace(/\/+$/, "")
}

/**
 * Where every OAuth server sends the owner back to. One address for the
 * whole install, so the owner registers it once per provider, before the
 * server exists in PCP, and one client can serve several servers.
 */
export function oauthRedirectUrl(publicUrl: string): string {
  return `${base(publicUrl)}/api/oauth/callback`
}

/** The redirect address before there was one for the whole install. */
export function legacyRedirectUrl(publicUrl: string, serverId: string): string {
  return `${base(publicUrl)}/api/servers/${serverId}/oauth/callback`
}

/**
 * The URL of PCP's client metadata document, which is also the client ID
 * it stands for. Only on https: an authorization server will not fetch it
 * otherwise (and the SDK refuses to offer it).
 */
export function clientMetadataUrl(publicUrl: string): string | null {
  return publicUrl.startsWith("https://")
    ? `${base(publicUrl)}/api/oauth/client-metadata`
    : null
}

const CLIENT_NAME = "PCP"

/** What PCP says about itself when it registers dynamically. */
export function registrationMetadata({
  publicUrl,
  redirectUrl,
  version,
  confidential,
  scope,
}: {
  publicUrl: string
  redirectUrl: string
  version: string
  confidential: boolean
  scope: string | null
}): OAuthClientMetadata {
  return {
    client_name: CLIENT_NAME,
    client_uri: publicUrl,
    software_id: "pcp",
    software_version: version,
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: confidential ? "client_secret_post" : "none",
    ...(scope ? { scope } : {}),
  }
}

/**
 * The document served at clientMetadataUrl(). Its client_id must be the
 * address it is served from, and it names the one redirect address, so an
 * authorization server can check both without knowing PCP.
 */
export function clientMetadataDocument(
  publicUrl: string,
  version: string,
): (OAuthClientMetadata & { client_id: string }) | null {
  const clientId = clientMetadataUrl(publicUrl)

  if (!clientId) {
    return null
  }

  return {
    client_id: clientId,
    ...registrationMetadata({
      publicUrl: base(publicUrl),
      redirectUrl: oauthRedirectUrl(publicUrl),
      version,
      confidential: false,
      scope: null,
    }),
  }
}

/**
 * Extra parameters the owner adds to a server's sign-in address, for
 * providers that need one PCP does not send: a refresh token only when
 * asked for offline access, a consent prompt, an audience. The ones the
 * flow itself sets cannot be added or replaced: they carry PKCE, the
 * client, the redirect and the state check.
 */
const RESERVED_PARAMS = new Set([
  "response_type",
  "client_id",
  "client_secret",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
  "request",
  "request_uri",
])

const MAX_PARAMS = 10
const MAX_PARAM_VALUE = 500

/**
 * The owner's text ("access_type=offline&prompt=consent", or one per line)
 * as a canonical query string, or null when empty. Throws on anything PCP
 * would not send.
 */
export function normalizeAuthorizeParams(
  raw: string | null | undefined,
): string | null {
  const text = (raw ?? "").trim()

  if (!text) {
    return null
  }

  if (text.length > MAX_PARAMS * (64 + MAX_PARAM_VALUE)) {
    throw invalid("That is too long for sign-in parameters.")
  }

  const params = new URLSearchParams()

  for (const part of text.split(/[&\n]+/)) {
    const pair = part.trim()

    if (!pair) {
      continue
    }

    const at = pair.indexOf("=")
    const name = decodePart(at < 0 ? pair : pair.slice(0, at)).trim()
    const value = at < 0 ? "" : decodePart(pair.slice(at + 1)).trim()

    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      throw invalid(
        `"${name.slice(0, 64)}" is not a parameter name: use letters, digits, dots, dashes and underscores.`,
      )
    }

    if (RESERVED_PARAMS.has(name.toLowerCase())) {
      throw invalid(
        name.toLowerCase() === "scope"
          ? "Put the scope in the Scope field."
          : `PCP sets ${name} itself; leave it out.`,
      )
    }

    if (!value) {
      throw invalid(`Give ${name} a value, like ${name}=something.`)
    }

    if (value.length > MAX_PARAM_VALUE || /[\u0000-\u001f\u007f]/.test(value)) {
      throw invalid(
        `The value of ${name} is too long or has control characters.`,
      )
    }

    if (params.has(name)) {
      throw invalid(`${name} is there twice.`)
    }

    params.append(name, value)
  }

  if ([...params.keys()].length > MAX_PARAMS) {
    throw invalid(`Keep it to ${MAX_PARAMS} parameters.`)
  }

  return params.size > 0 ? params.toString() : null
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, " "))
  } catch {
    throw invalid(`"${part.slice(0, 64)}" is not encoded correctly.`)
  }
}

/**
 * Adds the stored parameters to a sign-in address. Whatever the flow put
 * there already stays as it is, and the reserved names are skipped even if
 * a stored value has them (one saved before a name became reserved).
 */
export function applyAuthorizeParams(url: URL, stored: string | null): URL {
  if (!stored) {
    return url
  }

  for (const [name, value] of new URLSearchParams(stored)) {
    if (
      !RESERVED_PARAMS.has(name.toLowerCase()) &&
      !url.searchParams.has(name)
    ) {
      url.searchParams.set(name, value)
    }
  }

  return url
}

/**
 * Whether a token set can be renewed without the owner, and until when the
 * access it gives lasts (null when the server did not say).
 */
export function tokenLifetime(
  tokens: { refresh_token?: string; expires_in?: number } | undefined,
  savedAt: string | undefined,
): { renewable: boolean; expiresAt: Date | null } {
  const saved = savedAt ? new Date(savedAt) : null
  const expiresAt =
    saved && !Number.isNaN(saved.getTime()) && tokens?.expires_in
      ? new Date(saved.getTime() + tokens.expires_in * 1000)
      : null

  return { renewable: Boolean(tokens?.refresh_token), expiresAt }
}
