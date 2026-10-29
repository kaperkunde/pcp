/**
 * How an assistant hands the owner a link to PCP's page: a markdown link
 * with a few words naming the action, last in its reply. Last, because some
 * apps fold away what an assistant wrote before a tool call, and the owner
 * never sees it; a markdown link, because an app that reads the reply aloud
 * says the label and not a long address of ids.
 *
 * Pure: the instructions, tool descriptions and every answer that asks the
 * owner use it, so nothing here may import more than this.
 */

/** The rule, in the words instructions and tool descriptions use. */
export const OWNER_LINK_RULE =
  "End your reply with the link as a markdown link with a short label naming the action, on a line of its own; never paste the bare address, and call no tool after it in this reply."

/** The longest label, in characters. */
export const MAX_LINK_LABEL = 60

/** What a link is called when its label has nothing left to show. */
const FALLBACK_LABEL = "Open in PCP"

/**
 * A label fit for a markdown link: one line, nothing that would end the
 * link's text or start markup (brackets, backslashes, backticks, angle
 * brackets), no characters that do not show, and at most MAX_LINK_LABEL
 * characters.
 */
export function linkLabel(label: string): string {
  const plain = label
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[[\]\\`<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()

  if (!plain) {
    return FALLBACK_LABEL
  }

  const chars = [...plain]

  return chars.length <= MAX_LINK_LABEL
    ? plain
    : `${chars
        .slice(0, MAX_LINK_LABEL - 1)
        .join("")
        .trimEnd()}…`
}

/**
 * `[label](url)`. The address is PCP's own; the few characters that would
 * end a markdown link's address are escaped, which a browser reads back the
 * same.
 */
export function markdownLink(label: string, url: string): string {
  const href = url.replace(
    /[\s()<>]/g,
    (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  )

  return `[${linkLabel(label)}](${href})`
}

/**
 * What an answer that needs the owner ends with: the rule, then the link
 * itself as the last line, labelled with what the owner does there.
 */
export function linkLastText(url: string, label: string): string {
  return `${OWNER_LINK_RULE} Hand it over as it is below: some apps hide the text written before a tool call, and the owner would never see the link.\n${markdownLink(label, url)}`
}
