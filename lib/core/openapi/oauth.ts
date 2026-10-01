import { entries, isObject, own, ownString } from "./json"
import {
  MAX_NAME_LENGTH,
  MAX_OAUTH_SCOPES,
  MAX_SERVER_URL_LENGTH,
} from "./limits"

/**
 * The OAuth an API asks for, read from its schema: an oauth2 security scheme
 * with an authorization code flow gives the address the owner signs in at,
 * the one PCP exchanges the code at, and the scopes. Only that flow: it is
 * the one where the owner signs in themselves (the implicit and password
 * flows are deprecated, and client credentials sign in no person).
 *
 * The addresses come from someone else's document. They are read here and
 * shown to the owner when they add the endpoint; what PCP uses afterwards is
 * the copy stored with the endpoint, never the schema's current text, so a
 * changed document cannot send the owner's client secret somewhere else.
 */

export type OAuthFlow = {
  /** The security scheme's name in the schema. */
  scheme: string
  authorizationUrl: string
  tokenUrl: string
  /**
   * What to ask for: the scopes the operations PCP offers require, or every
   * scope the flow lists when none of them names one.
   */
  scopes: string[]
}

export type OAuthReading = {
  flow: OAuthFlow | null
  /** Why the schema's OAuth cannot be used, when it has some and it cannot. */
  problem: string | null
}

function flowUrl(raw: string | undefined): string | null {
  if (!raw || raw.length > MAX_SERVER_URL_LENGTH) {
    return null
  }

  try {
    const url = new URL(raw)

    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.hash
      ? url.toString()
      : null
  } catch {
    return null
  }
}

/** A scope as an authorization server would take it: one token, short. */
function isScope(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_NAME_LENGTH &&
    /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value)
  )
}

/**
 * @param requirements the security requirement lists of the operations PCP
 * offers (each operation's own, or the document's), to pick the scheme they
 * use and the scopes they need.
 */
export function readOAuth(doc: unknown, requirements: unknown[]): OAuthReading {
  const schemes = own(own(doc, "components"), "securitySchemes")
  const oauthSchemes = entries(schemes).filter(
    ([, scheme]) => ownString(scheme, "type") === "oauth2",
  )
  const required = new Set(
    requirements.flatMap((list) =>
      Array.isArray(list)
        ? list.flatMap((requirement) => entries(requirement).map(([n]) => n))
        : [],
    ),
  )

  if (oauthSchemes.length === 0) {
    const oidc = entries(schemes).some(
      ([name, scheme]) =>
        ownString(scheme, "type") === "openIdConnect" && required.has(name),
    )

    return {
      flow: null,
      problem: oidc
        ? "The schema signs in with OpenID Connect discovery, which PCP does not read; add an oauth2 scheme with an authorizationCode flow to it."
        : null,
    }
  }

  // The scheme the operations use, else the first that has the flow.
  const usable = oauthSchemes.filter(([, scheme]) =>
    isObject(own(own(scheme, "flows"), "authorizationCode")),
  )
  const chosen =
    usable.find(([name]) => required.has(name)) ?? usable[0] ?? undefined

  if (!chosen) {
    return {
      flow: null,
      problem:
        "The schema's OAuth has no authorization code flow, the only one PCP signs in with.",
    }
  }

  const [scheme, node] = chosen
  const flow = own(own(node, "flows"), "authorizationCode")
  const authorizationUrl = flowUrl(ownString(flow, "authorizationUrl"))
  const tokenUrl = flowUrl(ownString(flow, "tokenUrl"))

  if (!authorizationUrl || !tokenUrl) {
    return {
      flow: null,
      problem:
        "The schema's OAuth flow needs a full http(s) authorizationUrl and tokenUrl.",
    }
  }

  const needed: string[] = []

  for (const list of requirements) {
    for (const requirement of Array.isArray(list) ? list : []) {
      const scopes = own(requirement, scheme)

      for (const scope of Array.isArray(scopes) ? scopes : []) {
        if (isScope(scope) && !needed.includes(scope)) {
          needed.push(scope)
        }
      }
    }
  }

  const listed = entries(own(flow, "scopes"))
    .map(([name]) => name)
    .filter(isScope)
  const scopes = (needed.length > 0 ? needed : listed).slice(
    0,
    MAX_OAUTH_SCOPES,
  )

  return {
    flow: {
      scheme: scheme.slice(0, MAX_NAME_LENGTH),
      authorizationUrl,
      tokenUrl,
      scopes,
    },
    problem: null,
  }
}
