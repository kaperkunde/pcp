import { isResultHandle } from "./validate"

const MAX_ANSWER_NODES = 2_000
const MAX_ANSWER_DEPTH = 8

/**
 * A tool's whole answer passed where a file or text goes (get_attachment's
 * {"name", "type", "size", "result": {"$result": id}} as `file`): what is
 * wrong is said by the schema as always, and this names the one handle inside
 * it to pass instead. Nothing when there is not exactly one such answer.
 */
export function answerHint(
  args: unknown,
  /** The problems found: the hint stands only where one names the answer. */
  problems?: string[],
): string | undefined {
  const found: string[] = []
  let nodes = 0

  const walk = (value: unknown, pointer: string, depth: number) => {
    if (
      value === null ||
      typeof value !== "object" ||
      depth > MAX_ANSWER_DEPTH ||
      ++nodes > MAX_ANSWER_NODES
    ) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        walk(item, `${pointer}/${index}`, depth + 1),
      )
      return
    }

    const record = value as Record<string, unknown>

    if (typeof record.$result === "string") {
      return
    }

    if (isResultHandle(record.result)) {
      found.push(pointer)
      return
    }

    for (const [key, item] of Object.entries(record)) {
      walk(
        item,
        `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        depth + 1,
      )
    }
  }

  walk(args, "", 0)

  if (found.length !== 1) {
    return undefined
  }

  const at = found[0]!

  // Problems quote a path as "file/result": one at the answer or under it.
  const quoted = at.slice(1)

  if (
    problems &&
    (at === "" ||
      !problems.some(
        (problem) =>
          problem.startsWith(`"${quoted}"`) ||
          problem.startsWith(`"${quoted}/`),
      ))
  ) {
    return undefined
  }

  const handle = (
    (at === "" ? (args as Record<string, unknown>) : valueAt(args, at)) as {
      result: { $result: string }
    }
  ).result

  return `${at || "/"} is a tool's whole answer, not a file or text. Pass the handle inside it, ${at}/result, which is {"$result": "${handle.$result}"}.`
}

function valueAt(root: unknown, pointer: string): unknown {
  return pointer
    .split("/")
    .slice(1)
    .reduce<unknown>(
      (value, part) =>
        (value as Record<string, unknown> | undefined)?.[
          part.replace(/~1/g, "/").replace(/~0/g, "~")
        ],
      root,
    )
}
