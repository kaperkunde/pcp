import type { VaultContext } from "../context"
import { db } from "../db"
import { loadGatewayServers, listedTools } from "../gateway-servers"

/**
 * An OCR tool the token can call, for the hint that goes with a picture
 * of a page (screenshot, and what snapshot, find and read_page say they
 * cannot see): an assistant cannot read the text in an image through
 * read_result, and a page's frames, closed shadow roots and canvases do
 * not show in its tree. Found by words alone, as search would (OCR in the
 * tool's name, description or arguments, "force_ocr" or "tesseract"),
 * never by naming a vendor: whatever the owner added that does OCR.
 */

export type OcrTool = {
  /** "server/tool", as assistants refer to tools. */
  name: string
  /** It takes force_ocr: the hint says to set it. */
  forceOcr: boolean
}

const OCR_WORDS = /(^|[^a-z])ocr([^a-z]|$)|optical character|tesseract/i
/** At most this many of the token's tools are read for their arguments. */
const MAX_SCHEMAS_READ = 200

function mentionsOcr(text: string | null | undefined): boolean {
  return !!text && OCR_WORDS.test(text)
}

/**
 * The best OCR tool the token may call, or null: one it may call without
 * asking first before one that asks, then one that says OCR in its name or
 * description before one that only takes it as an argument. The browser
 * server's own tools never count.
 */
export async function ocrToolFor(
  ctx: VaultContext,
  tokenId: string,
): Promise<OcrTool | null> {
  const token = await db().apiToken.findUnique({
    where: { id: tokenId },
    select: {
      vaultId: true,
      allowAllServers: true,
      servers: { select: { serverId: true } },
    },
  })

  if (!token || token.vaultId !== ctx.vaultId) {
    return null
  }

  const servers = (
    await loadGatewayServers({
      ctx,
      tokenId,
      serverIds: token.allowAllServers
        ? null
        : token.servers.map((row) => row.serverId),
    })
  ).filter((server) => server.kind !== "browser")
  const tools = servers.flatMap((server) =>
    listedTools(server).map((tool) => ({ server, tool })),
  )

  if (tools.length === 0) {
    return null
  }

  const schemas = new Map(
    (
      await db().mcpTool.findMany({
        where: {
          id: {
            in: tools.slice(0, MAX_SCHEMAS_READ).map(({ tool }) => tool.id),
          },
        },
        select: { id: true, inputSchema: true },
      })
    ).map((row) => [row.id, row.inputSchema]),
  )

  let best: { rank: number; found: OcrTool } | null = null

  for (const { server, tool } of tools) {
    const schema = schemas.get(tool.id) ?? ""
    const named =
      mentionsOcr(tool.name) ||
      mentionsOcr(tool.title) ||
      mentionsOcr(tool.descriptionOverride ?? tool.description)
    const forceOcr = /"force_ocr"/.test(schema)

    if (!named && !forceOcr && !mentionsOcr(schema)) {
      continue
    }

    const rank = (tool.access === "allowed" ? 0 : 2) + (named ? 0 : 1)

    if (!best || rank < best.rank) {
      best = { rank, found: { name: `${server.slug}/${tool.name}`, forceOcr } }
    }
  }

  return best?.found ?? null
}

/** How to read the text in a picture, naming the token's OCR tool when it has one. */
export function ocrHint(tool: OcrTool | null): string {
  return tool
    ? `pass its handle to ${tool.name}${tool.forceOcr ? " with force_ocr: true" : ""} (an OCR tool this token can call)`
    : "pass its handle to read_image, which runs the OCR providers this token may use or answers with a link to set one up"
}
