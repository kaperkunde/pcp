/**
 * Where PCP's authorization server lives and what it says about itself.
 * Everything is derived from PCP's public URL, which differs per install
 * (localhost, a dynamic DNS name, a pcp.gg name): that URL is the issuer,
 * and `<public URL>/mcp` the one resource it issues tokens for.
 */

export const MCP_PATH = "/mcp"

/** Scopes a client may ask for. Nothing depends on them: PCP's levels are per token. */
export const SUPPORTED_SCOPES = ["offline_access"] as const

export type OAuthUrls = {
  issuer: string
  resource: string
  resourceMetadata: string
  authorization: string
  token: string
  registration: string
  revocation: string
}

export function oauthUrls(publicUrl: string): OAuthUrls {
  const base = publicUrl.replace(/\/+$/, "")

  return {
    issuer: base,
    resource: `${base}${MCP_PATH}`,
    resourceMetadata: `${base}/.well-known/oauth-protected-resource${MCP_PATH}`,
    authorization: `${base}/oauth/authorize`,
    token: `${base}/oauth/token`,
    registration: `${base}/oauth/register`,
    revocation: `${base}/oauth/revoke`,
  }
}

/** Protected resource metadata (RFC 9728) for /mcp. */
export function protectedResourceMetadata(publicUrl: string) {
  const urls = oauthUrls(publicUrl)

  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    bearer_methods_supported: ["header"],
    resource_name: "PCP",
  }
}

/** Authorization server metadata (RFC 8414). */
export function authorizationServerMetadata(publicUrl: string) {
  const urls = oauthUrls(publicUrl)
  const clientAuth = ["none", "client_secret_basic", "client_secret_post"]

  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorization,
    token_endpoint: urls.token,
    registration_endpoint: urls.registration,
    revocation_endpoint: urls.revocation,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: clientAuth,
    revocation_endpoint_auth_methods_supported: clientAuth,
    scopes_supported: [...SUPPORTED_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }
}

/**
 * The challenge on a 401 from /mcp: where the resource's metadata is, which
 * is how a client finds out where to sign the owner in.
 */
export function bearerChallenge(
  publicUrl: string,
  tokenPresented: boolean,
): string {
  const parts = [
    'Bearer realm="pcp"',
    `resource_metadata="${oauthUrls(publicUrl).resourceMetadata}"`,
  ]

  if (tokenPresented) {
    parts.push('error="invalid_token"')
  }

  return parts.join(", ")
}

/** Whether a client's `resource` names PCP's /mcp (a trailing slash aside). */
export function isOwnResource(resource: string, publicUrl: string): boolean {
  return resource.replace(/\/+$/, "") === oauthUrls(publicUrl).resource
}
