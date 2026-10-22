import type { VaultContext } from "./context"
import { findIdenticalDefinitions } from "./definitions"
import { countOutdatedInstructions } from "./instructions"
import { networkNotices } from "./network/runtime"
import { repoNotices } from "./repos/notices"

/**
 * What PCP itself wants the owner to look at, beside the requests from
 * assistants in the header's bell: worked out when the bell is read, from
 * what is stored, so nothing is kept for it. Each kind of notice is one
 * source below; a new feature that needs the owner's eye adds one.
 */

export type OwnerNoticeKind =
  /** The machine's network: HTTPS not renewing, pcp.gg out of reach. */
  | "network"
  /** PCP's suggested instructions changed since tokens copied them. */
  | "instructions"
  /** A linked repository's change waits for review, or is a conflict. */
  | "repos"
  /** API endpoints with the same schema, which could share one definition. */
  | "definitions"

export type OwnerNotice = {
  id: string
  kind: OwnerNoticeKind
  title: string
  href: string
  /** A grey line under the title: what opening it shows. */
  detail?: string
}

type NoticeSource = (ctx: VaultContext) => Promise<OwnerNotice[]>

async function network(): Promise<OwnerNotice[]> {
  return (await networkNotices()).map((notice) => ({
    ...notice,
    kind: "network" as const,
    detail: "Open Settings to see why",
  }))
}

async function instructions(ctx: VaultContext): Promise<OwnerNotice[]> {
  const count = await countOutdatedInstructions(ctx)

  return count > 0
    ? [
        {
          id: "instructions",
          kind: "instructions",
          title: `PCP's suggested instructions changed for ${count} assistant${count === 1 ? "" : "s"}`,
          href: "/tokens/instructions",
          detail: "Keep yours, take PCP's, or merge them",
        },
      ]
    : []
}

const COUNT_WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six"]

/** Endpoints that hold the same schema: merge them into one definition? */
export async function definitionNotices(
  ctx: VaultContext,
): Promise<OwnerNotice[]> {
  return (await findIdenticalDefinitions(ctx)).map((group) => {
    const servers = group.definitions.flatMap((definition) =>
      definition.instances.map((instance) => instance.slug),
    )
    const count = group.definitions.length

    return {
      id: `definitions:${group.key}`,
      kind: "definitions" as const,
      title: `${COUNT_WORDS[count] ?? count} API endpoints have the same schema: merge them?`,
      href: `/servers/merge/${group.key}`,
      detail: servers.join(", "),
    }
  })
}

const SOURCES: NoticeSource[] = [
  network,
  instructions,
  repoNotices,
  definitionNotices,
]

/** Every notice for the owner now, the machine's first. */
export async function listOwnerNotices(
  ctx: VaultContext,
): Promise<OwnerNotice[]> {
  return (await Promise.all(SOURCES.map((source) => source(ctx)))).flat()
}
