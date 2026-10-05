import type { AuthType } from "./servers"

/**
 * What register_server accepts, per kind of thing it can propose: the kind
 * itself, and which arguments belong with which. Pure rules with no
 * database, so each is easy to test. Refusals are worded for the assistant
 * that made the call: they say what to pass instead.
 */

export type RegisterKind = "mcp" | "api" | "jmap" | "imap"

export type MailProtocol = Extract<RegisterKind, "jmap" | "imap">

/** A mail account as an assistant proposed it, beside RegisterArgs' url. */
export type MailRegistration = {
  protocol: MailProtocol
  /** imap: where mail is sent; null for an account that cannot send. */
  smtpUrl: string | null
  readOnly: boolean
  mailFrom: string | null
  /** jmap: what an unauthenticated look at the session URL found. */
  checked: string | null
  /** Set when the address is private or local and was not looked at. */
  privateAddress: string | null
}

/** register_server's arguments, as far as these rules read them. */
export type RegisterShape = {
  kind?: RegisterKind
  url?: string
  openapi_schema?: string
  openapi_url?: string
  spec_patches?: unknown
  read_only?: boolean
  auth_type?: AuthType
  secret?: string
  username?: string
  smtp_url?: string
  mail_from?: string
  header_name?: string
  value_template?: string
  extra_headers?: unknown[]
  client_id?: string
  oauth_scope?: string
}

export function isMailRegistrationKind(
  kind: RegisterKind,
): kind is MailProtocol {
  return kind === "jmap" || kind === "imap"
}

/**
 * The kind a call is for: the one named, else an API when it brings an
 * OpenAPI document, else an MCP server, as register_server always did.
 */
export function resolveKind(
  args: Pick<RegisterShape, "kind" | "openapi_schema" | "openapi_url">,
): RegisterKind {
  if (args.kind) {
    return args.kind
  }

  return args.openapi_schema !== undefined || args.openapi_url !== undefined
    ? "api"
    : "mcp"
}

const NOUN: Record<RegisterKind, string> = {
  mcp: "an MCP server",
  api: "an API",
  jmap: "a JMAP mail account",
  imap: "an IMAP mail account",
}

const MISSING_URL: Record<Exclude<RegisterKind, "api">, string> = {
  mcp: "An MCP server needs its address in url. To add an API instead, pass its OpenAPI document in openapi_schema, or its address in openapi_url; for a mailbox, pass kind jmap or imap.",
  jmap: "A JMAP mail account needs its server in url, like https://mail.example.com (PCP finds the session at /.well-known/jmap), or the full session URL.",
  imap: "An IMAP mail account needs its server in url, like mail.example.com, imaps://mail.example.com:993, or imap://mail.example.com:143 for STARTTLS.",
}

/**
 * The reason a call's arguments do not fit its kind, or null when they do.
 * What is left for later (a secret's name, a header's form, the addresses)
 * needs the vault or the network and is checked there.
 */
export function checkRegisterShape(
  kind: RegisterKind,
  args: RegisterShape,
): string | null {
  const authType = args.auth_type ?? "none"
  const mail = isMailRegistrationKind(kind)

  if (
    kind !== "api" &&
    (args.openapi_schema !== undefined ||
      args.openapi_url !== undefined ||
      args.spec_patches !== undefined)
  ) {
    return `openapi_schema, openapi_url and spec_patches are for kind api; ${NOUN[kind]} takes none of them.`
  }

  if (kind === "api") {
    if (args.openapi_schema === undefined && args.openapi_url === undefined) {
      return "An API is added from its OpenAPI document: pass it in openapi_schema, or its address in openapi_url."
    }
  } else if (!args.url?.trim()) {
    return MISSING_URL[kind]
  }

  if (args.read_only !== undefined && kind === "mcp") {
    return "read_only is for an API (openapi_schema or openapi_url) or a mail account (kind jmap or imap)."
  }

  if (args.smtp_url !== undefined && kind !== "imap") {
    return "smtp_url is for kind imap: a JMAP account sends through its own server."
  }

  if (args.mail_from !== undefined && !mail) {
    return "mail_from is for kind jmap or imap."
  }

  if (mail) {
    if (
      args.header_name !== undefined ||
      args.value_template !== undefined ||
      (args.extra_headers?.length ?? 0) > 0
    ) {
      return "A mail account's bearer token is sent as Authorization: Bearer <token>; leave header_name, value_template and extra_headers out."
    }

    if (authType === "none") {
      return "A mail account signs in: pass auth_type basic (a user name and an app password), header (a bearer token) or oauth."
    }

    if (kind === "imap" && authType !== "basic") {
      return "An IMAP account signs in with a user name and password: pass auth_type basic."
    }
  }

  if (args.username !== undefined && authType !== "basic") {
    return "username is for auth_type basic."
  }

  if (authType === "basic") {
    if (kind === "mcp") {
      return "An MCP server sends a secret in a header or signs in with OAuth. Basic authentication, a user name and a password, is for an API or a mail account."
    }

    if (!args.username?.trim()) {
      return "Basic authentication needs the user name in username."
    }

    if (!args.secret?.trim()) {
      return "Basic authentication needs the name of the secret that holds the password, in secret."
    }
  }

  if (authType !== "oauth" && (args.client_id || args.oauth_scope)) {
    return "client_id and oauth_scope are for auth_type oauth."
  }

  if ((args.extra_headers?.length ?? 0) > 0 && authType !== "header") {
    return "extra_headers are for auth_type header."
  }

  if (authType === "oauth" && args.secret && !args.client_id?.trim()) {
    return "With oauth, secret names the client secret of the client in client_id: pass client_id too, or leave secret out."
  }

  if (authType === "header" && !args.secret?.trim()) {
    return "Header authentication needs the name of a secret the owner stored in PCP, in secret."
  }

  return null
}
