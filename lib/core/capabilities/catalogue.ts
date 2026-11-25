import type { ServerKind } from "../servers"
import { stem, tokenize } from "../search"
import {
  DOCLING,
  OPENAI_IMAGES,
  PDF_MCP,
  type CapabilityId,
  type CommonItem,
} from "./list"

/**
 * The catalogue: what PCP can set up for the owner when they ask for it in
 * a conversation ("I'd like to add my Gmail", "Can you connect to my
 * printer?"), beside the capabilities (list.ts), which are tools every token
 * already has. Each entry says what it does and what it takes, in the
 * owner's words, so an assistant whose search names one can tell them in a
 * sentence and then do the work, at most proposing it: the owner launches
 * or adds it on PCP's page.
 *
 * Static and pure: search never reads PCP's common items from GitHub to
 * find one. Whether an entry is set up is read from the vault
 * (catalogue-state.ts).
 */

export const CATALOGUE_IDS = [
  "browser",
  "pdf",
  "documents",
  "images",
  "claude_sessions",
  "embeddings",
  "vpn_exit",
  "bunq",
  "mail",
  "calendar",
  "ssh",
  "whisper",
] as const

export type CatalogueId = (typeof CATALOGUE_IDS)[number]

export type CatalogueEntry = {
  id: CatalogueId
  /** What the owner and a search's line call it. */
  title: string
  /** One sentence: what it does once set up. */
  does: string
  /** One sentence, in the owner's words: what it takes from them. */
  takes: string
  /** What a search names it by (stemmed when compared, every word of one). */
  queryWords: string[]
  /**
   * builtin: part of PCP, added on its own page or proposed with
   * register_server; common_item: a service from PCP's common items
   * (kaperkunde/pcp-gg-common), launched on the owner's SSH server.
   */
  kind: "builtin" | "common_item"
  /** The owner's page for it, a path on PCP's address. */
  page: string
  /** The few words of the owner's link to that page. */
  label: string
  /** How an assistant goes about it, after telling the owner what it takes. */
  how: string
  /** A builtin's server kinds: one of them in the vault is it set up. */
  serverKinds?: ServerKind[]
  /** A common item's item; null when PCP's common items have none yet. */
  item?: CommonItem | null
  /**
   * The image repositories that are it, by the last part of their name
   * (imageName): a service the token sees that runs one is it set up,
   * however it was launched.
   */
  images?: string[]
  /**
   * Set up only by the owner's choice on a settings page, never by a
   * service that merely runs (search by meaning: Settings → Search).
   */
  setting?: "embeddings"
  /** Only the owner sets it up: an assistant never proposes it. */
  ownerOnly?: boolean
  /** The capability it provides, whose own search line says it first. */
  capability?: CapabilityId
}

const CLAUDE_SESSIONS: CommonItem = {
  name: "claude-sessions",
  title: "Claude Code sessions",
  about:
    "Your Claude Code cloud sessions on your own claude.ai login: list them, see what one is doing, send it a message, answer its permission prompts, archive it or start a new one on a repository. It uses Claude Code's unofficial sessions API, for your own use only.",
  sources: ["claude-sessions-mcp"],
}

const EMBEDDINGS: CommonItem = {
  name: "text-embeddings-inference",
  title: "Text Embeddings Inference",
  about:
    "Hugging Face's Text Embeddings Inference with a small open model, on CPU. PCP adds its API as an endpoint and can use it for search, on Settings → Search.",
  sources: ["text-embeddings-inference"],
}

const GLUETUN: CommonItem = {
  name: "gluetun",
  title: "Gluetun",
  about:
    "A VPN client for OpenVPN or WireGuard, with most VPN providers or a WireGuard server of your own. PCP adds it as an exit, so web fetch and the browser can go out through your VPN. It needs the NET_ADMIN capability and /dev/net/tun on the SSH server.",
  sources: ["gluetun"],
}

const BUNQ: CommonItem = {
  name: "bunq",
  title: "bunq",
  about:
    "Kaperkunde's own bunq client: your accounts, balances, payments, payment requests and cards (last four digits only), and draft payments in EUR that only you can accept in the bunq app. It moves no money and connects to api.bunq.com only.",
  sources: ["bunq-mcp"],
}

