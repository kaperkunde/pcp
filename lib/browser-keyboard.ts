import type { InputEvent } from "@/lib/core/browser/input-protocol"

/**
 * What a phone's on-screen keyboard types into the live view. A canvas
 * cannot take the keyboard, so the live view keeps a hidden text box; a
 * soft keyboard does not send the keys a person presses but edits that box
 * (composing words, correcting them, deleting letters), so what reaches the
 * page is the difference between the box before and after each edit. Client
 * components may import this: it takes the input types only.
 */

/** The box is emptied once it holds more than this, between words. */
export const KEYBOARD_BOX_MAX = 256
/** The most one edit may delete or type, whatever a keyboard claims. */
export const KEYBOARD_EDIT_MAX = 500

/**
 * What takes `before` to `after` when edits happen at the end, as a person
 * types: letters to delete, then text to type. Counted in characters, not
 * UTF-16 units, so one emoji is one key.
 */
export function boxEdit(
  before: string,
  after: string,
): { deletes: number; text: string } {
  const from = [...before]
  const to = [...after]
  let same = 0

  while (same < from.length && same < to.length && from[same] === to[same]) {
    same += 1
  }

  return {
    deletes: Math.min(from.length - same, KEYBOARD_EDIT_MAX),
    text: to.slice(same).join(""),
  }
}

const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  " ": 32,
}

/** A key pressed and let go, as the page sees a person's. */
export function keyPress(t: number, key: string, modifiers = 0): InputEvent[] {
  const code = key.length === 1 && /[a-z0-9]/i.test(key)
  const keyCode = KEY_CODES[key] ?? (code ? key.toUpperCase().charCodeAt(0) : 0)
  const event = { t, key, code: "", keyCode, modifiers }

  return [
    { type: "keydown", repeat: false, ...event },
    { type: "keyup", ...event },
  ]
}

/**
 * The input an edit of the box becomes: Backspace for each letter taken
 * out, then the text put in: one letter is a key pressed, more is typed in
 * one go (a corrected word, dictation, an emoji, a paste).
 */
export function editEvents(
  t: number,
  edit: { deletes: number; text: string },
): InputEvent[] {
  const events: InputEvent[] = []

  for (let i = 0; i < edit.deletes; i += 1) {
    events.push(...keyPress(t, "Backspace"))
  }

  if ([...edit.text].length === 1) {
    events.push(...keyPress(t, edit.text))
  } else if (edit.text) {
    events.push({ type: "text", t, text: edit.text.slice(0, 10_000) })
  }

  return events
}

/**
 * Keys a keyboard sends by name that never type a letter into the box. A
 * soft keyboard sends them as themselves when it is not in the middle of a
 * word; mid-word it sends keyCode 229, "Process" or "Unidentified", which
 * the box's edit already carries.
 */
export function isNamedKey(event: {
  key: string
  keyCode: number
  isComposing?: boolean
}): boolean {
  if (event.isComposing || event.keyCode === 229) return false
  if (event.key.length <= 1) return false
  return !["Unidentified", "Process", "Dead", "Compose"].includes(event.key)
}
