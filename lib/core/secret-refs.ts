import type { VaultContext } from "./context"
import { db } from "./db"
import { SECRET_META_SELECT, secretName, secretNameWhere } from "./secret-meta"
import type { SecretConsumer } from "./secret-scope"
import type { OwnerSecretKind } from "./secrets"

/**
 * The one way a field that takes a secret by name finds it (#162): a
 * server's header or basic login, an OAuth client's secret, a service's
 * variable, a wrapper's place, what the browser types, a mail or calendar
 * account's sign-in, the Google sign-in's client, a linked repository's document. Each names its
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
 * A use that names its consumer (`consumer`: a server's, endpoint's,
 * account's, service's or wrapper's id, or null for one a proposal would
 * make) is checked against the secret's scope (#162, secret-scope.ts):
 * anywhere, a consumer the owner granted, or one that uses it now. Outside
 * it, `scope` decides:
 *
 * - "check" (the default): refused, naming change_secret_scope;
 * - "ask": an assistant's proposal, which the owner's page shows as "also
 *   allows <secret> for <consumer>" (`inScope` false);
 * - "granted": the owner's yes to that page, or their own pick.
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
  "google_account",
] as const

export type SecretRefUseKind = (typeof SECRET_REF_USES)[number]

/** How a use with a consumer meets a secret outside its scope. */
export type SecretScopeMode = "check" | "ask" | "granted"

/** What a use may add: who names the secret, and how its scope is met. */
export type SecretRefConsumer = {
  consumer?: SecretConsumer
  scope?: SecretScopeMode
}

export type SecretRefUse = SecretRefConsumer &
  /** A server's or endpoint's header, its own or a further one. */
  (
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
    /** The client secret of the owner's Google sign-in (lib/core/google/). */
    | { kind: "google_account" }
  )

export type ResolvedSecret = {
  id: string
  name: string
  kind: OwnerSecretKind
  /**
   * Whether its scope covers the use's consumer (true for a use that names
   * none): false only for "ask" and "granted".
   */
  inScope: boolean
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
    case "google_account":
      return ["text"]
  }
}

/**
 * The secret `name` names for `use`, or null when the vault has none it may
 * name there (none of that name, or one of another kind:
 * `secretNameTaken` tells those apart). A secret outside the scope of the
 * use's consumer is refused (PcpError "forbidden") unless the use says
 * "ask" or "granted".
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

  if (!row || !(kinds as readonly string[]).includes(row.kind)) {
    return null
  }

  const found = { id: row.id, name: secretName(ctx, row) }

  if (!use.consumer) {
    return { ...found, kind: row.kind as OwnerSecretKind, inScope: true }
  }

  // Loaded here: the scope reads what uses a secret, which reads the
  // browser's sites, which find a secret through this module.
  const { requireInScope, scopeCovers } = await import("./secret-scope")

  if ((use.scope ?? "check") === "check") {
    await requireInScope(ctx, found, use.consumer)

    return { ...found, kind: row.kind as OwnerSecretKind, inScope: true }
  }

  return {
    ...found,
    kind: row.kind as OwnerSecretKind,
    inScope: await scopeCovers(ctx, row.id, use.consumer.id),
  }
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
