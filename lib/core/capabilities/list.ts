import { stem, tokenize } from "../search"

/**
 * Capabilities: things an assistant asks for by what they are (read the
 * text in a picture, fill in a PDF's form, turn a document into Markdown
 * or a PDF's page into a picture) rather than by a tool's name. Each is one of PCP's own tools, always
 * there for every token (read_image, edit_pdf, convert_document); what does
 * the work is a provider: a tool among the token's own that the words in
 * providers.ts find, called at the token's own levels and tiers as
 * execute_* would (gateway.ts forwardCall). With no provider, the tool
 * answers with a link to PCP's page for it (/plugins/<id>), which offers
 * the common items that provide it in one click.
 *
 * Pure: the list, and the words a search names each by.
 */

export const CAPABILITY_IDS = [
  "read_image",
  "pdf_edit",
  "convert_document",
] as const

export type CapabilityId = (typeof CAPABILITY_IDS)[number]

/** A common item (kaperkunde/pcp-gg-common) that provides a capability. */
export type CommonItem = {
  /** Its name there: the service's file is services/<name>.yaml. */
  name: string
  /** What the owner reads it as. */
  title: string
  /** One line: what it is and what it runs. */
  about: string
  /**
   * Words in a service's image or its source tag that mark it as this
   * item, wherever it was launched from (the second signal, after a
   * tool's words).
   */
  sources: string[]
}

export type Capability = {
  id: CapabilityId
  /** PCP's own tool for it. */
  tool: string
  /** The page's title, and what a search's suggestion calls it. */
  title: string
  /** One sentence, for the page and a search's suggestion. */
  summary: string
  /** The page's explanation: what an assistant does with it. */
  explain: string
  /** The few words of the owner's link to its page. */
  label: string
  /** What a search names it by (stemmed when compared). */
  queryWords: string[]
  /** The common items that provide it, best first. */
  items: CommonItem[]
}

const DOCLING: CommonItem = {
  name: "docling",
  title: "Docling",
  about:
    "Turns PDFs, Office documents, web pages and images into Markdown or text, with OCR and table structure. It runs on your SSH server's CPU, no GPU needed.",
  sources: ["docling-serve"],
}

const PDF_MCP: CommonItem = {
  name: "pdf-mcp-server",
  title: "PDF MCP Server",
  about:
    "Reads, fills, flattens, merges, signs and OCRs PDFs (English and Dutch), in Kaperkunde's reviewed fork. It works only on files in its own data volume, and makes no network requests.",
  sources: ["pdf-mcp-server", "pdf-mcp"],
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "read_image",
    tool: "read_image",
    title: "Read images and scans",
    summary:
      "Reads the text in a picture or a scanned page (OCR): a photo of a meter, a receipt, a letter.",
    explain:
      "An assistant can see a picture's handle but not the text in it. With a reader installed, read_image runs every one the assistant may use on the file and compares what they read, so a digit one of them got wrong is flagged rather than passed on.",
    label: "Set up image reading in PCP",
    queryWords: [
      "ocr",
      "read image",
      "read picture",
      "read photo",
      "read scan",
      "scan",
      "scanned",
      "text from image",
      "text in image",
      "text recognition",
      "meter reading",
      "receipt",
      "screenshot text",
    ],
    items: [DOCLING, PDF_MCP],
  },
  {
    id: "pdf_edit",
    tool: "edit_pdf",
    title: "Edit PDFs",
    summary:
      "Fills in a PDF's form, flattens it, merges PDFs into one and places a signature image on a page.",
    explain:
      "An assistant hands edit_pdf a PDF it has (a download, an attachment, a file you uploaded) and gets the edited PDF back as a file, to send, store or show you; nothing passes through the assistant itself.",
    label: "Set up PDF editing in PCP",
    queryWords: [
      "edit pdf",
      "fill pdf",
      "fill form",
      "pdf form",
      "form field",
      "flatten pdf",
      "merge pdf",
      "combine pdf",
      "sign pdf",
      "signature",
    ],
    items: [PDF_MCP],
  },
  {
    id: "convert_document",
    tool: "convert_document",
    title: "Convert documents to text",
    summary:
      "Turns a PDF, Word, PowerPoint, Excel or HTML document into Markdown or plain text.",
    explain:
      "An assistant cannot read a document's file as it is. convert_document turns it into Markdown it can read, quote and summarise, with tables kept as tables where the provider can. It also turns a PDF's page into a picture for view_image to show, with a tool that renders pages, which none of these offer yet: add a server or API endpoint of your own that does.",
    label: "Set up document conversion in PCP",
    queryWords: [
      "convert document",
      "convert pdf",
      "document to text",
      "document to markdown",
      "pdf to text",
      "pdf to markdown",
      "docx",
      "word document",
      "powerpoint",
      "pptx",
      "xlsx",
      "read pdf",
      "read document",
      "extract text",
      "pdf to image",
      "pdf to png",
      "pdf page image",
      "render pdf",
    ],
    items: [DOCLING, PDF_MCP],
  },
]

export function isCapabilityId(value: unknown): value is CapabilityId {
  return (CAPABILITY_IDS as readonly unknown[]).includes(value)
}

export function capability(id: CapabilityId): Capability {
  return CAPABILITIES.find((entry) => entry.id === id)!
}

/** The capability one of PCP's own tools stands for, if it is one. */
export function capabilityOfTool(name: string): Capability | null {
  return CAPABILITIES.find((entry) => entry.tool === name) ?? null
}

/** The address of a capability's page in PCP. */
export function capabilityPage(publicUrl: string, id: CapabilityId): string {
  return `${publicUrl.replace(/\/+$/, "")}/plugins/${id}`
}

/** The common items in a service's image or source tag, by name. */
export function itemOfImage(image: string): CommonItem | null {
  const lower = image.toLowerCase()

  for (const entry of CAPABILITIES) {
    for (const item of entry.items) {
      if (item.sources.some((source) => lower.includes(source))) {
        return item
      }
    }
  }

  return null
}

function stems(text: string): string[] {
  return tokenize(text).map(stem)
}

/**
 * The capabilities a search's query names: every word of one of its
 * phrases in the query (by stem), or the capability's tool by name.
 */
export function capabilitiesNamed(query: string): Capability[] {
  const words = new Set(stems(query))
  const lower = query.toLowerCase()

  return CAPABILITIES.filter(
    (entry) =>
      lower.includes(entry.tool) ||
      entry.queryWords.some((phrase) =>
        stems(phrase).every((word) => words.has(word)),
      ),
  )
}