/**
 * How an assistant goes about a common item: the owner's page, where they
 * read it whole and launch it as it is. Never retyped into register_server:
 * a copy could drift from the item (its digest, its sign-in, its files).
 */
const LAUNCH_ITEM =
  'Hand the owner the link to its page in PCP, where they read it and launch it on their SSH server in one click ("I\'d launch it on your server; approve it here").'

export const CATALOGUE: readonly CatalogueEntry[] = [
  {
    id: "browser",
    title: "The browser",
    does: "Opens web pages for an assistant in a Chromium on PCP's machine: reads them, clicks, fills in forms, and types your passwords without the assistant seeing them.",
    takes: "You install Chromium with one click on PCP's Browser page.",
    queryWords: [
      "browser",
      "browse",
      "chromium",
      "web page",
      "website",
      "fill in form",
      "click button",
      "log in site",
      "sign in site",
    ],
    kind: "builtin",
    page: "/browser",
    label: "Set up the browser in PCP",
    how: "Hand the owner the link to the Browser page; once Chromium is installed, its tools are on the browser server.",
    serverKinds: ["browser"],
  },
  {
    id: "pdf",
    title: "PDF tools",
    does: "Reads, fills in, flattens, merges, splits, redacts, signs and OCRs PDFs, working only on files in its own volume, with no network requests.",
    takes:
      "An SSH server you added to PCP with Docker or Podman on it, where you launch PCP's common item PDF MCP Server in one click.",
    queryWords: [
      "pdf",
      "fill form",
      "pdf form",
      "redact",
      "split pdf",
      "merge pdf",
      "sign pdf",
    ],
    kind: "common_item",
    page: "/plugins/pdf_edit",
    label: "Set up PDF tools in PCP",
    how: LAUNCH_ITEM,
    images: ["pdf-mcp-server", "pdf-mcp"],
    item: PDF_MCP,
    capability: "pdf_edit",
  },
  {
    id: "documents",
    title: "Document conversion",
    does: "Turns PDFs, Word, PowerPoint and Excel files, web pages and images into Markdown or text, with OCR and tables kept as tables.",
    takes:
      "An SSH server you added to PCP with Docker or Podman on it, where you launch PCP's common item Docling with a key you choose for it.",
    queryWords: [
      "convert document",
      "document to text",
      "document to markdown",
      "docx",
      "word document",
      "powerpoint",
      "pptx",
      "xlsx",
      "docling",
    ],
    kind: "common_item",
    page: "/plugins/convert_document",
    label: "Set up document conversion in PCP",
    how: LAUNCH_ITEM,
    images: ["docling-serve", "docling-serve-cpu", "docling-serve-cu124"],
    item: DOCLING,
    capability: "convert_document",
  },
  {
    id: "images",
    title: "Image generation",
    does: "Makes pictures from a description, or changes the ones you give it: illustrations, feature images, logos and mock-ups, kept as files an assistant can send, show you or save in a store.",
    takes:
      "An image service of your own with an API (PCP's common item OpenAI Images is one) and its API key, which you type in on PCP's page; every picture is billed to that account.",
    queryWords: [
      "generate image",
      "generate picture",
      "make image",
      "make picture",
      "create image",
      "create picture",
      "draw",
      "illustration",
      "feature image",
      "text to image",
      "image generation",
    ],
    kind: "common_item",
    page: "/plugins/generate_image",
    label: "Set up image generation in PCP",
    how: 'Hand the owner the link to its page in PCP, where they read the API endpoint and add it with their own key ("I\'d add OpenAI Images; approve it here").',
    item: OPENAI_IMAGES,
    capability: "generate_image",
  },
  {
    id: "claude_sessions",
    title: "Claude Code sessions",
    does: "Lists your Claude Code cloud sessions, shows what one is doing, sends it a message, answers its permission prompts, and starts a new one on a repository.",
    takes:
      "An SSH server you added to PCP with Docker or Podman on it, where you launch PCP's common item Claude Code sessions, then sign in with your own claude.ai account.",
    queryWords: [
      "claude code",
      "claude session",
      "cloud session",
      "coding session",
      "coding agent",
    ],
    kind: "common_item",
    page: "/plugins/claude_sessions",
    label: "Set up Claude Code sessions in PCP",
    how: LAUNCH_ITEM,
    images: ["claude-sessions-mcp"],
    item: CLAUDE_SESSIONS,
  },
  {
    id: "embeddings",
    title: "Search by meaning",
    does: "Lets search find tools, skills and memories by what they mean, not only by their words, with text embeddings made on your own server.",
    takes:
      "An SSH server you added to PCP with Docker or Podman on it, where you launch PCP's common item Text Embeddings Inference and then choose it on Settings → Search.",
    queryWords: [
      "embedding",
      "semantic search",
      "search by meaning",
      "vector search",
    ],
    kind: "common_item",
    page: "/plugins/embeddings",
    label: "Set up search by meaning in PCP",
    how: LAUNCH_ITEM,
    setting: "embeddings",
    item: EMBEDDINGS,
  },
  {
    id: "vpn_exit",
    title: "A VPN exit",
    does: "Lets web fetch and the browser go out through your VPN (OpenVPN or WireGuard, with most VPN providers or a server of your own) rather than from PCP's machine.",
    takes:
      "An SSH server you added to PCP whose Docker or Podman lets a container use NET_ADMIN and /dev/net/tun, and your VPN provider's sign-in; you launch PCP's common item Gluetun there.",
    queryWords: [
      "vpn",
      "wireguard",
      "openvpn",
      "vpn exit",
      "another country",
      "other country",
      "geo block",
    ],
    kind: "common_item",
    page: "/plugins/vpn_exit",
    label: "Set up a VPN exit in PCP",
    how: "Only the owner launches an exit: hand them the link to its page, where they read it and launch it.",
    item: GLUETUN,
    images: ["gluetun"],
    ownerOnly: true,
  },
  {
    id: "bunq",
    title: "bunq",
    does: "Reads your bunq accounts, balances, payments and cards, and prepares draft payments in EUR that only you can accept in the bunq app.",
    takes:
      "An SSH server you added to PCP with Docker or Podman on it, and a bunq API key you make in the bunq app (Profile → Security & Settings → Developers → API keys); you launch PCP's common item bunq there.",
    queryWords: ["bunq", "bank account", "bank balance", "bank payment"],
    kind: "common_item",
    page: "/plugins/bunq",
    label: "Set up bunq in PCP",
    how: LAUNCH_ITEM,
    images: ["bunq-mcp"],
    item: BUNQ,
  },
  {
    id: "mail",
    title: "A mail account",
    does: "Reads, searches, files, drafts and sends mail in an account of yours (Gmail, Outlook, iCloud, Fastmail, or any IMAP or JMAP server); nothing deletes mail for good.",
    takes:
      "The mail server's address and your user name; you type an app password on PCP's page, or sign in there, and the assistant never sees it.",
    queryWords: [
      "mail",
      "email",
      "gmail",
      "inbox",
      "outlook",
      "fastmail",
      "imap",
      "jmap",
      "mailbox",
    ],
    kind: "builtin",
    page: "/servers/mail/new",
    label: "Add a mail account in PCP",
    how: "Propose it with register_server (kind imap, or jmap where the server has it), with the address and user name and the secret by name only; or hand the owner the link to add it themselves.",
    serverKinds: ["jmap", "imap"],
  },
  {
    id: "calendar",
    title: "A calendar account",
    does: "Lists, creates, moves and deletes events and reminders in your calendars (iCloud, Fastmail, Nextcloud, or any CalDAV server), and never invites anyone.",
    takes:
      "The calendar server's address and your user name; you type an app-specific password on PCP's page, and the assistant never sees it.",
    queryWords: [
      "calendar",
      "agenda",
      "appointment",
      "reminder",
      "caldav",
      "icloud calendar",
    ],
    kind: "builtin",
    page: "/servers/calendars/new",
    label: "Add a calendar account in PCP",
    how: "Propose it with register_server (kind caldav), with the address and user name and the secret by name only; or hand the owner the link to add it themselves.",
    serverKinds: ["caldav"],
  },
  {
    id: "ssh",
    title: "An SSH server",
    does: "Runs commands on a machine of yours (a home server, a VPS, a Raspberry Pi beside the printer), and is where services you host and storage folders live.",
    takes:
      "The machine's address and a login on it; PCP makes a key of its own, and you put its public half in that login's ~/.ssh/authorized_keys.",
    queryWords: [
      "ssh",
      "home server",
      "host thing",
      "self host",
      "selfhost",
      "vps",
      "raspberry pi",
      "run command",
      "shell command",
      "printer",
    ],
    kind: "builtin",
    page: "/servers/ssh/new",
    label: "Add an SSH server in PCP",
    how: "Only the owner adds one (register_server has no kind for it): hand them the link, then help with what runs there.",
    serverKinds: ["ssh"],
    ownerOnly: true,
  },
  {
    id: "whisper",
    title: "Whisper transcription",
    does: "Turns speech in a recording (a voice memo, a meeting) into text.",
    takes:
      "An SSH server you added to PCP with Docker or Podman on it, and a Whisper service an assistant writes the definition of for you to approve.",
    queryWords: [
      "whisper",
      "transcribe",
      "transcription",
      "speech to text",
      "voice memo",
    ],
    kind: "common_item",
    page: "/plugins/whisper",
    label: "Set up transcription in PCP",
    how: "PCP's common items have none yet: propose a service with register_server (kind service) with a definition of your own, its image pinned by digest, on an SSH server the owner added; or an MCP server that transcribes, by its address.",
    item: null,
    images: [
      "openai-whisper-asr-webservice",
      "whisper-asr-webservice",
      "faster-whisper-server",
      "speaches",
      "whisper",
    ],
  },
]

