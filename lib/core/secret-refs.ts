import type { VaultContext } from "./context"
import { db } from "./db"
import { SECRET_META_SELECT, secretName, secretNameWhere } from "./secret-meta"
import type { OwnerSecretKind } from "./secrets"

/**
 * The one way a field that takes a secret by name finds it (#162): a
 * server's header or basic login, an OAuth client's secret, a service's
 * variable, a wrapper's place, what the browser types, a mail or calendar
 * account's sign-in, a linked repository's document. Each names its
 * consumer (`use`), and the use decides which of the vault's secrets it may
 * name:
 *
 * - every use takes the owner's text secrets;
 * - one-time codes (`totp`) go only where the browser types them (the
 *   browser's `type`, or a wrapper's place at browser/type), where only the
 *   code of the moment is typed;
 * - managed secrets (OAuth tokens, SSH keys, proxy passwords, values PCP
 *   made for a service) are never named: they are PCP's own for one thing.
 *
 * Nothing here selects or decrypts a value: what comes back is the id and
 * the name, as the vault spells it.
 */

/** The consumer of a secret named by name, as SecretRefUse says it. */
export const SECRET_REF_USES = [
  "header",
  "basic",
  "oauth_client",
  "service_env",
  "wrapper_binding",
  "browser_type",
  "mail",
  "caldav",
] as const

export type SecretRefUseKind = (typeof SECRET_REF_USES)[number]

export type SecretRefUse =
  /** A server's or endpoint's header, its own or a further one. */
  | { kind: "header" }
  /** The password of a basic sign-in. */
  | { kind: "basic" }
  /** An OAuth client's secret. */
  | { kind: "oauth_client" }
  /** A service's variable. */
  | { kind: "service_env" }
  /**
   * A wrapper's place for a secret; `typed` when the place is the
   * browser's type, which types one-time codes too.
   */
  | { kind: "wrapper_binding"; typed?: boolean }
  /** What the browser types into a page. */
  | { kind: "browser_type" }
  /** A mail account's password or token. */
  | { kind: "mail" }
  /** A calendar account's password or token. */
  | { kind: "caldav" }

export type ResolvedSecret = {
  id: string
  name: string
  kind: OwnerSecretKind
}

/** The kinds of secret a use may name. */
export function secretKindsFor(use: SecretRefUse): readonly OwnerSecretKind[] {
  switch (use.kind) {
    case "browser_type":
      return ["text", "totp"]
    case "wrapper_binding":
      return use.typed ? ["text", "totp"] : ["text"]
    case "header":
    case "basic":
    case "oauth_client":
    case "service_env":
    case "mail":
    case "caldav":
      return ["text"]
  }
}

/**
 * The secret `name` names for `use`, or null when the vault has none it may
 * name there (none of that name, or one of another kind:
 * `secretNameTaken` tells those apart).
 */
export async function resolveSecretRef(
  ctx: VaultContext,
  name: string,
  use: SecretRefUse,
): Promise<ResolvedSecret | null> {
  const kinds = secretKindsFor(use)
  const row = await db().secret.findFirst({
    where: secretNameWhere(ctx, name.trim()),
    select: { ...SECRET_META_SELECT, kind: true },
  })

  return row && (kinds as readonly string[]).includes(row.kind)
    ? {
        id: row.id,
        name: secretName(ctx, row),
        kind: row.kind as OwnerSecretKind,
      }
    : null
}

/**
 * The use of a server's own secret: its OAuth client's, a mail or calendar
 * account's sign-in, or a header's or basic login's.
 */
export function credentialUse(input: {
  authType: string
  mail?: boolean
  calendar?: boolean
}): SecretRefUse {
  return input.authType === "oauth"
    ? { kind: "oauth_client" }
    : input.mail
      ? { kind: "mail" }
      : input.calendar
        ? { kind: "caldav" }
        : input.authType === "basic"
          ? { kind: "basic" }
          : { kind: "header" }
}
