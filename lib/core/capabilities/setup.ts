import type { VaultContext } from "../context"
import { db } from "../db"
import { isPcpError } from "../errors"
import { commonRepository } from "../repos/common"
import { itemRoot } from "../repos/layout"
import { findLocalItem } from "../repos/local"
import { listRemote } from "../repos/remote"
import { clientFor } from "../repos/store"
import { readServiceDefinition } from "../services/definition"
import {
  capability,
  itemOfImage,
  type Capability,
  type CapabilityId,
  type CommonItem,
} from "./list"

/**
 * What a capability's page (/plugins/<id>) offers the owner: each common
 * item that provides it, as a link to launch it from PCP's common items at
 * the repository's current commit (the import page, where they read it
 * whole, pick the SSH server and its secrets), or to the service they have
 * already. PCP's common items not linked yet: the page offers to add them
 * first. Nothing here changes the vault; reading the repository is a
 * request to GitHub made on the owner's page load.
 */

export type ItemOffer = {
  item: CommonItem
  /** Where the owner goes: the launch, or the service they have. */
  href: string | null
  state: "launch" | "have" | "absent"
}

export type CapabilityOffers = {
  capability: Capability
  /** PCP's common items as the vault links them, or null. */
  repoId: string | null
  /** The commit the launch links name: the branch's head when read. */
  commit: string | null
  offers: ItemOffer[]
  /** Services in the vault that run one of its items. */
  running: Array<{ id: string; name: string; item: string }>
  /** Why the repository could not be read, in words. */
  problem: string | null
}

/** The services in the vault running one of these items, however launched. */
async function runningItems(
  ctx: VaultContext,
  items: CommonItem[],
): Promise<CapabilityOffers["running"]> {
  const names = new Set(items.map((item) => item.name))
  const specs = await db().serviceSpec.findMany({
    where: { server: { vaultId: ctx.vaultId } },
    select: { definition: true, server: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  })

  return specs.flatMap((spec) => {
    try {
      const definition = readServiceDefinition(spec.definition)
      const item = itemOfImage(
        `${definition.image ?? ""} ${definition.source ?? ""}`,
      )

      return item && names.has(item.name)
        ? [{ id: spec.server.id, name: spec.server.name, item: item.title }]
        : []
    } catch {
      return []
    }
  })
}

export async function capabilityOffers(
  ctx: VaultContext,
  id: CapabilityId,
): Promise<CapabilityOffers> {
  const cap = capability(id)
  const running = await runningItems(ctx, cap.items)
  const repo = await commonRepository(ctx)

  if (!repo) {
    return {
      capability: cap,
      repoId: null,
      commit: null,
      offers: cap.items.map((item) => ({ item, href: null, state: "launch" })),
      running,
      problem: null,
    }
  }

  try {
    const listing = await listRemote(
      await clientFor(ctx, repo),
      repo,
      repo.branch,
    )
    const offers = await Promise.all(
      cap.items.map(async (item): Promise<ItemOffer> => {
        const ref = { kind: "service" as const, name: item.name }
        const root = itemRoot(ref)

        if (!listing.items.some((entry) => entry.root === root)) {
          return { item, href: null, state: "absent" }
        }

        const local = await findLocalItem(ctx, ref)

        if (local) {
          return { item, href: `/servers/${local.id}`, state: "have" }
        }

        return {
          item,
          href: `/settings/repositories/${encodeURIComponent(repo.id)}/import?${new URLSearchParams(
            { commit: listing.head.commit, root },
          )}`,
          state: "launch",
        }
      }),
    )

    return {
      capability: cap,
      repoId: repo.id,
      commit: listing.head.commit,
      offers,
      running,
      problem: null,
    }
  } catch (error) {
    if (!isPcpError(error)) {
      throw error
    }

    return {
      capability: cap,
      repoId: repo.id,
      commit: null,
      offers: cap.items.map((item) => ({ item, href: null, state: "absent" })),
      running,
      problem: error.message,
    }
  }
}
