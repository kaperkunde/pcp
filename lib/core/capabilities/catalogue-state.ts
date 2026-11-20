import { chromiumExecutable } from "../browser/executable"
import type { VaultContext } from "../context"
import { db } from "../db"
import { readEmbeddingsConfig } from "../embeddings/config"
import { readServiceDefinition } from "../services/definition"
import { openServiceSpec, SERVICE_SPEC_SELECT } from "../spec-rows"
import { CATALOGUE, entriesOfImages, type CatalogueId } from "./catalogue"
import type { CapabilityId } from "./list"

/**
 * Which catalogue entries a token has, read inside its request from what it
 * reaches, never from the rest of the vault: a token limited to some servers
 * learns nothing of the others by what search offers it. Nothing is stored.
 *
 * - a builtin: a server of its kind among the token's (the browser also
 *   needs Chromium on this machine);
 * - a common item: a service among the token's, or one that registered a
 *   server among them, whose image or source tag is the item's
 *   (catalogue.ts imageName, matched whole), however it was launched;
 * - an entry that provides a capability: also any provider of it among the
 *   token's tools (`hasProvider`), whoever's server it is;
 * - search by meaning: only a provider the owner chose on Settings → Search.
 */
export async function setUpEntries(
  ctx: VaultContext,
  servers: ReadonlyArray<{ id: string; kind: string }>,
  hasProvider: (id: CapabilityId) => Promise<boolean>,
): Promise<Set<CatalogueId>> {
  const ids = servers.map((server) => server.id)
  const kinds = new Set(servers.map((server) => server.kind))
  const [images, embeddings] = await Promise.all([
    serviceImages(ctx, ids),
    readEmbeddingsConfig(ctx),
  ])
  const done = new Set<CatalogueId>(
    entriesOfImages(images).map((entry) => entry.id),
  )

  for (const entry of CATALOGUE) {
    if (entry.serverKinds?.some((kind) => kinds.has(kind))) {
      done.add(entry.id)
    }

    if (
      entry.capability &&
      !done.has(entry.id) &&
      (await hasProvider(entry.capability))
    ) {
      done.add(entry.id)
    }
  }

  // Search by meaning is the owner's choice of a provider, not a service.
  done.delete("embeddings")

  if (embeddings) {
    done.add("embeddings")
  }

  if (done.has("browser") && !(await chromiumExecutable())) {
    done.delete("browser")
  }

  return done
}

/**
 * The images and source tags of the services among these servers, or that
 * registered one of them: a token that reaches only what a service serves
 * has that service's item all the same.
 */
async function serviceImages(
  ctx: VaultContext,
  serverIds: string[],
): Promise<string[]> {
  if (serverIds.length === 0) {
    return []
  }

  const specs = await db().serviceSpec.findMany({
    where: {
      server: { vaultId: ctx.vaultId },
      OR: [
        { serverId: { in: serverIds } },
        { registeredId: { in: serverIds } },
      ],
    },
    select: SERVICE_SPEC_SELECT,
  })

  return specs.flatMap((spec) => {
    try {
      const definition = readServiceDefinition(
        openServiceSpec(ctx, spec).definition,
      )

      return [definition.image ?? "", definition.source ?? ""]
    } catch {
      // A stored definition that no longer reads says nothing.
      return []
    }
  })
}
