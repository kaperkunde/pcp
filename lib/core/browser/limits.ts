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
/**
 * One click, one typing, one snapshot: also every page's default timeout,
 * and what reading its content or pressing a key is given.
 */
export const ACTION_TIMEOUT_MS = 10_000
/** A page's title, read for an answer or for the list of tabs. */
export const TITLE_TIMEOUT_MS = 2_000
/** The longest wait_for. */
export const MAX_WAIT_MS = 30_000
/** The profile (the sign-ins) as JSON, before encryption. */
export const MAX_PROFILE_BYTES = 8 * 1024 * 1024
/** A profile is saved at most this often while input streams in. */
export const PROFILE_SAVE_INTERVAL_MS = 2_000
/** read_page's text per call, unless the assistant asks for another length. */
export const DEFAULT_READ_CHARS = 20_000
export const MAX_READ_CHARS = 50_000
/**
 * A screenshot as it is kept: its quality, then its size, drops until it
 * fits what an answer passes on inline (MAX_ANSWER_IMAGE_CHARS, answers.ts),
 * and one that never does is kept, up to this, and handed back as a handle.
 */
export const MAX_SCREENSHOT_BYTES = 1024 * 1024
/** The JPEG qualities screenshot steps through, and the most it may ask. */
export const SCREENSHOT_QUALITIES = [70, 55, 40, 30] as const
export const MIN_SCREENSHOT_QUALITY = 10
export const MAX_SCREENSHOT_QUALITY = 90
/**
 * The sizes it then steps down through, as parts of the width asked for,
 * at this quality (or the one asked for, when lower).
 */
export const SCREENSHOT_SCALED_QUALITY = 40
export const SCREENSHOT_SCALES = [0.75, 0.5, 0.35, 0.25] as const
/** The narrowest picture screenshot's max_width may ask for, in pixels. */
export const MIN_SCREENSHOT_WIDTH = 200
/** The size every tab renders at, in CSS pixels. */
export const VIEWPORT = BROWSER_VIEWPORT
/**
 * The screen a page is told it has, and the virtual display's (display.ts):
 * a common desktop screen. Headless, it would otherwise be the viewport
 * itself, which tells a site no person is looking. Headless, the window
 * stays the viewport too (Playwright sizes it so); on the virtual display
 * Chromium draws its own window around the page.
 */
export const SCREEN = { width: 1920, height: 1080 } as const
/**
 * Where a window of the browser's own (launch.ts, mode "window": the
 * desktop app) is put, out of the owner's way: far to the left of any
 * screen, past any row of screens a desk holds, its top on the main
 * screen's top edge (macOS keeps a window's top edge on a screen, not its
 * left one). Not -32000, which Windows uses for a minimized window.
 */
export const OFF_SCREEN_WINDOW = { x: -20_000, y: 0 } as const
/**
 * Where that window tells its page it is (screenX, screenY), on the SCREEN
 * above: where Chromium puts a first window on a screen of its own, ten
 * pixels in from the corner.
 */
export const SHOWN_WINDOW_POSITION = { x: 10, y: 10 } as const
/** The virtual display (display.ts) has this long to start. */
export const DISPLAY_START_TIMEOUT_MS = 10_000
/** JPEG quality of the live view's frames. */
export const SCREENCAST_QUALITY = 55
/** People watching one tab at once. */
export const MAX_VIEWERS_PER_TAB = 4
/** One batch of the owner's input, as it is posted. */
export const MAX_INPUT_BATCH_BYTES = 64 * 1024
export const MAX_INPUT_EVENTS = 500
/**
 * Batches of input per session: the live view sends one every 40 ms while
 * the mouse moves (25 a second), with room to spare.
 */
export const INPUT_BATCHES = { max: 300, windowMs: 10_000 }
/**
 * Input is replayed with the cadence it was made with, at least this far
 * behind real time. Input that arrives late (a slow or uneven link) moves
 * the replay further behind, up to the most, so what follows plays at its
 * own pace rather than in a burst; input more than INPUT_RESYNC_MS late
 * starts a new clock instead.
 */
export const INPUT_REPLAY_DELAY_MS = 60
export const MAX_INPUT_REPLAY_DELAY_MS = 400
export const INPUT_RESYNC_MS = 600
/**
 * A mouse move Chromium has not acknowledged after this long means it is
 * behind: further moves are dropped until it catches up (clicks and keys
 * never are), so the owner's input does not pile up seconds deep.
 */
export const MAX_INPUT_BACKLOG_MS = 1_000
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
/** A role and an accessible name, as a target names an element. */
export const MAX_ROLE_CHARS = 40
export const MAX_TARGET_NAME_CHARS = 300
export const MAX_TARGET_NTH = 999
/** Elements a target that matches none, or several, lists to choose from. */
export const MAX_TARGET_CANDIDATES = 10
/** An element's name as find, or a refusal, quotes it. */
export const MAX_ELEMENT_NAME_CHARS = 200
/** The snapshot an action that failed answers with. */
export const MAX_FAILURE_SNAPSHOT_CHARS = 4_000
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
/**
 * Files upload_file puts into a page in one call, and their bytes together:
 * Playwright hands a file to the page as bytes up to 50 MB in all, and
 * refuses more (it would need the file on disk, which the browser does not
 * keep). Each is a kept result, so also no larger than PCP keeps of one.
 */
export const MAX_UPLOAD_FILES = 20
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
/**
 * A download (downloads.ts): after the click or the address, how long the
 * page has to start one, and how long it then has to finish. Its size is
 * what PCP keeps of one file (resourceLimits()), and one larger is stopped
 * as soon as Chromium says so.
 */
export const DOWNLOAD_START_MS = 10_000
export const DOWNLOAD_TIMEOUT_MS = 120_000
/**
 * How long one tool call may hold its tab (calls on one tab run one at a
 * time, each tab apart from the others). Past it the tab is taken to have
 * stopped responding: its page is closed and opened again at its address,
 * and the next call goes on. It is above the longest a call takes when the
 * page answers: a page load, and the second one Chromium sometimes starts
 * leaving an error page, a site's check, and the snapshot and title after.
 */
export const TAB_DEADLINE_MS =
  2 * NAVIGATION_TIMEOUT_MS + CHALLENGE_WAIT_MS + 2 * ACTION_TIMEOUT_MS
/**
 * A download's call holds its tab longer: the address opened or the
 * element clicked, the download's start, and the download itself.
 */
export const DOWNLOAD_DEADLINE_MS =
  NAVIGATION_TIMEOUT_MS +
  2 * ACTION_TIMEOUT_MS +
  DOWNLOAD_START_MS +
  DOWNLOAD_TIMEOUT_MS
/**
 * What holds the whole browser, briefly: opening or closing a tab, taking
 * a popup in as a tab, closing the browser (its profile saved first).
 */
export const BROWSER_LOCK_DEADLINE_MS = 30_000
