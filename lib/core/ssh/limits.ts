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

// Exits (lib/core/exits/): one long-lived connection per SSH server that
// carries direct-tcpip channels, open only while it is used.

/** Opening one channel, once the connection is up. */
export const SSH_CHANNEL_OPEN_TIMEOUT_MS = 15_000
/** A connection that has carried no channel this long is closed. */
export const SSH_EXIT_IDLE_MS = 5 * 60_000
/** Channels open at once on one connection (a browser opens many). */
export const SSH_EXIT_MAX_CHANNELS = 128
/** Exit connections PCP keeps open at once, across every SSH server. */
export const SSH_EXIT_MAX_CONNECTIONS = 32
/** A keepalive this often, and the connection given up after this many unanswered. */
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000
export const SSH_KEEPALIVE_COUNT = 3
