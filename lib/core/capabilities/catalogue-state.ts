import { chromiumExecutable } from "../browser/executable"
import type { VaultContext } from "../context"
import { db } from "../db"
import { readEmbeddingsConfig } from "../embeddings/config"
import { CATALOGUE, entrySources, type CatalogueId } from "./catalogue"
import { vaultServices } from "./setup"

/**
 * Which catalogue entries the vault has set up, read from the vault inside
 * a request: a builtin by a server of its kind (the browser also needs
 * Chromium on this machine), a common item by a service whose image or
 * source tag is its own, however it was launched; search by meaning also
 * by a provider the owner chose on Settings → Search. Nothing is stored.
 */
export async function setUpEntries(
  ctx: VaultContext,
): Promise<Set<CatalogueId>> {
  const kinds = CATALOGUE.flatMap((entry) => entry.serverKinds ?? [])
  const [rows, services, embeddings] = await Promise.all([
    db().mcpServer.findMany({
      where: { vaultId: ctx.vaultId, kind: { in: kinds } },
      select: { kind: true },
      distinct: ["kind"],
    }),
    vaultServices(ctx),
    readEmbeddingsConfig(ctx),
  ])
  const have = new Set(rows.map((row) => row.kind))
  const done = new Set<CatalogueId>()

  for (const entry of CATALOGUE) {
    const sources = entrySources(entry)

    if (
      entry.serverKinds?.some((kind) => have.has(kind)) ||
      (sources.length > 0 &&
        services.some((service) =>
          sources.some((source) => service.image.includes(source)),
        ))
    ) {
      done.add(entry.id)
    }
  }

  if (embeddings) {
    done.add("embeddings")
  }

  // The browser server is there from the start in some vaults: it is set
  // up once Chromium is on this machine.
  if (done.has("browser") && !(await chromiumExecutable())) {
    done.delete("browser")
  }

  return done
}
