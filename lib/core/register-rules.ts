import type { AuthType } from "./servers"

/**
 * What register_server accepts, per kind of thing it can propose: the kind
 * itself, and which arguments belong with which. Pure rules with no
 * database, so each is easy to test. Refusals are worded for the assistant
 * that made the call: they say what to pass instead.
 */

export type RegisterKind =
  "mcp" | "api" | "jmap" | "imap" | "caldav" | "service"

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

/** A calendar account as an assistant proposed it, beside RegisterArgs' url. */
export type CalendarRegistration = {
  readOnly: boolean
  /** Set when the address is private or local, for the owner. */
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
  description?: string
  /** Another server of a definition the token sees, by a short name. */
  definition?: string
  /** kind service: its definition, the SSH server, where it is published, its secrets. */
  service?: unknown
  ssh_server?: string
  publish_address?: string
  publish_ports?: unknown[]
  env_secrets?: unknown[]
}

/** The arguments only a service takes. */
const SERVICE_ARGS = [
  "service",
  "ssh_server",
  "publish_address",
  "publish_ports",
  "env_secrets",
] as const

export function isMailRegistrationKind(
  kind: RegisterKind,
): kind is MailProtocol {
  return kind === "jmap" || kind === "imap"
}

/**
 * The kind a call is for: the one named, else that of the definition it is
 * made on (an API's, an MCP server's or a service's), else a service when
 * it brings a service's definition, else an API when it brings an OpenAPI
 * document, else an MCP server, as register_server always did.
 */
