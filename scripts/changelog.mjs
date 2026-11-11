// PCP's changelog: CHANGELOG.md at the root, one section per release, and
// the notes of each release and each build of develop, all written from the
// pull requests merged since the one before.
//
// Each pull request gives its "## Changelog" section (short lines for the
// people who run PCP; .github/PULL_REQUEST_TEMPLATE.md), or its title when
// that section is missing or empty, linked to it; a section that says only
// "none" leaves it out. Commits pushed without a pull request are listed by
// their subject, so nothing that shipped goes unmentioned.
//
// The workflows fetch what this reads (release.yml, develop.yml): the pull
// requests merged into develop (`gh pr list --json`), and the commits of the
// range (`git log --format=%H%x09%P%x09%cI%x09%s`). A pull request belongs to
// a range when its merge commit is in it. Everything below `main` is pure.
//
//   node scripts/changelog.mjs since --commits FILE
//       the day to search merged pull requests from (the range's first
//       commit, a day early)
//   node scripts/changelog.mjs notes --prs FILE --commits FILE --repo O/N
//       print the range's lines (a build of develop's notes)
//   node scripts/changelog.mjs release --version X.Y.Z --date YYYY-MM-DD
//       --prs FILE --commits FILE --repo O/N [--changelog FILE] [--notes FILE]
//       add the release's section to CHANGELOG.md (or replace it), and
//       write the release's notes
//   node scripts/changelog.mjs backfill --prs FILE --repo O/N
//       print a whole CHANGELOG.md for every release tagged so far, from
//       this checkout's tags (once, by hand: CONTRIBUTING.md)

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const RELEASE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const OID = /^[0-9a-f]{40}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/** At most this many lines from one pull request, each at most so long. */
export const MAX_LINES_PER_PR = 10
export const MAX_LINE_CHARS = 300
/** Commits pushed without a pull request listed by subject, the rest counted. */
export const MAX_OTHER_COMMITS = 30

export const HEADER = `# Changelog

What changed in each release of PCP, newest first. The release workflow
writes it (\`.github/workflows/release.yml\`, \`scripts/changelog.mjs\`) from
the pull requests merged since the release before: each one's "Changelog"
section, or its title. The builds of develop that led to a release are in its
section; each also has its own notes on its pre-release.
`

/**
 * @typedef {{ oid: string, parents: string[], merge: boolean, date: string, subject: string }} Commit
 * @typedef {{
 *   number: number,
 *   title: string,
 *   body?: string | null,
 *   url: string,
 *   mergedAt?: string | null,
 *   mergeCommit?: { oid: string } | null,
 *   commits?: { oid: string }[] | null,
 * }} PullRequest
 */

/**
 * The commits git printed as `%H%x09%P%x09%cI%x09%s`, one a line.
 *
 * @param {string} text
 * @returns {Commit[]}
 */
export function parseCommits(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [oid = "", parentList = "", date = "", ...subject] =
        line.split("\t")
      if (!OID.test(oid)) throw new Error(`Not a commit line: ${line}`)
      const parents = parentList.trim().split(/\s+/).filter(Boolean)
      return {
        oid,
        parents,
        merge: parents.length > 1,
        date,
        subject: subject.join("\t"),
      }
    })
}

/**
 * The day to search merged pull requests from: the range's earliest commit
 * date, a day early, since a search takes whole days. Null for an empty
 * range.
 *
 * @param {Commit[]} commits
 */
export function searchSince(commits) {
  const times = commits
    .map((commit) => Date.parse(commit.date))
    .filter((time) => !Number.isNaN(time))
  if (times.length === 0) return null
  const day = new Date(Math.min(...times) - 24 * 60 * 60 * 1000)
  return day.toISOString().slice(0, 10)
}

/**
 * One line of text as the changelog shows it: on one line, no HTML, images
 * as their text, mentions that notify nobody, cut to a length.
 *
 * @param {string} text
 */
