/**
 * Bounds on what run_code makes PCP do. The program comes from an assistant
 * and runs on the owner's machine, and whatever its calls bring back comes
 * from the owner's servers: nothing about one run may cost more than these.
 */

/** The program's text. */
export const MAX_CODE_CHARS = 100_000
/**
 * One run from start to end, the tool calls it waits on included. Under
 * what Claude's apps wait for a tool, so the run ends with an answer rather
 * than the call timing out.
 */
export const RUN_TIMEOUT_MS = 3 * 60_000
/** Time the program itself spends computing, waiting on calls not counted. */
export const RUN_CPU_MS = 15_000
/** Memory the program's engine may hold. */
export const RUN_MEMORY_BYTES = 128 * 1024 * 1024
/** How deep the program's own calls may nest. */
export const RUN_STACK_BYTES = 1024 * 1024
/** Runs at once in this process, for every token together. */
export const MAX_CONCURRENT_RUNS = 4
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
/**
 * The most of one tool's answer a program is handed, in characters of JSON.
 * Its longest texts are kept as results first; an answer still longer is an
 * error the program can catch.
 */
export const MAX_CODE_ANSWER_CHARS = 4_000_000
/** One call's arguments, as JSON. */
export const MAX_CALL_ARGS_CHARS = 4_000_000
/** What the program prints, in characters; the rest is dropped and counted. */
export const MAX_OUTPUT_CHARS = 1_000_000
/** What the program returns, as JSON. */
export const MAX_RETURN_CHARS = 4_000_000
/** An error's message and stack, as the assistant reads it. */
export const MAX_ERROR_CHARS = 4_000

/**
 * The sandbox container (sandbox.ts): one message between PCP and its
 * runner, as a line of JSON. Above a call's arguments and an answer, with
 * room for escaping.
 */
export const MAX_SANDBOX_MESSAGE_BYTES = 24 * 1024 * 1024
/**
 * How long PCP waits for the runner to say a run it was told to stop has
 * ended, before giving up on it.
 */
export const SANDBOX_STOP_GRACE_MS = 10_000
