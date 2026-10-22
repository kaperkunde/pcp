// Compares two fingerprints from harness.html (kaperkunde/pcp#38): PCP's
// browser and a person's (the Claude app's browser, or Chrome), and prints
// where they differ, the known tells first.
//
//   node scripts/fingerprint/diff.mjs <pcp.json> <baseline.json>
//   node scripts/fingerprint/diff.mjs <pcp.json> <baseline.json> --markdown
//   node scripts/fingerprint/diff.mjs <a.json> <b.json> --all --wide
//
// --markdown prints a table to paste into the issue; --all lists the values
// that are the same too; --wide does not shorten long values.

import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

/**
 * What a check is known to read, by path, most telling first: weight 100 is
 * a sure sign of automation, 10 a difference any two machines have.
 *
 * @type {Array<[RegExp, number, string]>}
 */
export const TELLS = [
  [
    /^automation\.(globals|documentKeys|htmlAttributes)/,
    100,
    "automation globals or attributes",
  ],
  [
    /^automation\.runtimeEnableDetected/,
    100,
    "a DevTools client with Runtime on (Runtime.enable)",
  ],
  [/^automation\.stackTraps/, 95, "automation code in the page's call stacks"],
  [/^automation\.notNative/, 90, "functions replaced by a stealth script"],
  [/^navigator\.webdriver/, 100, "navigator.webdriver"],
  [
    /^navigator\.userAgent$/,
    90,
    "the user agent (Headless, platform, version)",
  ],
  [
    /^userAgentData\.(brands|fullVersionList)/,
    85,
    "client hint brands (Chromium alone, or not matching the user agent)",
  ],
  [
    /^userAgentData\.platformVersion/,
    80,
    "client hints of a replaced user agent leave platformVersion blank",
  ],
  [/^userAgentData\./, 60, "client hints"],
  [
    /^window\.(frame|outerWidth|outerHeight)/,
    85,
    "a window exactly the size of the page (headless)",
  ],
  [/^window\.visibility/, 85, "a page that is hidden or backgrounded"],
  [/^window\.(screenX|screenY)/, 60, "where the window is on its screen"],
  [/^window\.hasFocus/, 40, "whether the page has focus"],
  [
    /^screen\.(availHeight|availWidth|availTop|availLeft)/,
    65,
    "no taskbar or menu bar taken from the screen",
  ],
  [/^screen\./, 50, "the screen"],
  [
    /^webgl\.(unmaskedRenderer|unmaskedVendor|renderer|vendor)/,
    85,
    "the GPU (SwiftShader is software rendering)",
  ],
  [/^webgl\.supported/, 85, "WebGL missing"],
  [/^webgpu\./, 55, "WebGPU's adapter"],
  [/^webgl\./, 40, "WebGL's limits and extensions"],
  [
    /^codecs\.(canPlay|mediaSource)\.(h264|aac|h265)/,
    75,
    "proprietary codecs: a Chromium build lacks what Chrome plays",
  ],
  [/^codecs\./, 35, "codecs"],
  [
    /^permissions\.notificationsConsistent/,
    80,
    "notification permission answers that disagree (headless)",
  ],
  [/^permissions\.notificationPermission/, 60, "Notification.permission"],
  [/^permissions\./, 35, "permission states"],
  [/^chrome\./, 70, "the window.chrome object"],
  [
    /^navigator\.(plugins|mimeTypes|pdfViewerEnabled)/,
    70,
    "plugins and PDF viewer",
  ],
  [
    /^navigator\.(languages|language)/,
    60,
    "languages (should match the locale and the address)",
  ],
  [
    /^media\.(hover|anyHover|pointerFine|pointerCoarse|anyPointerFine)/,
    70,
    "pointer and hover (headless reports a touch screen)",
  ],
  [/^media\./, 30, "media queries"],
  [/^mediaDevices\./, 60, "media devices (none at all is a server's)"],
  [/^speech\./, 55, "speech voices (none at all is a server's)"],
  [
    /^storage\.quotaMB/,
    50,
    "storage quota (a profile kept in memory gets little)",
  ],
  [/^storage\./, 30, "storage"],
  [/^fonts\./, 50, "installed fonts (a server's few)"],
  [
    /^intl\.(timeZone|offsetMinutes)/,
    65,
    "time zone (should match the address a site sees)",
  ],
  [/^intl\./, 45, "locale and formats"],
  [
    /^behaviour\.(clicks|mouseMoves|movesWithMovement|untrustedEvents|keyIntervalSpreadMs)/,
    60,
    "how input arrives (a click with no path to it, keys at an even pace)",
  ],
  [/^behaviour\./, 30, "input timing"],
  [/^navigator\.(hardwareConcurrency|deviceMemory)/, 30, "cores and memory"],
  [/^navigator\.connection/, 15, "network estimates (vary from run to run)"],
  [/^webrtc\./, 40, "WebRTC candidates"],
  [
    /^(canvas|audio)\./,
    30,
    "canvas and audio hashes (differ between any two machines)",
  ],
  [/^apis\./, 20, "which APIs exist"],
  [/^navigator\./, 25, "navigator"],
]

