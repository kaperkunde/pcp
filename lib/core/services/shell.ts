/**
 * The one way a service's command line is written. Every engine command is
 * a list of words PCP built from checked fields (services/engine.ts), each
 * quoted here for a POSIX shell; nothing anyone typed is ever pasted into a
 * command as shell text. The whole script then goes to the login shell as
 * `sh -c '<script>'`, so a login whose shell is not sh (fish, zsh) reads one
 * simple quoted word and the script itself is always sh's.
 */

/**
 * One word for sh: single-quoted, with each ' written as '\''. Nothing is
 * special inside single quotes, so the word reaches the program as it is.
 * A NUL cannot be passed in an argument at all, and is refused.
 */
export function shellQuote(word: string): string {
  if (word.includes("\0")) {
    throw new Error("A command word cannot contain a NUL character.")
  }

  if (/^[A-Za-z0-9_@%+:,./-]+$/.test(word)) {
    return word
  }

  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** Words as one command line, each quoted. */
export function commandLine(words: readonly string[]): string {
  return words.map(shellQuote).join(" ")
}

/** A script for sh, handed to the login shell as one quoted word. */
export function shScript(script: string): string {
  return `sh -c ${shellQuote(script)}`
}
