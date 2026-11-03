import type { Page } from "patchright-core"

import { originOf, signInsAt, type SiteSignIn } from "../browser-secrets"
import type { VaultContext } from "../context"
import {
  ACTION_TIMEOUT_MS,
  MAX_MASKED_FRAMES,
  MAX_SIGN_IN_HINTS,
} from "./limits"
import { bounded } from "./queue"

/**
 * The note navigate, snapshot and tabs open add when the owner keeps a
 * sign-in for the page's site: the names of the secrets bound to its origin
 * (SecretBrowserOrigin), each with the login name, note and TOTP companion
 * the owner gave it, so an assistant knows to type one with
 * {"$secret": name} rather than ask the owner. Never a value: the names and
 * that metadata come from browser-secrets.ts (secrets.ts opens them), and
 * typing one is still the gate's (admitSecretUse), however it is named here.
 * Louder, and ahead of the tab's lines, when the page has a password field.
 */

export type SignInHint = {
  /** The page has a password field: the note goes first, and says so. */
  loud: boolean
  line: string
}

/** Whether a frame of the page has a password field. */
export async function hasPasswordField(page: Page): Promise<boolean> {
  for (const frame of page.frames().slice(0, MAX_MASKED_FRAMES)) {
    const count = await bounded(
      frame.locator("input[type=password i]").count(),
      ACTION_TIMEOUT_MS,
      "password fields",
    ).catch(() => 0)

    if (count > 0) {
      return true
    }
  }

  return false
}

function entry(signIn: SiteSignIn): string {
  const parts = [
    ...(signIn.kind === "totp" ? ["one-time codes"] : []),
    ...(signIn.loginName ? [`login: ${signIn.loginName}`] : []),
    ...(signIn.totp ? [`one-time codes: "${signIn.totp}"`] : []),
    ...(signIn.note ? [`note: ${signIn.note}`] : []),
  ]

  return parts.length > 0
    ? `"${signIn.name}" (${parts.join(", ")})`
    : `"${signIn.name}"`
}

/** The note, in words; null when the owner keeps no sign-in there. */
export function signInLine(
  origin: string,
  signIns: readonly SiteSignIn[],
  passwordField: boolean,
): SignInHint | null {
  const first = signIns[0]

  if (!first) {
    return null
  }

  const listed = signIns.map(entry).join("; ")
  const how = `type's text {"$secret": "${first.name}"}`

  if (passwordField) {
    return {
      loud: true,
      line: `This page has a password field, and the owner keeps a sign-in for ${origin}: ${listed}. Type the login name as plain text, and the password (or a code) with ${how} into its field: PCP types it, and you never see it. Do not ask the owner for it in the conversation.`,
    }
  }

  return {
    loud: false,
    line: `Sign-ins the owner keeps for ${origin}: ${listed}. To sign in, type one with ${how}; you never see its value.`,
  }
}

/**
 * The note for the tab's page as it is now; null at a page that is no
 * site's, or where the owner keeps no sign-in. A failure leaves it out.
 */
export async function signInHint(
  ctx: VaultContext,
  page: Page,
): Promise<SignInHint | null> {
  const origin = originOf(page.url())

  if (!origin) {
    return null
  }

  try {
    const signIns = await signInsAt(ctx, origin, MAX_SIGN_IN_HINTS)

    if (signIns.length === 0) {
      return null
    }

    return signInLine(origin, signIns, await hasPasswordField(page))
  } catch {
    return null
  }
}
