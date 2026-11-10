import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

import {
  backfill,
  changelogLines,
  cleanLine,
  collect,
  entriesFor,
  HEADER,
  insertSection,
  parseCommits,
  renderEntries,
  renderSection,
  searchSince,
} from "./changelog.mjs"

const REPO = "kaperkunde/pcp"
const oid = (n: number) => n.toString(16).padStart(40, "0")
const commit = (n: number, subject: string, merge = false, date = "") =>
  `${oid(n)}\t${merge ? `${oid(n + 100)} ${oid(n + 200)}` : oid(n + 100)}\t${date || `2026-11-0${n % 9 || 1}T10:00:00Z`}\t${subject}`
const pr = (
  number: number,
  merge: number,
  body: string | null,
  title = `PR ${number}`,
  mergedAt = `2026-11-0${number % 9 || 1}T10:00:00Z`,
) => ({
  number,
  title,
  body,
  url: `https://github.com/${REPO}/pull/${number}`,
  mergedAt,
  mergeCommit: { oid: oid(merge) },
})

describe("changelogLines", () => {
  it("reads the items of a ## Changelog section, up to the next heading", () => {
    const body = [
      "Some context for reviewers.",
      "",
      "## Changelog",
      "",
      "- The browser keeps no cache on disk.",
      "- Images are signed,",
      "  and checked before they run.",
      "",
      "## Testing",
      "- not this",
    ].join("\n")

    expect(changelogLines(body)).toEqual([
      "The browser keeps no cache on disk.",
      "Images are signed, and checked before they run.",
    ])
  })

  it("takes any heading level and case, and paragraphs as lines", () => {
    expect(
      changelogLines("### changelog\nOne thing changed.\n\nAnother one."),
    ).toEqual(["One thing changed.", "Another one."])
  })

  it("leaves out the template's comments", () => {
    expect(
      changelogLines(
        "## Changelog\n\n<!-- Short lines for people who run PCP. -->\n",
      ),
    ).toEqual([])
    expect(
      changelogLines("## Changelog\n<!-- a\nmultiline\nhint -->\n- Real"),
    ).toEqual(["Real"])
  })

  it("is empty with no section, and null for one that says none", () => {
    expect(changelogLines("Just a description.")).toEqual([])
    expect(changelogLines(null)).toEqual([])
    expect(changelogLines("## Changelog\n\nNone.")).toBeNull()
    expect(changelogLines("## Changelog\n- none")).toBeNull()
  })

  it("keeps at most ten lines", () => {
    const body = `## Changelog\n${Array.from({ length: 15 }, (_, i) => `- line ${i}`).join("\n")}`
    expect(changelogLines(body)).toHaveLength(10)
  })
})