export function cleanLine(text) {
  const line = text
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A mention in release notes notifies the person; in backticks it does
    // not.
    .replace(
      /(^|[^\w`])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[\w.-]+)?)/g,
      "$1`@$2`",
    )
  return line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS - 1).trimEnd()}…`
    : line
}

/**
 * The lines of a description's "## Changelog" section (any heading level),
 * up to the next heading: a list's items, or each paragraph. Null when the
 * section says only "none"; empty when there is no section or nothing in it.
 *
 * @param {string | null | undefined} body
 * @returns {string[] | null}
 */
export function changelogLines(body) {
  const text = (body ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
  const lines = text.split("\n")
  const start = lines.findIndex((line) =>
    /^ {0,3}#{1,6}\s+changelog\s*#*\s*$/i.test(line),
  )
  if (start < 0) return []

  /** @type {string[]} */
  const entries = []
  let current = /** @type {string | null} */ (null)
  const end = () => {
    if (current !== null && current.trim() !== "") entries.push(current)
    current = null
  }

  for (const line of lines.slice(start + 1)) {
    if (/^ {0,3}#{1,6}(\s|$)/.test(line)) break
    if (/^\s*```/.test(line)) continue
    // An item, or an empty one (the template's "-").
    const item = /^\s*(?:[-*+]|\d+[.)])(?:\s+(.*))?$/.exec(line)
    if (item && !/^\s{2,}/.test(line.replace(/\t/g, "  "))) {
      end()
      current = item[1] ?? ""
    } else if (item) {
      // A nested item belongs to the one above it.
      current = `${current ?? ""} ${item[1] ?? ""}`
    } else if (line.trim() === "") {
      end()
    } else {
      current = `${current ?? ""} ${line}`
    }
  }
  end()

  const cleaned = entries.map(cleanLine).filter((line) => line !== "")
  if (
    cleaned.length === 1 &&
    /^(none|n\/a|nothing)\.?$/i.test(cleaned[0] ?? "")
  ) {
    return null
  }
  return cleaned.slice(0, MAX_LINES_PER_PR)
}

/**
 * What a pull request says in the changelog: its section's lines, else its
 * title; nothing when its section says "none".
 *
 * @param {PullRequest} pr
 */
export function entriesFor(pr) {
  const lines = changelogLines(pr.body)
  if (lines === null) return []
  if (lines.length > 0) return lines
  const title = cleanLine(pr.title ?? "")
  return title === "" ? [] : [title]
}

/**
 * The pull requests whose merge commit is in the range, in the order they
 * were merged, and the range's other commits: not merges, and not part of
 * one of those pull requests.
 *
 * @param {PullRequest[]} prs
 * @param {Commit[]} commits
 */
export function collect(prs, commits) {
  const inRange = new Set(commits.map((commit) => commit.oid))
  /** @type {Map<number, PullRequest>} */
  const chosen = new Map()
  for (const pr of prs) {
    const oid = pr.mergeCommit?.oid
    if (oid && inRange.has(oid) && !chosen.has(pr.number)) {
      chosen.set(pr.number, pr)
    }
  }
  const merged = [...chosen.values()].sort(
    (a, b) =>
      Date.parse(a.mergedAt ?? "") - Date.parse(b.mergedAt ?? "") ||
      a.number - b.number,
  )
  const covered = new Set(
    merged.flatMap((pr) => [
      pr.mergeCommit?.oid,
      ...(pr.commits ?? []).map((commit) => commit.oid),
      ...branchOf(pr.mergeCommit?.oid, commits),
    ]),
  )
  const others = commits
    .filter((commit) => !commit.merge && !covered.has(commit.oid))
    .reverse()
  return { prs: merged, others }
}

/**
 * The range's commits a merge brought in: reachable from its other parents
 * and not from its first, read from the range's own graph (so a pull
 * request with more commits than GitHub lists is still whole). A squash or
 * a commit outside the range brings in nothing.
 *
 * @param {string | undefined} oid
 * @param {Commit[]} commits
 * @returns {string[]}
 */
export function branchOf(oid, commits) {
  const byOid = new Map(commits.map((commit) => [commit.oid, commit]))
  const merge = oid ? byOid.get(oid) : undefined
  if (!merge || merge.parents.length < 2) return []
  /** @param {string[]} start */
  const reach = (start) => {
    const seen = new Set()
    const queue = [...start]
    while (queue.length > 0) {
      const next = queue.pop()
      if (next === undefined || seen.has(next)) continue
      const commit = byOid.get(next)
      if (!commit) continue
      seen.add(next)
      queue.push(...commit.parents)
    }
    return seen
  }
  const main = reach([merge.parents[0] ?? ""])
  return [...reach(merge.parents.slice(1))].filter((each) => !main.has(each))
}

/** @param {string} repo */
function checkRepo(repo) {
  if (!REPO.test(repo)) throw new Error(`Not a repository: ${repo}`)
}

/**
 * The range's lines, as markdown: each pull request's, linked to it, then
 * the commits pushed without one, linked to theirs.
 *
 * @param {{ prs: PullRequest[], others: Commit[] }} collected
 * @param {string} repo
 */
export function renderEntries({ prs, others }, repo) {
  checkRepo(repo)
  const lines = []
  for (const pr of prs) {
    if (!Number.isInteger(pr.number) || pr.number < 1) continue
    const link = `[#${pr.number}](https://github.com/${repo}/pull/${pr.number})`
    for (const entry of entriesFor(pr)) lines.push(`- ${entry} (${link})`)
  }
  for (const commit of others.slice(0, MAX_OTHER_COMMITS)) {
    const subject = cleanLine(commit.subject)
    if (subject === "") continue
    const short = commit.oid.slice(0, 7)
    lines.push(
      `- ${subject} ([${short}](https://github.com/${repo}/commit/${commit.oid}))`,
    )
  }
  const more = others.length - MAX_OTHER_COMMITS
  if (more > 0) {
    lines.push(
      `- And ${more} more ${more === 1 ? "commit" : "commits"} without a pull request.`,
    )
  }
  return lines.length > 0 ? lines.join("\n") : "- Nothing for the changelog."
}

/**
 * A release's section of CHANGELOG.md.
 *
 * @param {{ version: string, date: string, repo: string }} release
 * @param {{ prs: PullRequest[], others: Commit[] }} collected
 */
export function renderSection({ version, date, repo }, collected) {
  if (!RELEASE.test(`v${version}`)) {
    throw new Error(`Not a MAJOR.MINOR.PATCH version: ${version}`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Not a date: ${date}`)
  const url = `https://github.com/${repo}/releases/tag/v${version}`
  return `## [${version}](${url}) - ${date}\n\n${renderEntries(collected, repo)}\n`
}

/**
 * CHANGELOG.md with a release's section in it: in place of one for the same
 * version (a run made again), else first, below the header.
 *
 * @param {string} existing
 * @param {string} section
 * @param {string} version
 */
export function insertSection(existing, section, version) {
  const text =
    existing.trim() === "" ? HEADER : existing.replace(/\r\n?/g, "\n")
  const sections = text.split(/\n(?=## )/)
  const head = sections[0]?.startsWith("## ")
    ? HEADER
    : (sections.shift() ?? HEADER)
  const own = `## [${version}](`
  const rest = sections.filter((part) => !part.startsWith(own))
  return [
    head.trimEnd() + "\n",
    section.trimEnd() + "\n",
    ...rest.map((part) => part.trimEnd() + "\n"),
  ].join("\n")
}

/**
 * A whole CHANGELOG.md for releases given oldest first, each with the
 * commits since the one before.
 *
 * @param {{ version: string, date: string, commits: Commit[] }[]} releases
 * @param {PullRequest[]} prs
 * @param {string} repo
 */
export function backfill(releases, prs, repo) {
  let text = HEADER
  for (const release of releases) {
    const section = renderSection(
      { version: release.version, date: release.date, repo },
      collect(prs, release.commits),
    )
    text = insertSection(text, section, release.version)
  }
  return text
}

// --- The command line: files and git, around the pure parts above. -------

/** @param {string[]} argv */
function options(argv) {
  /** @type {Record<string, string>} */
  const result = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value, not ${key ?? "nothing"}`)
    }
    result[key.slice(2)] = value
  }
  return result
}

/** @param {Record<string, string>} opts @param {string} name */
function need(opts, name) {
  const value = opts[name]
  if (value === undefined) throw new Error(`--${name} is needed`)
  return value
}

/** @param {string} file @returns {PullRequest[]} */
function readPrs(file) {
  const value = JSON.parse(readFileSync(file, "utf8"))
  if (!Array.isArray(value)) throw new Error(`${file} is not a list`)
  return value
}

/** @param {string} file */
function readCommits(file) {
  return parseCommits(readFileSync(file, "utf8"))
}

/** @param {string[]} args */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" })
}

/** The releases tagged in this checkout, oldest first, with their commits. */
function taggedReleases() {
  const tags = git(["tag", "--list", "v*", "--sort=v:refname"])
    .split("\n")
    .filter((tag) => RELEASE.test(tag))
  return tags.map((tag, index) => {
    const range = index === 0 ? tag : `${tags[index - 1]}..${tag}`
    return {
      version: tag.slice(1),
      date: git(["log", "-1", "--format=%cs", tag]).trim(),
      commits: parseCommits(
        git(["log", "--format=%H%x09%P%x09%cI%x09%s", range]),
      ),
    }
  })
}

/** @param {string[]} argv */
function main([command, ...rest]) {
  const opts = options(rest)
  if (command === "since") {
    return searchSince(readCommits(need(opts, "commits"))) ?? ""
  }
  if (command === "notes") {
    const collected = collect(
      readPrs(need(opts, "prs")),
      readCommits(need(opts, "commits")),
    )
    return renderEntries(collected, need(opts, "repo"))
  }
  if (command === "release") {
    const version = need(opts, "version")
    const repo = need(opts, "repo")
    const collected = collect(
      readPrs(need(opts, "prs")),
      readCommits(need(opts, "commits")),
    )
    const section = renderSection(
      { version, date: need(opts, "date"), repo },
      collected,
    )
    const file = opts.changelog ?? "CHANGELOG.md"
    const existing = existsSync(file) ? readFileSync(file, "utf8") : ""
    writeFileSync(file, insertSection(existing, section, version))
    if (opts.notes)
      writeFileSync(opts.notes, `${renderEntries(collected, repo)}\n`)
    return section.trimEnd()
  }
  if (command === "backfill") {
    return backfill(
      taggedReleases(),
      readPrs(need(opts, "prs")),
      need(opts, "repo"),
    ).trimEnd()
  }
  throw new Error(
    "Usage: node scripts/changelog.mjs since | notes | release | backfill (see the top of the file)",
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(main(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
