import { domainToUnicode } from "node:url"

/**
 * Whether a site an assistant proposes for one of the owner's secrets looks
 * like one it already has without being it (frankenergy.nl beside
 * frankenergie.nl, examp1e.com, an IDN homograph): the request's page flags
 * it and leaves it unticked, so a typing mistake or a phishing site is not
 * agreed to in passing. Pure: hosts and registrable domains in, a reason out.
 */

/** Letters and digits that pass for others at a glance, folded together. */
const CONFUSABLE: Array<[RegExp, string]> = [
  [/rn/g, "m"],
  [/vv/g, "w"],
  [/cl/g, "d"],
  [/0/g, "o"],
  [/[1il|]/g, "l"],
  [/5/g, "s"],
  [/8/g, "b"],
  [/-/g, ""],
]

function skeleton(label: string): string {
  return CONFUSABLE.reduce(
    (text, [from, to]) => text.replace(from, to),
    label.toLowerCase(),
  )
}

/** Levenshtein distance, stopping early once it is past `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) {
    return max + 1
  }

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)

  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(
        previous[j]! + 1,
        row[j - 1]! + 1,
        previous[j - 1]! + cost,
      )
      row.push(value)
      best = Math.min(best, value)
    }

    if (best > max) {
      return max + 1
    }

    previous = row
  }

  return previous[b.length]!
}

/** A registrable domain's own name: frankenergie for frankenergie.nl. */
function nameOf(domain: string): string {
  return domain.split(".")[0] ?? domain
}

export type KnownSite = { host: string; domain: string | null }

/**
 * Why `host` (registrable domain `domain`) looks like one of the `known`
 * sites without being under the same registrable domain; null when it does
 * not. A host under a domain the secret already has is never flagged.
 */
export function lookalikeReason(
  host: string,
  domain: string | null,
  known: readonly KnownSite[],
): string | null {
  const own = domain ?? host

  if (known.some((site) => (site.domain ?? site.host) === own)) {
    return null
  }

  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    const shown = domainToUnicode(host)
    return `${host} is written in letters from other alphabets (${shown}), which can look like familiar ones.`
  }

  for (const site of known) {
    const theirs = site.domain ?? site.host
    const ourName = nameOf(own)
    const theirName = nameOf(theirs)

    if (ourName === theirName) {
      return `${own} has the same name as ${theirs} under another ending: a different owner's site.`
    }

    if (skeleton(ourName) === skeleton(theirName)) {
      return `${own} looks like ${theirs} but is spelled differently: a different site.`
    }

    if (
      Math.min(ourName.length, theirName.length) >= 4 &&
      editDistance(ourName, theirName, 2) <= 2
    ) {
      return `${own} is a letter or two away from ${theirs}: a different site. Check the spelling.`
    }

    if (theirName.length >= 4 && host.includes(theirName)) {
      return `${host} has ${theirName} in its name but belongs to ${own}, not ${theirs}.`
    }
  }

  return null
}
