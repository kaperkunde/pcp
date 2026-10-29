import type { VaultContext } from "../context"
import { PcpError } from "../errors"
import type { OpenedExit } from "../upstream"
import {
  decideExit,
  findExitByName,
  listExitLevels,
  type ExitView,
} from "./exits"

/**
 * An exit as a call names it: whether this token may use it (allowed, ask,
 * or refused with words for the assistant), and opening it for the call.
 * Used by web_fetch (gateway.ts), the owner's answers (permissions.ts) and
 * the browser (through upstream.ts).
 */

export type ExitCheck =
  | { kind: "ok"; exit: ExitView }
  | { kind: "ask"; exit: ExitView }
  | { kind: "refused"; message: string }

/** The exits a token may name: allowed, or asking the owner first. */
export async function usableExitNames(
  ctx: VaultContext,
  tokenId: string,
): Promise<string[]> {
  return (await listExitLevels(ctx, tokenId))
    .filter((exit) => exit.access !== "blocked")
    .map((exit) => exit.name)
}

async function noSuchExit(
  ctx: VaultContext,
  tokenId: string,
  name: string,
): Promise<ExitCheck> {
  const usable = await usableExitNames(ctx, tokenId)

  // An exit the token was never given is not there for it: its name is not
  // confirmed, and nothing asks the owner.
  return {
    kind: "refused",
    message:
      usable.length > 0
        ? `There is no exit called ${name} that this token may use, so nothing was sent. Exits it may use: ${usable.join(", ")}.`
        : `There is no exit called ${name} that this token may use, so nothing was sent. The owner sets which exits a token may use on its page in PCP.`,
  }
}

/** Whether `tokenId` may send through the exit called `name`. */
export async function checkExit(
  ctx: VaultContext,
  tokenId: string,
  name: string,
): Promise<ExitCheck> {
  const exit = await findExitByName(ctx, name)

  if (!exit) {
    return noSuchExit(ctx, tokenId, name)
  }

  const decided = await decideExit(ctx.vaultId, tokenId, exit.id)

  if (decided.access === "blocked") {
    return decided.by === "none"
      ? noSuchExit(ctx, tokenId, name)
      : {
          kind: "refused",
          message: `The owner has blocked the exit ${exit.name} for this token, so nothing was sent.`,
        }
  }

  return decided.access === "ask" ? { kind: "ask", exit } : { kind: "ok", exit }
}

/** Where an exit comes out, for the owner: its name, and its label if any. */
export function exitTitle(exit: Pick<ExitView, "name" | "label">): string {
  return exit.label ? `${exit.name} (${exit.label})` : exit.name
}

/**
 * What the browser is handed for a call (browser/call.ts BrowserScope):
 * whether the token may name an exit, and the exit opened for a tab. A tab
 * dials through `dialer` from its own proxy between requests, so it is the
 * exit's keyless side (upstream.ts OpenedExit.background); each call on the
 * tab opens the exit again, which keeps its connection up while the tab is
 * used and refuses an exit no longer allowed.
 *
 * `open` is upstream.ts openExitForCall (where PCP's key is decrypted).
 * `ownerAllowed` is the exit the owner just allowed once (an exit_use
 * answer): it opens although its level asks.
 */
export type BrowserExits = {
  check: (name: string) => Promise<ExitCheck>
  open: (name: string) => Promise<
    Pick<ExitView, "id" | "name" | "label"> & {
      dialer: OpenedExit["background"]
    }
  >
}

export function browserExits(
  ctx: VaultContext,
  tokenId: string,
  publicUrl: string,
  {
    open,
    ownerAllowed,
  }: {
    open: (
      ctx: VaultContext,
      tokenId: string,
      exit: ExitView,
      options: { publicUrl: string; tool: string },
    ) => Promise<OpenedExit>
    ownerAllowed?: string
  },
): BrowserExits {
  const check = async (name: string): Promise<ExitCheck> => {
    const said = await checkExit(ctx, tokenId, name)
    return said.kind === "ask" && said.exit.id === ownerAllowed
      ? { kind: "ok", exit: said.exit }
      : said
  }

  return {
    check,
    async open(name) {
      const said = await check(name)

      if (said.kind === "refused") {
        throw new PcpError("forbidden", said.message)
      }

      if (said.kind === "ask") {
        throw new PcpError(
          "forbidden",
          `The exit ${said.exit.name} asks the owner first for this token: open a new tab with it (tabs, action open) to ask.`,
        )
      }

      const opened = await open(ctx, tokenId, said.exit, {
        publicUrl,
        tool: "tabs",
      })

      return {
        id: said.exit.id,
        name: said.exit.name,
        label: said.exit.label,
        dialer: opened.background,
      }
    },
  }
}