/**
 * An image reference's repository name, its last path part without a tag
 * or digest, in lower case: "ghcr.io/kaperkunde/pdf-mcp-server@sha256:…"
 * is "pdf-mcp-server". Matched whole, so "gluetun-webui" is not "gluetun".
 */
export function imageName(image: string): string {
  const bare = image.trim().toLowerCase().split("@")[0]!
  const last = bare.split("/").at(-1) ?? ""

  return last.split(":")[0] ?? ""
}

/** The entries one of these images (or source tags) is, by its name. */
export function entriesOfImages(images: string[]): CatalogueEntry[] {
  const names = new Set(images.map(imageName).filter(Boolean))

  return CATALOGUE.filter((entry) =>
    (entry.images ?? []).some((name) => names.has(name)),
  )
}

export function isCatalogueId(value: unknown): value is CatalogueId {
  return (CATALOGUE_IDS as readonly unknown[]).includes(value)
}

export function catalogueEntry(id: CatalogueId): CatalogueEntry {
  return CATALOGUE.find((entry) => entry.id === id)!
}

function stems(text: string): string[] {
  return tokenize(text).map(stem)
}

/** The entries a search's query names: every word of one of its phrases. */
export function catalogueNamed(query: string): CatalogueEntry[] {
  const words = new Set(stems(query))

  return CATALOGUE.filter((entry) =>
    entry.queryWords.some((phrase) =>
      stems(phrase).every((word) => words.has(word)),
    ),
  )
}

/** The entries whose page is /plugins/<id>: a common item's own page. */
export function pluginEntry(id: string): CatalogueEntry | null {
  return (
    CATALOGUE.find(
      (entry) =>
        entry.kind === "common_item" && entry.page === `/plugins/${id}`,
    ) ?? null
  )
}

/**
 * What a token limited to the servers the owner chose is told beside a
 * "can set up" line: PCP may hold it already, out of this token's reach,
 * and it does not know (nor say) which, so it asks before setting up
 * another.
 */
export const LIMITED_TOKEN_NOTE =
  "This token reaches only the servers the owner chose for it, so they may have this set up already: ask them whether to give this token access to it (on its page in PCP) before setting up another."

/**
 * search's line for an entry this token has not got: what it does, what
 * it takes and how, with the owner's page as a markdown link.
 */
export function canSetUpLine(
  entry: CatalogueEntry,
  ownerLink: string,
  { limited = false }: { limited?: boolean } = {},
): string {
  return `can set up: ${entry.title} — ${entry.does} It takes: ${entry.takes} ${entry.how}${limited ? ` ${LIMITED_TOKEN_NOTE}` : ""} The owner's page: ${ownerLink}`
}
