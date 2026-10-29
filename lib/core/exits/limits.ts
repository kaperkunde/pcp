/** Bounds on exits (lib/core/exits/): their names, lookups and handshakes. */

/** An exit's name, as an assistant names it in a call. */
export const MAX_EXIT_NAME_CHARS = 40
/** The owner's label for where it comes out ("US — home VPS"). */
export const MAX_EXIT_LABEL_CHARS = 80
/** Exits a vault keeps. */
export const MAX_EXITS = 50

/** One DNS-over-HTTPS question to one resolver, connecting included. */
export const DOH_TIMEOUT_MS = 5_000
/** The most of a resolver's answer PCP reads. */
export const DOH_MAX_RESPONSE_BYTES = 64 * 1024
/** CNAMEs followed for one name, across answers. */
export const DOH_MAX_CNAME_HOPS = 8
/** Answers kept per exit, and how long, whatever their TTL says. */
export const DOH_CACHE_ENTRIES = 512
export const DOH_MIN_TTL_S = 10
export const DOH_MAX_TTL_S = 600

/** A proxy handshake (an exit container's HTTP CONNECT or SOCKS5). */
export const EXIT_HANDSHAKE_TIMEOUT_MS = 10_000
export const EXIT_HANDSHAKE_MAX_BYTES = 16 * 1024
