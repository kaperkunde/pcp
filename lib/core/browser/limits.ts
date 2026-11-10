import { BROWSER_VIEWPORT, MAX_SIGN_IN_IMPORT_BYTES } from "../constants"
import { PACING_MAX_WAIT_MS } from "../pacing/limits"

/**
 * Bounds on what the browser makes PCP do. Addresses, text to type and
 * how long to wait come from an assistant; pages and input from the web
 * and from the owner's screen: nothing about one of them may cost more than
 * these.
 */

/** Tabs open at once in a vault's browser, assistants' and the owner's. */
export const MAX_TABS = 8
/*
 * How long the browser stays open with nothing happening is the owner's
 * (Settings → Resources): `resourceLimits().browserIdleMs`, see idle.ts.
 */
/** One page load, with its redirects. */
export const NAVIGATION_TIMEOUT_MS = 30_000
/**
 * One click, one typing, one snapshot: also every page's default timeout,
 * and what reading its content or pressing a key is given.
 */
export const ACTION_TIMEOUT_MS = 10_000
/** A page's title, read for an answer or for the list of tabs. */
export const TITLE_TIMEOUT_MS = 2_000
/**
 * A tab's icon, as the page served it to Chromium (favicon.ts): a larger
 * one is left out, and the list shows the site's first letter instead.
 */
export const MAX_FAVICON_BYTES = 16 * 1024
/**
 * What Chromium keeps of the responses a tab's DevTools session sees until
 * the tab's logs start (devtools.ts, which then keeps more for
 * network_log's bodies, MAX_NETWORK_BODY_BYTES): a response over
 * MAX_FAVICON_BYTES is not kept at all, and these at most together.
 */
export const FAVICON_BUFFER_BYTES = 512 * 1024
/** The longest wait_for. */
export const MAX_WAIT_MS = 30_000
/** The profile (the sign-ins) as JSON, before encryption. */
export const MAX_PROFILE_BYTES = 8 * 1024 * 1024
/**
 * An owner's import of sign-ins made elsewhere (sign-in-import.ts): the
 * text pasted or uploaded, the cookies in it (Chromium keeps about 3,300 in
 * all) and the origins whose local storage it carries.
 */
export const MAX_IMPORT_BYTES = MAX_SIGN_IN_IMPORT_BYTES
export const MAX_IMPORT_COOKIES = 3_000
export const MAX_IMPORT_ORIGINS = 500
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
/**
 * screenshot's full_page: the most of a page it takes, down and across, in
 * CSS pixels (Chromium draws no larger picture in one piece). A longer page
 * is taken from its top, and the answer says it was cut.
 */
export const MAX_FULL_PAGE_HEIGHT = 16_000
export const MAX_FULL_PAGE_WIDTH = 4 * BROWSER_VIEWPORT.width
/** print_pdf's page_ranges, in characters. */
export const MAX_PDF_PAGE_RANGES_CHARS = 100
/**
 * print_pdf: Chromium's print is given ACTION_TIMEOUT_MS and a second more
 * for every this many CSS pixels of the page's height, up to
 * PRINT_PDF_MAX_MS (well inside TAB_DEADLINE_MS); the PDF is read in
 * chunks of PDF_READ_BYTES and stopped past the largest file PCP keeps.
 */
export const PRINT_PDF_PX_PER_SECOND = 2_000
export const PRINT_PDF_MAX_MS = 60_000
export const PDF_READ_BYTES = 1024 * 1024
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
 * A tab's ref map (refs.ts): the elements of its latest snapshot it gives
 * refs to (one past this is shown without one), and the elements out of
 * that snapshot for now it remembers, so one that shows again (a dialog
 * over it closed) gets its ref back.
 */
export const MAX_PAGE_REFS = 20_000
export const MAX_GONE_REFS = 2_000
/**
 * read_page's text from the page's HTML shorter than this, in characters
 * that are not white space, is next to none: read_page gives the text of
 * the accessibility snapshot instead, when that has more.
 */
export const MIN_READ_PAGE_TEXT_CHARS = 40
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
/** How long settle waits for what an action started to load. */
export const SETTLE_MS = 5_000
/**
 * The most a call waits on its tab for its turn at the site under pacing
 * (lib/core/pacing/, pacing's own PACING_MAX_WAIT_MS), with the time a page
 * opened first takes to settle: a paced call holds its tab this much
 * longer before the tab counts as not responding.
 */