/** Paths that differ every run and say nothing about the browser. */
const IGNORED =
  /^(meta\.|flags$|flags\.|behaviour\.firstInputMs|window\.historyLength)/

/**
 * The input as a few numbers that compare: clicks by what gave them away,
 * the spread of the gaps between keys (a person's vary; sent keys do not).
 */
export function summariseInput(behaviour) {
  if (!behaviour || typeof behaviour !== "object") return behaviour
  const { clicks = [], keyIntervalsMs = [], ...rest } = behaviour
  const mean =
    keyIntervalsMs.reduce((sum, gap) => sum + gap, 0) /
    (keyIntervalsMs.length || 1)
  const spread = Math.sqrt(
    keyIntervalsMs.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) /
      (keyIntervalsMs.length || 1),
  )

  return {
    ...rest,
    clicks: clicks.length,
    clicksAtPagePosition: clicks.filter(
      (click) =>
        click.screenMinusClient?.[0] === 0 &&
        click.screenMinusClient?.[1] === 0,
    ).length,
    clicksUntrusted: clicks.filter((click) => !click.trusted).length,
    clicksWithoutMoveFirst: clicks.filter(
      (click) => click.moveBeforeMs === null || click.moveBeforeMs > 2000,
    ).length,
    keyIntervalSpreadMs: keyIntervalsMs.length ? Math.round(spread) : null,
  }
}

/** The tell a path falls under, or a plain difference. */
export function tellFor(path) {
  for (const [pattern, weight, note] of TELLS) {
    if (pattern.test(path)) return { weight, note }
  }
  return { weight: 10, note: "" }
}

/**
 * The fingerprint as path → value. Arrays of plain values stay whole (a
 * list of fonts or brands is one value); arrays of objects are indexed.
 */
export function flatten(value, prefix = "", out = {}) {
  const plain = (item) => item === null || typeof item !== "object"

  if (Array.isArray(value) && value.every(plain)) {
    out[prefix] = value
  } else if (value !== null && typeof value === "object") {
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value)
    if (entries.length === 0) out[prefix] = value
    for (const [key, item] of entries) {
      flatten(item, prefix ? `${prefix}.${key}` : key, out)
    }
  } else {
    out[prefix] = value
  }

  return out
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Which of a fingerprint's own flags (harness.html's) cover a path. */
function flaggedPaths(fingerprint) {
  return new Set((fingerprint?.flags ?? []).map((flag) => flag.path))
}

function coveredBy(flagged, path) {
  for (const flag of flagged) {
    if (path === flag || path.startsWith(`${flag}.`)) return true
  }
  return false
}

