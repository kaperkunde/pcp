import type { VaultContext } from "../context"
import { db } from "../db"
import { findServers } from "../server-meta"
import { openWrapperSpec } from "../spec-rows"
import { assistantBounds, readPacingConfig } from "../pacing/config"
import {
  newFoundPlaces,
  readDefinition,
  secretsTypedByName,
  splitRef,
  type SecretBinding,
} from "../wrappers/definition"
import { typedPartsLabel } from "../wrappers/secret-literals"

import type { ItemDocument, WrapperDocument } from "./documents"
import { itemPath, WRAPPER_YAML } from "./layout"
import { reviewItem, type ItemReview, type ReviewFlag } from "./review"

/**
 * An item's review (review.ts reviewItem), with what only the vault can
 * say: the places a flow's programs would get for the secrets they type
 * into pages by name once it is applied (wrappers/definition.ts
 * foundBindings), against the places the wrapper it lands on has now. That
 * depends on the secrets the vault holds, not on the document alone: a
 * change of text only, applied after the owner added the secret, would
 * still add a place. Each new one is flagged as a place given by name is
 * (`secret_binding`), so the change is never text only and waits for the
 * owner. Nothing to apply (`same`), nothing flagged.
 */
export async function reviewInVault(
  ctx: VaultContext,
  current: ItemDocument | null,
  incoming: ItemDocument,
  currentId: string | null,
): Promise<ItemReview> {
  // A wrapper's pace is flagged against what this owner lets assistants
  // set, not PCP's defaults.
  const review = reviewItem(current, incoming, {
    paceBounds: assistantBounds(await readPacingConfig(ctx)),
  })

  if (
    review.same ||
    (incoming.kind !== "wrapper" && incoming.kind !== "flow")
  ) {
    return review
  }

  const flags = await foundPlaceFlags(ctx, incoming, currentId)

  return flags.length === 0
    ? review
    : {
        ...review,
        flags: [...review.flags, ...flags],
        textOnly: false,
      }
}

async function foundPlaceFlags(
  ctx: VaultContext,
  incoming: WrapperDocument,
  currentId: string | null,
): Promise<ReviewFlag[]> {
  const slugs = [
    ...new Set(
      incoming.tools.flatMap((tool) =>
        tool.calls.flatMap((call) => {
          const split = splitRef(call)
          return split && split.tool === "type" ? [split.slug] : []
        }),
      ),
    ),
  ]

  if (slugs.length === 0) {
    return []
  }

  const browsers = await findServers(ctx, {
    vaultId: ctx.vaultId,
    kind: "browser",
    slug: { in: slugs },
  })

  if (browsers.length === 0) {
    return []
  }

  const typed = await secretsTypedByName(
    ctx,
    incoming.tools.map((tool) => ({
      program: tool.program,
      typers: browsers.filter((server) =>
        tool.calls.includes(`${server.slug}/type`),
      ),
    })),
  )
  // A place the document gives by name takes the place of a found one, and
  // review.ts flags it already when it is new.
  const after: SecretBinding[] = typed
    .filter(
      (entry) =>
        !incoming.secrets.some(
          (binding) =>
            binding.secret === entry.secret &&
            binding.argument === "/text" &&
            browsers.some(
              (server) =>
                server.id === entry.server.id &&
                binding.tool === `${server.slug}/type`,
            ),
        ),
    )
    .map((entry) => ({
      secret: entry.secret,
      secretId: entry.secretId,
      serverId: entry.server.id,
      tool: "type",
      argument: "/text",
      template: "",
      url: entry.server.url,
      found: true,
      parts: entry.parts,
    }))
  const spec = currentId
    ? await db().wrapperSpec.findUnique({ where: { serverId: currentId } })
    : null
  const before = spec
    ? readDefinition(openWrapperSpec(ctx, spec).definition)
    : null
  const path = itemPath(
    { kind: incoming.kind, name: incoming.name },
    WRAPPER_YAML,
  )

  return newFoundPlaces(before, { secrets: after }).map((entry) => ({
    kind: "secret_binding",
    path,
    message: `${incoming.displayName} would type your secret "${entry.secret}" (${typedPartsLabel(entry.parts)}) into pages: its name is written in its program. PCP types it only at the sites you bound it to, or after asking you.`,
  }))
}