export const PACED_TURN_WAIT_MS = PACING_MAX_WAIT_MS + SETTLE_MS
/** TAB_DEADLINE_MS for a paced call. */
export const PACED_TAB_DEADLINE_MS = TAB_DEADLINE_MS + PACED_TURN_WAIT_MS
/**
 * timeout_ms (call.ts): how long a browser call waits, in all, before it is
 * answered with a `timeout` tool error naming the step it was at. tabs
 * open, navigate and snapshot wait DEFAULT_CALL_TIMEOUT_MS unless the call
 * says otherwise; the other tools wait for their tab's deadline alone
 * unless timeout_ms is given. A default wait is lengthened by
 * CHALLENGE_WAIT_MS while a site's check is up, so it does not cut short
 * a check that passes on its own; one the call gave is kept to.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 10_000
export const MIN_CALL_TIMEOUT_MS = 1_000
export const MAX_CALL_TIMEOUT_MS = 120_000
/**
 * A lane (queue.ts) refuses a call with `browser_busy` rather than queue it
 * when this many calls already wait behind the one running, or when the
 * wait it can expect is longer than the call would wait (its timeout_ms,
 * else MAX_QUEUE_WAIT_MS). The wait is reckoned from the turns the lane
 * took lately, a turn it has no history for counting EXPECTED_TURN_MS.
 */
export const MAX_LANE_QUEUE = 6
export const MAX_QUEUE_WAIT_MS = 60_000
export const EXPECTED_TURN_MS = 2_000
/**
 * A tab nobody used for this long is closed at the next browser call
 * (sweep.ts, from call.ts), as is one whose run (run_code's, or a
 * wrapper's) has ended and that nothing used for RUN_TAB_GRACE_MS since:
 * at once when a tab is wanted and the browser is full.
 */
export const TAB_IDLE_TTL_MS = 30 * 60_000
export const RUN_TAB_GRACE_MS = 2 * 60_000
/**
 * What snapshot, find and read_page look for that their tree leaves out
 * (unseen.ts): iframes, at most this many looked at, and canvases at least
 * this wide and high in CSS pixels (smaller ones are icons and the like).
 */
export const MAX_UNSEEN_FRAMES = 10
export const MIN_UNSEEN_SIZE_PX = 40
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
/**
 * The frames of a page whose password fields are read to mask their
 * values in a snapshot (snapshot.ts): more than any page has.
 */
export const MAX_MASKED_FRAMES = 50
/**
 * A secret PCP typed is also looked for in every answer as the page may
 * write it back reformatted (held.ts): white space and separators taken
 * out, upper case. A value shorter than this, read that way, is masked as
 * a whole word only: shorter ones would mask ordinary text.
 */
export const MIN_NORMALISED_MASK_CHARS = 6
/**
 * The most of the owner's sign-ins at a page's site that navigate, snapshot
 * and tabs open name (sign-in-hint.ts).
 */
export const MAX_SIGN_IN_HINTS = 5
/** The most sites request_secret names for a new secret. */
export const MAX_SECRET_REQUEST_ORIGINS = 10
/** How long request_secret's purpose may be. */
export const MAX_SECRET_PURPOSE_CHARS = 500
/**
 * One sign-in on a once allowance (browser-secrets.ts): after one part of a
 * secret (its login name or its password) is typed on it, the other part
 * may follow once, in the same tab at the same site, within this long.
 */
export const SECRET_SIGN_IN_WINDOW_MS = 2 * 60_000
/** The most open sign-in windows kept in memory, oldest dropped first. */
export const MAX_SECRET_SIGN_IN_WINDOWS = 1_000
/**
 * An assistant's mouse (input.ts clickAt, wheelAt, dragBetween): the moves
 * a drag is made of between its two points, and the pause between them, so
 * a page that follows the pointer sees it travel.
 */
export const DRAG_STEPS = 12
export const DRAG_STEP_MS = 16
/**
 * evaluate (evaluate.ts): the script's text, how long it may run (its own
 * work and any promise it returns), the most of its result as JSON that is
 * kept at all, and what an answer carries inline before the rest becomes a
 * kept result.
 */
export const MAX_SCRIPT_CHARS = 20_000
export const EVALUATE_TIMEOUT_MS = 10_000
export const MAX_EVALUATE_RESULT_CHARS = 1_000_000
export const EVALUATE_INLINE_CHARS = 20_000
/**
 * The tab's logs (devtools.ts): what each keeps of its newest entries, an
 * entry's text and an address as they are shown, and how many one call
 * lists.
 */
export const MAX_CONSOLE_ENTRIES = 500
export const MAX_NETWORK_ENTRIES = 1_000
export const MAX_CONSOLE_TEXT_CHARS = 2_000
export const MAX_LOG_URL_CHARS = 2_000
export const MAX_HEADER_VALUE_CHARS = 1_000
export const DEFAULT_LOG_LIMIT = 50
export const MAX_LOG_LIMIT = 200
/**
 * What Chromium keeps of a tab's responses for network_log's bodies (and
 * the icon, favicon.ts): a response over the first is not kept at all, and
 * these at most together, the oldest going first. A request's body is
 * read as Chromium kept it, up to the same size.
 */
export const MAX_NETWORK_BODY_BYTES = 1024 * 1024
export const NETWORK_BUFFER_BYTES = 8 * 1024 * 1024
