/** Bounds on an SSH connection and on what a command may send or return. */

/** Connecting, the key exchange and signing in, together. */
export const SSH_CONNECT_TIMEOUT_MS = 15_000
/** How long a command runs when the call does not say. */
export const SSH_DEFAULT_COMMAND_TIMEOUT_MS = 60_000
/** The longest a call may ask a command to run. */
export const SSH_MAX_COMMAND_TIMEOUT_MS = 10 * 60_000

export const MAX_COMMAND_CHARS = 16 * 1024
/** What a call may send to the command's standard input. */
export const MAX_STDIN_BYTES = 1024 * 1024
/**
 * Standard output and error together. A command that writes more is asked
 * to end: its output so far is returned, marked truncated.
 */
export const MAX_OUTPUT_BYTES = 1024 * 1024

/** A login name, as OpenSSH allows it. */
export const MAX_USERNAME_CHARS = 64
