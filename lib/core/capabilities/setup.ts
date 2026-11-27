import type { VaultContext } from "../context"
import { db } from "../db"
import { openServiceSpec, SERVICE_SPEC_SELECT } from "../spec-rows"
import { SERVER_META_SELECT, serverName } from "../server-meta"
import { isPcpError } from "../errors"
import { commonRepository } from "../repos/common"
import { itemRoot } from "../repos/layout"
import { findLocalItem } from "../repos/local"
import { listRemote } from "../repos/remote"
import { clientFor } from "../repos/store"
import { readServiceDefinition } from "../services/definition"
import {
  capability,
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
  /**
   * Services in the vault that run one of its items; `signIn`, the server
   * whose sign-in page (/servers/<id>/sign-in) the owner signs in on, when
   * its definition declares a sign-in (services/signin.ts).
   */
  running: Array<{
    id: string
    name: string
    item: string
    signIn: string | null
  }>
  /** Why the repository could not be read, in words. */
  problem: string | null
}

/**
 * The vault's services with the words their image and source tag carry,
 * which is how a common item is known wherever it was launched from, and
 * for one that signs in (services/signin.ts), the server it registered,
 * whose sign-in page it is.
 */
export async function vaultServices(
  ctx: VaultContext,
): Promise<
  Array<{ id: string; name: string; image: string; signIn: string | null }>
> {
  const specs = await db().serviceSpec.findMany({
    where: { server: { vaultId: ctx.vaultId } },
    select: {
      ...SERVICE_SPEC_SELECT,
      registeredId: true,
      server: { select: SERVER_META_SELECT },
    },
    orderBy: { createdAt: "asc" },
  })

  return specs.flatMap((spec) => {
    try {
      const definition = readServiceDefinition(
        openServiceSpec(ctx, spec).definition,
      )

      return [
        {
          id: spec.server.id,
          name: serverName(ctx, spec.server),
          image:
            `${definition.image ?? ""} ${definition.source ?? ""}`.toLowerCase(),
          signIn: definition.signin ? spec.registeredId : null,
        },
      ]
    } catch {
      return []
    }
  })
}

/** The services in the vault running one of these items, however launched. */
async function runningItems(
  ctx: VaultContext,
  items: CommonItem[],
): Promise<CapabilityOffers["running"]> {
  return (await vaultServices(ctx)).flatMap((service) => {
    const item = items.find((candidate) =>
      candidate.sources.some((source) => service.image.includes(source)),
    )

    return item
      ? [
          {
            id: service.id,
            name: service.name,
            item: item.title,
            signIn: service.signIn,
          },
        ]
      : []
  })
}

export async function capabilityOffers(
  ctx: VaultContext,
  id: CapabilityId,
): Promise<CapabilityOffers> {
  const cap = capability(id)

  return { capability: cap, ...(await itemOffers(ctx, cap.items)) }
}

/**
 * What a page offers for these common items: each one's launch at the
 * common repository's head, or the service the vault has, and the services
 * that run one of them already.
 */
export async function itemOffers(
  ctx: VaultContext,
  items: CommonItem[],
): Promise<Omit<CapabilityOffers, "capability">> {
  const running = await runningItems(ctx, items)
  const repo = await commonRepository(ctx)
  // One the vault has already, however it was added (imported from the
  // common items, or proposed by an assistant from the item's own schema
  // address): its own page, whether or not the common items are linked.
  const have = new Map(
    await Promise.all(
      items.map(
        async (item) =>
          [
            item.name,
            await findLocalItem(ctx, {
              kind: item.kind ?? "service",
              name: item.name,
            }),
          ] as const,
      ),
    ),
  )
  const had = (item: CommonItem): ItemOffer | null => {
    const local = have.get(item.name)
    return local ? { item, href: `/servers/${local.id}`, state: "have" } : null
  }

  if (!repo) {
    return {
      repoId: null,
      commit: null,
      offers: items.map(
        (item) => had(item) ?? { item, href: null, state: "launch" },
      ),
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
      items.map(async (item): Promise<ItemOffer> => {
        const ref = { kind: item.kind ?? ("service" as const), name: item.name }
        const root = itemRoot(ref)
        const local = had(item)

        if (local) {
          return local
        }

        if (!listing.items.some((entry) => entry.root === root)) {
          return { item, href: null, state: "absent" }
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
      repoId: repo.id,
      commit: null,
      offers: items.map(
        (item) => had(item) ?? { item, href: null, state: "absent" },
      ),
      running,
      problem: error.message,
    }
  }
}
