import { BROWSER_VIEWPORT } from "../constants"

/**
 * Bounds on what the browser makes PCP do. Addresses, text to type and
 * how long to wait come from an assistant; pages and input from the web
 * and from the owner's screen: nothing about one of them may cost more than
 * these.
 */

/** Tabs open at once in a vault's browser, assistants' and the owner's. */
export const MAX_TABS = 8
/** With no tool call, no input and nobody watching, the browser closes. */
export const IDLE_CLOSE_MS = 15 * 60_000
/** One page load, with its redirects. */
export const NAVIGATION_TIMEOUT_MS = 30_000
/** One click, one typing, one snapshot. */
export const ACTION_TIMEOUT_MS = 10_000
/** The longest wait_for. */
export const MAX_WAIT_MS = 30_000
/** The profile (the sign-ins) as JSON, before encryption. */
export const MAX_PROFILE_BYTES = 8 * 1024 * 1024
/** A profile is saved at most this often while input streams in. */
export const PROFILE_SAVE_INTERVAL_MS = 2_000
/** read_page's text per call, unless the assistant asks for another length. */
export const DEFAULT_READ_CHARS = 20_000
export const MAX_READ_CHARS = 50_000
/** A screenshot as it is handed back; its quality drops until it fits. */
export const MAX_SCREENSHOT_BYTES = 1024 * 1024
/** The size every tab renders at, in CSS pixels. */
export const VIEWPORT = BROWSER_VIEWPORT
/**
 * The screen and window a page is told it has: a common desktop screen,
 * and a window a little larger than the viewport (a browser's frame and
 * toolbar), as a desktop browser's are. Headless, both would otherwise be
 * the viewport itself, which tells a site no person is looking.
 */
export const SCREEN = { width: 1920, height: 1080 } as const
export const WINDOW = {
  width: VIEWPORT.width,
  height: VIEWPORT.height + 100,
} as const
/** JPEG quality of the live view's frames. */
export const SCREENCAST_QUALITY = 55
/** People watching one tab at once. */
export const MAX_VIEWERS_PER_TAB = 4
/** One batch of the owner's input, as it is posted. */
export const MAX_INPUT_BATCH_BYTES = 64 * 1024
export const MAX_INPUT_EVENTS = 500
/** Batches of input per session: about 25 a second while the mouse moves. */
export const INPUT_BATCHES = { max: 200, windowMs: 10_000 }
/**
 * Input is replayed with the cadence it was made with, this far behind
 * real time; a batch that arrives later than this is replayed at once.
 */
export const INPUT_REPLAY_DELAY_MS = 60
export const INPUT_RESYNC_MS = 600
/** Tool calls per token, asked about or not. */
export const BROWSER_ACTIONS = { max: 300, windowMs: 10 * 60_000 }
/** What an assistant may say to the owner when it hands a tab over. */
export const MAX_HANDOVER_MESSAGE = 1000
export const MAX_URL_LENGTH = 8192
/** Text an assistant types in one call. */
export const MAX_TYPE_CHARS = 10_000
/** A connection the browser's proxy opens. */
export const PROXY_CONNECT_TIMEOUT_MS = 10_000
/** A page's alert or prompt nobody answers is dismissed after this. */
export const DIALOG_DISMISS_MS = 60_000
/** Matches find returns. */
export const MAX_FIND_MATCHES = 50
/**
 * A site's check of its visitors (Cloudflare's "Just a moment…") that
 * passes on its own does so in a few seconds; past this, a tab or a page
 * read for web_fetch stops waiting and says so.
 */
export const CHALLENGE_WAIT_MS = 20_000
/** Pages the browser reads for web_fetch at once, per vault (not tabs). */
export const MAX_SOLVES = 2
/**
 * One web_fetch read through the browser, from start to text: starting
 * Chromium, the page, and waiting for its check. web_fetch's own request
 * came first, so an assistant waits for both at worst.
 */
export const SOLVE_TIMEOUT_MS = 45_000
/**
 * A site that checked its visitors is read through the browser first for
 * this long, while the browser still holds what passing the check gave it
 * (Cloudflare's clearance commonly lasts half an hour).
 */
export const CLEARANCE_MEMORY_MS = 30 * 60_000
/**
 * Installing Chromium (install.ts): Playwright's archive for 1.63 is
 * 191 to 205 MB, depending on the platform (Windows the largest). The
 * download gives up after this long in all, or this long without a byte.
 */
export const MAX_CHROMIUM_DOWNLOAD_BYTES = 512 * 1024 * 1024
export const CHROMIUM_DOWNLOAD_TIMEOUT_MS = 30 * 60_000
export const CHROMIUM_DOWNLOAD_STALL_MS = 60_000
