import { invalid } from "../errors"
import { MAX_EXIT_LABEL_CHARS, MAX_EXIT_NAME_CHARS } from "./limits"

/** An exit's name and label, as the owner writes them and an assistant names one. */

const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export function parseExitName(raw: string): string {
  const name = raw.trim().toLowerCase()

  if (!name) {
    throw invalid("Give the exit a name.")
  }

  if (name.length > MAX_EXIT_NAME_CHARS || !NAME.test(name)) {
    throw invalid(
      `An exit's name is up to ${MAX_EXIT_NAME_CHARS} lower-case letters, digits and dashes, like us-vps: assistants name it in their calls.`,
    )
  }

  return name
}

export function parseExitLabel(raw: string | undefined): string {
  const label = (raw ?? "").trim()

  if (label.length > MAX_EXIT_LABEL_CHARS) {
    throw invalid(`Keep the label under ${MAX_EXIT_LABEL_CHARS} characters.`)
  }

  // The label is shown to the owner in a request: nothing hidden in it.
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(label)) {
    throw invalid("The label has characters that do not show on screen.")
  }

  return label
}
