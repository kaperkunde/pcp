import YAML, { isAlias, isScalar } from "yaml"

import { invalid } from "./errors"

/**
 * YAML read as plain data and nothing more: no aliases or anchors (no
 * value repeated or expanded), no tags (custom or YAML's own, so nothing is
 * read as anything but what it plainly says), no merge keys, no duplicate
 * keys and no key that is not text. For documents from outside PCP: a
 * SKILL.md's frontmatter, a document in a linked repository.
 */
export function readStrictYaml(text: string, what: string): unknown {
  let document: YAML.Document.Parsed

  try {
    document = YAML.parseDocument(text, {
      version: "1.2",
      schema: "core",
      customTags: [],
      resolveKnownTags: false,
      merge: false,
      uniqueKeys: true,
      logLevel: "error",
    })
  } catch (error) {
    throw invalid(`${what} is not YAML PCP can read: ${firstLine(error)}`)
  }

  if (document.errors.length > 0) {
    throw invalid(
      `${what} is not YAML PCP can read: ${firstLine(document.errors[0])}`,
    )
  }

  let problem: string | null = null

  YAML.visit(document, {
    Alias() {
      problem ??= "an alias (*name)"
      return YAML.visit.BREAK
    },
    Node(_key, node) {
      if (isAlias(node)) {
        return
      }

      if (node.anchor) {
        problem ??= `an anchor (&${node.anchor})`
        return YAML.visit.BREAK
      }

      if (node.tag) {
        problem ??= `a tag (${node.tag})`
        return YAML.visit.BREAK
      }
    },
    Pair(_key, pair) {
      if (pair.key !== null && !isScalar(pair.key)) {
        problem ??= "a key that is not text"
        return YAML.visit.BREAK
      }
    },
  })

  if (problem) {
    throw invalid(
      `${what} uses ${problem}, which PCP does not take in YAML: write the value out where it is used.`,
    )
  }

  try {
    return document.toJS({ maxAliasCount: 0 })
  } catch (error) {
    throw invalid(`${what} is not YAML PCP can read: ${firstLine(error)}`)
  }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(
    "\n",
  )[0]!
}
