import type { VaultContext } from "../context"
import { db } from "../db"
import { SERVER_META_SELECT, serverName } from "../server-meta"
import { invalid, PcpError } from "../errors"
import type { ShownText } from "../permission-rules"
import { imageRepository, IMAGE_BY_DIGEST } from "./definition"
import { resolveDigest } from "./engine"
import type { LoadedService, ServiceAccess, ServiceStatus } from "./services"

/**
 * A newer image for a service: what the owner's "Check for a newer image"
 * reads (on its page, on their click only, never polled), and what an
 * assistant proposes through the service's `update` tool, a
 * `service_change` request that shows the image it runs and the one it
 * would run, both by digest, and updates only to that one, only while the
 * service's definition is as it was when they were asked (`basis`).
 *
 * The newest digest of the definition's `source` tag is resolved on the
 * service's SSH server (engine.ts resolveDigest: a pull, then the digest
 * the engine names), which changes nothing that runs. A digest an
 * assistant names is one of the same repository as the image it runs. A
 * service built from a repository (`build`) is updated by the owner alone,
 * to a new commit, on its page.
 */

/** A digest as an assistant names one: sha256:<64 hex>. */
export const DIGEST = /^sha256:[a-f0-9]{64}$/

/** The update an assistant proposed, as the owner is shown it. */
export type ServiceUpdateAsk = {
  action: "update"
  /** The service's own server. */
  serviceId: string
  name: string
  slug: string
  host: { id: string; name: string }
  /** The image it runs now, by digest. */
  from: string
  /** The image it would run, by digest, in the same repository. */
  to: string
  /** The tag `to` is the newest of; null when the assistant named it. */
  source: string | null
  /** The service's definition hash when asked: the update needs it unchanged. */
  basis: string
  /** The other services of its definition, which see the new image too. */
  instances: string[]
}

export function isServiceUpdate(input: unknown): input is ServiceUpdateAsk {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { action?: unknown }).action === "update"
  )
}

/** What a look for a newer image found. */
export type NewerImage = {
  /** The image the definition pins now. */
  current: string
  /** The newest of `source`, by digest. */
  newest: string
  source: string
  /** The newest is another image than the one pinned. */
  newer: boolean
}

/**
 * The newest digest of the definition's `source` tag, read on the SSH
 * server without making anything again: the owner's check, and what an
 * assistant's proposal shows. Refused for a service with no tag to update
 * from, and for one built from a repository.
 */
export async function newerImageOn(
  loaded: LoadedService,
  access: Pick<ServiceAccess, "host">,
): Promise<NewerImage> {
  const { definition } = loaded

  if (definition.build) {
    throw invalid(
      `${loaded.server.name} is built from ${definition.build.repository} on its SSH server: it is updated to a new commit on its page.`,
    )
  }

  if (!definition.source || !definition.image) {
    throw invalid(
      `${loaded.server.name} names no image to update from (its definition has no source tag): it is updated to a digest named for it.`,
    )
  }

  const source = definition.source
  let newest: string

  try {
    newest = await resolveDigest(access.host, loaded.engine, source)
  } catch (error) {
    throw new PcpError(
      "upstream",
      error instanceof Error ? error.message : String(error),
    )
  }

  return {
    current: definition.image,
    newest,
    source,
    newer: newest !== definition.image,
  }
}

/** The image an update goes to, checked against the one it runs. */
export function checkUpdateImage(
  loaded: Pick<LoadedService, "definition" | "server">,
  image: string,
): string {
  const { definition } = loaded

  if (definition.build || !definition.image) {
    throw invalid(
      `${loaded.server.name} is built from a repository on its SSH server: only the owner updates it, to a new commit, on its page.`,
    )
  }

  if (!IMAGE_BY_DIGEST.test(image)) {
    throw invalid("The image to update to is pinned by digest.")
  }

  if (imageRepository(image) !== imageRepository(definition.image)) {
    throw invalid(
      `${loaded.server.name} runs ${imageRepository(definition.image)}: an update is another digest of that repository, not ${imageRepository(image)}.`,
    )
  }

  return image
}

/**
 * The request an assistant's `update` asks, checked as far as it can be
 * before the owner is: the digest it names, or the newest of the source
 * tag, resolved now. `already` when the service runs that image: nothing
 * to ask.
 */