/**
 * The rows where two fingerprints differ (all rows with `all`), the most
 * telling first, then by path. A row marks which side's own flags name it.
 */
export function compare(a, b, { all = false } = {}) {
  const input = (fingerprint) => ({
    ...fingerprint,
    behaviour: summariseInput(fingerprint?.behaviour),
  })
  const left = flatten(input(a))
  const right = flatten(input(b))
  const flaggedA = flaggedPaths(a)
  const flaggedB = flaggedPaths(b)
  const paths = [...new Set([...Object.keys(left), ...Object.keys(right)])]
  const rows = []

  for (const path of paths) {
    if (IGNORED.test(path)) continue
    const differs = !same(left[path], right[path])
    if (!differs && !all) continue
    const { weight, note } = tellFor(path)
    rows.push({
      path,
      a: left[path],
      b: right[path],
      differs,
      weight,
      note,
      flaggedA: coveredBy(flaggedA, path),
      flaggedB: coveredBy(flaggedB, path),
    })
  }

  // A row the first browser's own flags name, which the second's do not,
  // is the likeliest cause: it goes up within its weight.
  const score = (row) =>
    (row.differs ? 1000 : 0) +
    row.weight +
    (row.flaggedA && !row.flaggedB ? 5 : 0)

  return rows.sort(
    (x, y) => score(y) - score(x) || x.path.localeCompare(y.path),
  )
}

function show(value, wide) {
  const text =
    value === undefined
      ? "(none)"
      : typeof value === "string"
        ? value
        : JSON.stringify(value)
  return wide || text.length <= 60 ? text : `${text.slice(0, 57)}...`
}

/** The rows as a table for a terminal or, with markdown, for the issue. */
export function formatTable(
  rows,
  labels,
  { markdown = false, wide = false } = {},
) {
  const head = ["#", "tell", "path", labels[0], labels[1], "why it matters"]
  const body = rows.map((row, index) => [
    String(index + 1),
    `${row.weight}${row.flaggedA ? " !" : ""}${row.flaggedB ? " ?" : ""}`,
    row.path,
    show(row.a, wide || markdown),
    show(row.b, wide || markdown),
    row.differs ? row.note : `(same) ${row.note}`,
  ])

  if (markdown) {
    const cell = (text) =>
      String(text).replace(/\|/g, "\\|").replace(/\n/g, " ")
    return [
      `| ${head.map(cell).join(" | ")} |`,
      `| ${head.map(() => "---").join(" | ")} |`,
      ...body.map((line) => `| ${line.map(cell).join(" | ")} |`),
    ].join("\n")
  }

  const widths = head.map((title, column) =>
    Math.max(title.length, ...body.map((line) => line[column].length)),
  )
  const line = (cells) =>
    cells
      .map((text, column) => text.padEnd(widths[column]))
      .join("  ")
      .trimEnd()
  return [
    line(head),
    line(widths.map((w) => "-".repeat(w))),
    ...body.map(line),
  ].join("\n")
}

function main(argv) {
  const files = argv.filter((arg) => !arg.startsWith("--"))
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")))

  if (files.length !== 2) {
    console.error(
      "Usage: node scripts/fingerprint/diff.mjs <pcp.json> <baseline.json> [--markdown] [--all] [--wide]",
    )
    process.exit(2)
  }

  const [a, b] = files.map((file) => JSON.parse(readFileSync(file, "utf8")))
  const labels = [a, b].map(
    (fingerprint, index) => fingerprint?.meta?.label || files[index],
  )
  const rows = compare(a, b, { all: flags.has("--all") })

  console.log(
    formatTable(rows, labels, {
      markdown: flags.has("--markdown"),
      wide: flags.has("--wide"),
    }),
  )
  console.log(
    `\n${rows.filter((row) => row.differs).length} differences. "tell" is how much a check is known to weigh it (100 most); ! marks a row ${labels[0]}'s own page flagged, ? one ${labels[1]}'s flagged.`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2))
}