export function resolveKind(
  args: Pick<
    RegisterShape,
    "kind" | "openapi_schema" | "openapi_url" | "service"
  >,
  definitionKind?: string | null,
): RegisterKind {
  if (args.kind) {
    return args.kind
  }

  if (definitionKind) {
    return definitionKind === "openapi"
      ? "api"
      : definitionKind === "service"
        ? "service"
        : "mcp"
  }

  if (args.service !== undefined) {
    return "service"
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
  caldav: "a calendar account",
  service: "a service",
}

const MISSING_URL: Record<Exclude<RegisterKind, "api" | "service">, string> = {
  mcp: "An MCP server needs its address in url. To add an API instead, pass its OpenAPI document in openapi_schema, or its address in openapi_url; for a mailbox, pass kind jmap or imap; for calendars and reminders, kind caldav.",
  jmap: "A JMAP mail account needs its server in url, like https://mail.example.com (PCP finds the session at /.well-known/jmap), or the full session URL.",
  imap: "An IMAP mail account needs its server in url, like mail.example.com, imaps://mail.example.com:993, or imap://mail.example.com:143 for STARTTLS.",
  caldav:
    "A calendar account needs its CalDAV server in url, like caldav.icloud.com (iCloud), caldav.fastmail.com, or a Nextcloud's https://cloud.example.com/remote.php/dav.",
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

  if (args.definition !== undefined) {
    const refused = checkDefinitionShape(kind, args)

    if (refused) {
      return refused
    }
  }

  if (kind !== "service") {
    const given = SERVICE_ARGS.filter((key) => args[key] !== undefined)

    if (given.length > 0) {
      return `${given.join(", ")} ${given.length === 1 ? "is" : "are"} for kind service; ${NOUN[kind]} takes none of them.`
    }
  } else {
    const refused = checkServiceShape(args)

    if (refused) {
      return refused
    }
  }

  if (
    kind !== "api" &&
    (args.openapi_schema !== undefined ||
      args.openapi_url !== undefined ||
      args.spec_patches !== undefined)
  ) {
    return `openapi_schema, openapi_url and spec_patches are for kind api; ${NOUN[kind]} takes none of them.`
  }

  if (kind === "service") {
    return null
  }

  if (kind === "api") {
    if (
      args.definition === undefined &&
      args.openapi_schema === undefined &&
      args.openapi_url === undefined
    ) {
      return "An API is added from its OpenAPI document: pass it in openapi_schema, or its address in openapi_url."
    }
  } else if (!args.url?.trim()) {
    return MISSING_URL[kind]
  }

  if (args.read_only !== undefined && kind === "mcp") {
    return "read_only is for an API (openapi_schema or openapi_url), a mail account (kind jmap or imap) or a calendar account (kind caldav)."
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

  if (kind === "caldav") {
    if (
      args.header_name !== undefined ||
      args.value_template !== undefined ||
      (args.extra_headers?.length ?? 0) > 0
    ) {
      return "A calendar account's bearer token is sent as Authorization: Bearer <token>; leave header_name, value_template and extra_headers out."
    }

    if (authType === "none") {
      return "A calendar account signs in: pass auth_type basic (a user name and an app password: for iCloud, the Apple ID and an app-specific password), header (a bearer token) or oauth."
    }
  }

  if (args.username !== undefined && authType !== "basic") {
    return "username is for auth_type basic."
  }

  if (authType === "basic") {
    if (kind === "mcp") {
      return "An MCP server sends a secret in a header or signs in with OAuth. Basic authentication, a user name and a password, is for an API, a mail account or a calendar account."
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

/**
 * A server made on a definition (`definition`) is another instance of what
 * a server the token sees is: an MCP server's or an API's, with an address
 * of its own. What it is (the description, an API's schema and edits) is
 * the definition's, so the call brings none of that, only the instance's
 * own part: its name, address, sign-in, read-only switch and the note.
 */
function checkDefinitionShape(
  kind: RegisterKind,
  args: RegisterShape,
): string | null {
  if (kind === "service") {
    if (args.service !== undefined) {
      return "With definition, what the service runs is the definition's: leave service out, and pass only this one's name, ssh_server, publish_address, publish_ports, env_secrets and note."
    }

    if (args.description !== undefined) {
      return "With definition, the description is the definition's: leave description out, and put what is particular to this service in note."
    }

    return null
  }

  if (kind !== "mcp" && kind !== "api") {
    return "definition is for an MCP server, an API or a service (kind mcp, api or service): a mail or calendar account is not another server of anything."
  }

  if (
    args.openapi_schema !== undefined ||
    args.openapi_url !== undefined ||
    args.spec_patches !== undefined
  ) {
    return "With definition, the schema and its edits are the definition's: leave openapi_schema, openapi_url and spec_patches out."
  }

  if (args.description !== undefined) {
    return "With definition, the description is the definition's: leave description out, and put what is particular to this server in note."
  }

  if (!args.url?.trim()) {
    return kind === "api"
      ? "With definition, pass the base URL this server's requests go to in url: each server of a definition has an address of its own."
      : "With definition, pass this server's address in url: each server of a definition has an address of its own."
  }

  return null
}

/**
 * A service an assistant proposes runs on one of the owner's SSH servers
 * from a definition (or on a definition it sees): it has no address of its
 * own and signs in to nothing, so the arguments of the other kinds are not
 * its. Its variables take secrets by name in env_secrets.
 */
function checkServiceShape(args: RegisterShape): string | null {
  const others = (
    [
      "url",
      "openapi_schema",
      "openapi_url",
      "spec_patches",
      "read_only",
      "secret",
      "username",
      "smtp_url",
      "mail_from",
      "header_name",
      "value_template",
      "extra_headers",
      "client_id",
      "oauth_scope",
    ] as const
  ).filter((key) => args[key] !== undefined)

  if (others.length > 0) {
    return `A service takes none of ${others.join(", ")}: it runs on one of the owner's SSH servers (ssh_server), is published there (publish_address, publish_ports) and its variables take secrets by name (env_secrets).`
  }

  if ((args.auth_type ?? "none") !== "none") {
    return "A service signs in to nothing: leave auth_type out. A secret it needs goes to one of its variables, by name, in env_secrets."
  }

  if (args.definition === undefined && args.service === undefined) {
    return "A service is proposed from its definition in service (the image pinned by digest, ports, variables, volumes, health check and what it registers), or as another of a service you see, by its short name in definition."
  }

  if (!args.ssh_server?.trim()) {
    return "A service runs on one of the owner's SSH servers: pass its short name in ssh_server."
  }

  return null
}