export async function prepareServiceUpdate(
  loaded: LoadedService,
  access: Pick<ServiceAccess, "host">,
  digest: string | undefined,
): Promise<ServiceUpdateAsk | { already: string }> {
  const { definition } = loaded

  if (definition.build || !definition.image) {
    throw invalid(
      `${loaded.server.name} is built from ${definition.build?.repository ?? "a repository"} on its SSH server: only the owner updates it, to a new commit, on its page.`,
    )
  }

  let to: string
  let source: string | null = null

  if (digest !== undefined) {
    if (!DIGEST.test(digest)) {
      throw invalid("digest is sha256: and 64 hex digits.")
    }

    to = checkUpdateImage(
      loaded,
      `${imageRepository(definition.image)}@${digest}`,
    )
  } else {
    if (!definition.source) {
      throw invalid(
        `${loaded.server.name} names no tag to update from: name the digest to update to (digest), in its repository ${imageRepository(definition.image)}.`,
      )
    }

    const found = await newerImageOn(loaded, access)
    to = found.newest
    source = found.source
  }

  if (to === definition.image) {
    return {
      already: `${loaded.server.name} already runs ${to}${source ? `, the newest ${source}` : ""}: there is nothing to update.`,
    }
  }

  const instances = loaded.server.definitionId
    ? await db().mcpServer.findMany({
        where: {
          definitionId: loaded.server.definitionId,
          vaultId: loaded.server.vaultId,
          id: { not: loaded.server.id },
          kind: "service",
        },
        select: SERVER_META_SELECT,
        orderBy: { createdAt: "asc" },
      })
    : []

  return {
    action: "update",
    serviceId: loaded.server.id,
    name: loaded.server.name,
    slug: loaded.server.slug,
    host: {
      id: loaded.host?.id ?? "",
      name: loaded.host?.name ?? "its SSH server",
    },
    from: definition.image,
    to,
    source,
    basis: loaded.spec.hash,
    instances: instances.map((each) => serverName(loaded.ctx, each)),
  }
}

/** What the owner reads on the request's page: both images, whole. */
export function describeServiceUpdate(ask: ServiceUpdateAsk): {
  title: string
  lines: string[]
  warning: string | null
  full: ShownText[] | null
} {
  return {
    title: `Update ${ask.name} to a new image?`,
    lines: [
      `Runs on your SSH server ${ask.host.name}`,
      `Image now: ${ask.from}`,
      `Image after: ${ask.to}`,
      ask.source
        ? `The newest ${ask.source}, as ${ask.host.name} resolved it when the assistant asked`
        : "A digest the assistant named, in the same repository",
      "PCP pins it on the service's definition and makes its container again from it; its volumes, variables and secrets stay",
      ...(ask.instances.length > 0
        ? [
            `It shares its definition with ${ask.instances.join(", ")}: they show that they run an older image until each is updated on its page`,
          ]
        : []),
    ],
    warning: `PCP will pull ${ask.to} and run it on ${ask.host.name} in place of ${ask.from}. Only agree if you trust the new image.`,
    full: null,
  }
}

/** Updates a service to an image, the owner's (upstream.ts updateService). */
export type ServiceUpdater = (
  ctx: VaultContext,
  id: string,
  change: { image: string; basis: string },
) => Promise<{ status: ServiceStatus; image: string; changed: boolean }>

/**
 * The owner said yes: updates the service to exactly the image they were
 * shown, while its definition is as it was when they were asked.
 */
export async function applyServiceUpdate(
  ctx: VaultContext,
  ask: ServiceUpdateAsk,
  { update }: { update: ServiceUpdater },
): Promise<string> {
  const { status } = await update(ctx, ask.serviceId, {
    image: ask.to,
    basis: ask.basis,
  })
  const others =
    ask.instances.length > 0
      ? ` ${ask.instances.join(", ")} share${ask.instances.length === 1 ? "s" : ""} its definition and run${ask.instances.length === 1 ? "s" : ""} the older image until the owner updates ${ask.instances.length === 1 ? "it" : "each"}.`
      : ""

  return `${ask.name} (${ask.slug}) now runs ${ask.to}: PCP pinned it on its definition and made its container again, which is ${status.state}${status.health === "healthy" ? " and healthy" : ""}.${others}${status.note ? ` ${status.note}` : ""}`
}
