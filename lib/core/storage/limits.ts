/**
 * Bounds on storage roots (lib/core/storage/): how much a call lists, finds
 * or removes, and how long one SFTP request may take. The largest file a
 * call reads or saves is not here: it is `resourceLimits().fileBytes`
 * (lib/core/resources/), the largest file PCP keeps.
 */

/** A path a call names, in characters. */
export const MAX_PATH_CHARS = 4096
/** One name in a path, in bytes of UTF-8 (what most file systems allow). */
export const MAX_NAME_BYTES = 255
/** Entries list_folder answers with at once. */
export const MAX_LIST_ENTRIES = 1000
/** Matches find_files answers with at most, and by default. */
export const MAX_FIND_RESULTS = 500
export const DEFAULT_FIND_RESULTS = 100
/** Folders find_files looks in before it stops and says so. */
export const MAX_FIND_FOLDERS = 2000
/** How deep find_files and a recursive delete go below where they start. */
export const MAX_DEPTH = 32
/** Files and folders one recursive delete removes before it stops. */
export const MAX_DELETE_ENTRIES = 10_000
/** A glob in find_files, in characters. */
export const MAX_GLOB_CHARS = 200
/** save_file's text, in characters (a file is passed as a kept result). */
export const MAX_SAVE_TEXT_CHARS = 1024 * 1024
/** The text of a text file get_file answers with, beside its handle. */
export const MAX_GET_TEXT_CHARS = 20_000
/** One SFTP request (a stat, a rename, one chunk read or written). */
export const SFTP_REQUEST_TIMEOUT_MS = 30_000
/** One chunk written at a time. */
export const WRITE_CHUNK_BYTES = 32 * 1024
/**
 * What a file being written is called until it is whole: the name, a few
 * random characters, then this. A crashed write leaves one behind, never a
 * half file under the real name.
 */
export const PART_SUFFIX = ".pcp-part"
/**
 * The folder an encrypted store keeps its objects in, at the top of its
 * folder on the backend: `.pcp-store/<two hex>/<object id>`.
 */
export const OBJECTS_FOLDER = ".pcp-store"
/**
 * How long an object being written may stay in storage_pending before a
 * sweep takes it for one that never finished (one let go of is dated at
 * the epoch and swept at once).
 */
export const PENDING_SWEEP_AGE_MS = 6 * 60 * 60_000
/** Objects one sweep removes. */
export const PENDING_SWEEP_BATCH = 100
/**
 * Entries PCP looks at to add up what a plain local store holds, for its
 * quota; past them the count stops.
 */
export const MAX_USAGE_ENTRIES = 100_000
/** Sweeps a delete runs at once; the rest go with a later request. */
export const LET_GO_ROUNDS = 10
/**
 * One batch of the owner's conversion of a store (convert.ts), within one
 * request: it stops after this long, or this many files, and the page
 * calls again.
 */
export const CONVERT_BUDGET_MS = 20_000
export const CONVERT_BATCH_FILES = 200
