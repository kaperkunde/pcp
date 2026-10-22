/**
 * Bounds on what run_code makes PCP do. The program comes from an assistant
 * and runs on the owner's machine, and whatever its calls bring back comes
 * from the owner's servers: nothing about one run may cost more than these.
 *
 * Those that follow the machine and the owner's settings are in
 * lib/core/resources/ (`resourceLimits()`): a program's memory, how many run
 * at once, the most of one answer, read or call's arguments a program
 * handles and returns (the largest file as base64), and the size of a
 * message to and from the sandbox's runner.
 */

/** The program's text. */
export const MAX_CODE_CHARS = 100_000
/**
 * One run from start to end, the tool calls it waits on included. Under
 * what Claude's apps wait for a tool, so the run ends with an answer rather
 * than the call timing out.
 */
export const RUN_TIMEOUT_MS = 3 * 60_000
/**
 * How long run_code holds its call before it answers: under the minute after
 * which Claude Code gives up on a tool call. A program not done by then goes
 * on (within RUN_TIMEOUT_MS) and the answer says so, with its run id for
 * check_run; check_run holds its call as long, waiting for the end.
 */
export const RUN_ANSWER_MS = 45_000
/**
 * How often a call that holds a run open sends a progress notification,
 * when the client asked for them (a progressToken).
 */
export const RUN_PROGRESS_MS = 15_000
/**
 * How long after a run ended the same program from the same token is
 * answered with that run instead of being started again (rerun: true
 * starts it all the same). A run still going is always answered so.
 */
export const DUPLICATE_RUN_MS = 5 * 60_000
/**
 * How long PCP remembers a run, for check_run: as long as its outcome is
 * kept (lib/core/tool-results.ts). Only in memory; a restart forgets them.
 */
export const REMEMBERED_RUN_MS = 24 * 60 * 60_000
/** Runs remembered at most, the oldest ended ones forgotten first. */
export const MAX_REMEMBERED_RUNS = 2_000
/** Time the program itself spends computing, waiting on calls not counted. */
export const RUN_CPU_MS = 15_000
/** How deep the program's own calls may nest. */
export const RUN_STACK_BYTES = 1024 * 1024
/** Tool calls one run may make. */
export const MAX_CALLS_PER_RUN = 100
/** Tool calls of one run under way at the same time; the rest wait. */
export const MAX_PARALLEL_CALLS = 5
/** Values one run may keep as results (pcp.keep). */
export const MAX_KEEPS_PER_RUN = 50
/** Kept results one run may read (pcp.read). */
export const MAX_READS_PER_RUN = 50
/** Random bytes one crypto.getRandomValues fills, as the web allows. */
export const MAX_RANDOM_BYTES = 65_536
/** What the program prints, in characters; the rest is dropped and counted. */
export const MAX_OUTPUT_CHARS = 1_000_000
/**
 * A step's name (pcp.step, a wrapper's or run_code's), in characters: a
 * longer one is cut, in the trace and in the error that names it.
 */
export const MAX_STEP_NAME_CHARS = 100
/** An error's message and stack, as the assistant reads it. */
export const MAX_ERROR_CHARS = 4_000

/**
 * How long PCP waits for the runner to say a run it was told to stop has
 * ended, before giving up on it.
 */
export const SANDBOX_STOP_GRACE_MS = 10_000
