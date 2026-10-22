import type { VaultContext } from "../context"
import { PcpError } from "../errors"
import { writeManagedSecret } from "../secrets"

import {
  githubEndpoints,
  pollDeviceFlow,
  startDeviceFlow,
  type GitHubEndpoints,
} from "./github"
import {
  GITHUB_OAUTH_CLIENT_ID,
  GITHUB_SCOPES,
  type GitHubScope,
  GITHUB_SIGNIN_SECRET,
} from "./limits"

/**
 * Signing in to GitHub with PCP's own OAuth App, through GitHub's device
 * flow: PCP asks GitHub for a code, the owner types it in at
 * github.com/login/device, and PCP asks whether they did while the page is
 * open (the page calls an action, which calls pollGitHubSignIn, from the
 * owner's session). The device code is kept in memory only, for the vault
 * that started it, until it is used or runs out: nothing waits in the
 * background, and a restart means starting again. The token is saved as a
 * managed secret (kind oauth), which repositories use from then on.
 */

type Flow = {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresAt: number
  intervalMs: number
  nextPollAt: number
}

const flows = new Map<string, Flow>()

/** The client id PCP signs in with; empty while the app is not registered. */
export function githubClientId(): string {
  if (process.env.NODE_ENV !== "production") {
    const fake = process.env.PCP_GITHUB_CLIENT_ID?.trim()

    if (fake) {
      return fake
    }
  }

  return GITHUB_OAUTH_CLIENT_ID
}

export function githubSignInOffered(): boolean {
  return githubClientId() !== ""
}

export type SignInCode = {
  userCode: string
  verificationUri: string
  expiresAt: number
}

export async function startGitHubSignIn(
  ctx: VaultContext,
  {
    endpoints = githubEndpoints(),
    now = Date.now(),
    scope = "public_repo",
  }: { endpoints?: GitHubEndpoints; now?: number; scope?: GitHubScope } = {},
): Promise<SignInCode> {
  if (!GITHUB_SCOPES.includes(scope)) {
    throw new PcpError(
      "validation",
      "Choose public repositories, or private ones too.",
    )
  }

  const clientId = githubClientId()

  if (!clientId) {
    throw new PcpError(
      "state",
      "Signing in with GitHub is not set up in this PCP.",
    )
  }

  const code = await startDeviceFlow({ endpoints }, clientId, scope, now)
  flows.set(ctx.vaultId, { ...code, nextPollAt: now + code.intervalMs })

  return {
    userCode: code.userCode,
    verificationUri: code.verificationUri,
    expiresAt: code.expiresAt,
  }
}

export type SignInState =
  | { status: "waiting"; code: SignInCode }
  | { status: "done"; secretId: string }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "none" }

/**
 * Asks GitHub once whether the owner approved the code, no sooner than
 * GitHub allows (its interval, longer after a slow_down).
 */
export async function pollGitHubSignIn(
  ctx: VaultContext,
  {
    endpoints = githubEndpoints(),
    now = Date.now(),
  }: { endpoints?: GitHubEndpoints; now?: number } = {},
): Promise<SignInState> {
  const flow = flows.get(ctx.vaultId)

  if (!flow) {
    return { status: "none" }
  }

  const code = {
    userCode: flow.userCode,
    verificationUri: flow.verificationUri,
    expiresAt: flow.expiresAt,
  }

  if (now >= flow.expiresAt) {
    flows.delete(ctx.vaultId)
    return { status: "expired" }
  }

  if (now < flow.nextPollAt) {
    return { status: "waiting", code }
  }

  const answer = await pollDeviceFlow(
    { endpoints },
    githubClientId(),
    flow.deviceCode,
  )

  switch (answer.status) {
    case "pending":
      flow.nextPollAt = now + flow.intervalMs
      return { status: "waiting", code }
    case "slow_down":
      flow.intervalMs = Math.max(flow.intervalMs + 5000, answer.intervalMs)
      flow.nextPollAt = now + flow.intervalMs
      return { status: "waiting", code }
    case "expired":
      flows.delete(ctx.vaultId)
      return { status: "expired" }
    case "denied":
      flows.delete(ctx.vaultId)
      return { status: "denied" }
    case "done": {
      flows.delete(ctx.vaultId)
      const { id } = await writeManagedSecret(ctx, {
        name: GITHUB_SIGNIN_SECRET,
        description: "PCP's sign-in to GitHub, for linked repositories.",
        kind: "oauth",
        value: JSON.stringify({
          access_token: answer.accessToken,
          scope: answer.scope,
          token_type: "bearer",
        }),
      })
      return { status: "done", secretId: id }
    }
  }
}

/** Tests: forget every sign-in in progress. */
export function forgetGitHubSignIns(): void {
  flows.clear()
}