describe("the pull request template", () => {
  const template = readFileSync(
    path.resolve(__dirname, "..", ".github", "PULL_REQUEST_TEMPLATE.md"),
    "utf8",
  )

  it("has the section the changelog reads", () => {
    expect(template).toMatch(/^## Changelog$/m)
  })

  it("left as it is, gives the title", () => {
    expect(changelogLines(template)).toEqual([])
    expect(entriesFor(pr(3, 3, template, "Do the thing"))).toEqual([
      "Do the thing",
    ])
  })

  it("filled in, gives its lines", () => {
    expect(
      changelogLines(template.replace(/^-$/m, "- Images are signed.")),
    ).toEqual(["Images are signed."])
  })
})

describe("cleanLine", () => {
  it("keeps one line of text, without HTML or images", () => {
    expect(cleanLine('a <img src="x"> b\n c ![shot](http://x/y.png)')).toBe(
      "a b c shot",
    )
  })

  it("puts mentions in backticks, so release notes notify nobody", () => {
    expect(cleanLine("Thanks @someone and @org/team, not me@example.com")).toBe(
      "Thanks `@someone` and `@org/team`, not me@example.com",
    )
  })

  it("cuts a long line", () => {
    const line = cleanLine("x".repeat(500))
    expect(line).toHaveLength(300)
    expect(line.endsWith("…")).toBe(true)
  })
})

describe("entriesFor", () => {
  it("falls back to the title when the description has nothing usable", () => {
    expect(entriesFor(pr(1, 1, "No section here", "Fix the thing"))).toEqual([
      "Fix the thing",
    ])
    expect(entriesFor(pr(1, 1, null, "Fix it"))).toEqual(["Fix it"])
  })

  it("is nothing for a pull request whose section says none", () => {
    expect(entriesFor(pr(1, 1, "## Changelog\nnone", "Refactor"))).toEqual([])
  })
})

describe("collect and renderEntries", () => {
  const commits = parseCommits(
    [
      commit(5, "Merge pull request #12 from x/y", true),
      commit(4, "A commit inside #12"),
      commit(3, "Pushed straight to develop"),
      commit(2, "Merge pull request #11 from x/z", true),
    ].join("\n"),
  )

  it("takes the pull requests whose merge commit is in the range, in merge order", () => {
    const prs = [
      { ...pr(12, 5, "## Changelog\n- Second"), commits: [{ oid: oid(4) }] },
      pr(11, 2, "## Changelog\n- First"),
      pr(10, 99, "## Changelog\n- Elsewhere"),
    ]
    const collected = collect(prs, commits)

    expect(collected.prs.map((p) => p.number)).toEqual([11, 12])
    // Not a merge and in no pull request: pushed on its own.
    expect(collected.others.map((c) => c.subject)).toEqual([
      "Pushed straight to develop",
    ])
    expect(renderEntries(collected, REPO)).toBe(
      [
        `- First ([#11](https://github.com/${REPO}/pull/11))`,
        `- Second ([#12](https://github.com/${REPO}/pull/12))`,
        `- Pushed straight to develop ([0000000](https://github.com/${REPO}/commit/${oid(3)}))`,
      ].join("\n"),
    )
  })

  it("counts the commits without a pull request past the first thirty", () => {
    const many = parseCommits(
      Array.from({ length: 33 }, (_, i) => commit(i + 1, `Commit ${i}`)).join(
        "\n",
      ),
    )
    const text = renderEntries(collect([], many), REPO)
    expect(text.split("\n")).toHaveLength(31)
    expect(text).toContain("- And 3 more commits without a pull request.")
  })

  it("says so when there is nothing", () => {
    expect(renderEntries({ prs: [], others: [] }, REPO)).toBe(
      "- Nothing for the changelog.",
    )
  })

  it("refuses a repository that is not one", () => {
    expect(() =>
      renderEntries({ prs: [], others: [] }, "x; rm -rf /"),
    ).toThrow()
  })
})

describe("searchSince", () => {
  it("is the range's first commit date, a day early", () => {
    const commits = parseCommits(
      [
        commit(1, "a", false, "2026-11-05T01:00:00+02:00"),
        commit(2, "b", false, "2026-11-08T10:00:00Z"),
      ].join("\n"),
    )
    expect(searchSince(commits)).toBe("2026-11-03")
    expect(searchSince([])).toBeNull()
  })
})

describe("the release's section", () => {
  const collected = { prs: [pr(7, 7, "## Changelog\n- A change")], others: [] }

  it("names the version, links its release and dates it", () => {
    expect(
      renderSection(
        { version: "0.5.0", date: "2026-11-10", repo: REPO },
        collected,
      ),
    ).toBe(
      `## [0.5.0](https://github.com/${REPO}/releases/tag/v0.5.0) - 2026-11-10\n\n- A change ([#7](https://github.com/${REPO}/pull/7))\n`,
    )
  })

  it("refuses a build of develop's version or a date that is not one", () => {
    expect(() =>
      renderSection(
        { version: "0.5.0-dev.3", date: "2026-11-10", repo: REPO },
        collected,
      ),
    ).toThrow()
    expect(() =>
      renderSection({ version: "0.5.0", date: "today", repo: REPO }, collected),
    ).toThrow()
  })

  it("goes first below the header, and replaces its own on a run made again", () => {
    const first = insertSection(
      "",
      "## [0.4.9](x) - 2026-11-01\n\n- old\n",
      "0.4.9",
    )
    expect(first.startsWith(HEADER)).toBe(true)

    const second = insertSection(
      first,
      "## [0.5.0](x) - 2026-11-10\n\n- new\n",
      "0.5.0",
    )
    expect(second.indexOf("[0.5.0]")).toBeLessThan(second.indexOf("[0.4.9]"))

    const again = insertSection(
      second,
      "## [0.5.0](x) - 2026-11-10\n\n- newer\n",
      "0.5.0",
    )
    expect(again.match(/\[0\.5\.0\]/g)).toHaveLength(1)
    expect(again).toContain("- newer")
    expect(again).not.toContain("- new\n")
    expect(again).toContain("- old")
  })

  it("keeps a header someone edited", () => {
    const edited =
      "# Changelog\n\nOur own words.\n\n## [0.4.9](x) - 2026-11-01\n\n- old\n"
    const text = insertSection(
      edited,
      "## [0.5.0](x) - 2026-11-10\n\n- new\n",
      "0.5.0",
    )
    expect(text.startsWith("# Changelog\n\nOur own words.\n\n## [0.5.0]")).toBe(
      true,
    )
  })
})

describe("backfill", () => {
  it("writes every release, newest first, each with what was merged since the one before", () => {
    const prs = [pr(1, 1, "## Changelog\n- One"), pr(2, 2, null, "Two")]
    const text = backfill(
      [
        {
          version: "0.1.0",
          date: "2026-10-01",
          commits: parseCommits(commit(1, "Merge", true)),
        },
        {
          version: "0.1.1",
          date: "2026-10-08",
          commits: parseCommits(commit(2, "Merge", true)),
        },
      ],
      prs,
      REPO,
    )

    expect(text.startsWith(HEADER)).toBe(true)
    expect(text.indexOf("[0.1.1]")).toBeLessThan(text.indexOf("[0.1.0]"))
    expect(text).toContain("## [0.1.1]")
    expect(text).toMatch(/\[0\.1\.1\][^\n]*\n\n- Two \(/)
    expect(text).toMatch(/\[0\.1\.0\][^\n]*\n\n- One \(/)
  })
})

// The workflows fetch the pull requests and the commits, and hand them to
// the script: the release's section goes into CHANGELOG.md in the release
// commit, and the notes of a release and a build of develop are written by
// it too. develop.yml commits nothing.
describe("the workflows' changelog", () => {
  type Step = {
    name?: string
    run?: string
    if?: string
    env?: Record<string, string>
  }
  type Workflow = {
    jobs: Record<
      string,
      { permissions?: Record<string, string>; steps?: Step[] }
    >
  }
  const workflow = (name: string) =>
    parse(
      readFileSync(
        path.resolve(__dirname, "..", ".github", "workflows", name),
        "utf8",
      ),
    ) as Workflow

  it("is written into CHANGELOG.md in the release commit, and is the release's notes", () => {
    const release = workflow("release.yml")
    const job = release.jobs.release!
    expect(job.permissions).toMatchObject({
      contents: "write",
      "pull-requests": "read",
    })
    const runs = job.steps!.map((step) => step.run ?? "").join("\n")
    expect(runs).toContain("scripts/changelog.mjs release")
    expect(runs).toContain("--base develop")
    expect(runs).toMatch(/git add [^\n]*CHANGELOG\.md/)
    expect(runs).toContain('--notes-file "$RUNNER_TEMP/notes.md"')
    expect(runs).not.toContain("--generate-notes")
  })

  it("is left as the script wrote it: prettier would rewrite some titles", () => {
    const ignored = readFileSync(
      path.resolve(__dirname, "..", ".prettierignore"),
      "utf8",
    )
    expect(ignored.split("\n")).toContain("CHANGELOG.md")
  })

  it("writes a build of develop's notes from its pull requests, and commits nothing", () => {
    const develop = workflow("develop.yml")
    const job = develop.jobs.release!
    expect(job.permissions).toMatchObject({ "pull-requests": "read" })
    const runs = job.steps!.map((step) => step.run ?? "").join("\n")
    expect(runs).toContain("scripts/changelog.mjs notes")
    expect(runs).not.toMatch(/git commit|git push origin HEAD/)
  })
})
