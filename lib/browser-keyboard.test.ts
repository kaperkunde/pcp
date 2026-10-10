import { describe, expect, it } from "vitest"

import {
  boxEdit,
  editEvents,
  isNamedKey,
  KEYBOARD_EDIT_MAX,
  keyPress,
} from "@/lib/browser-keyboard"
import { InputEventSchema } from "@/lib/core/browser/input-protocol"

describe("boxEdit", () => {
  it("types what was added at the end", () => {
    expect(boxEdit("", "h")).toEqual({ deletes: 0, text: "h" })
    expect(boxEdit("hel", "hello ")).toEqual({ deletes: 0, text: "lo " })
  })

  it("deletes what was taken out", () => {
    expect(boxEdit("hello", "hell")).toEqual({ deletes: 1, text: "" })
    expect(boxEdit("hello", "")).toEqual({ deletes: 5, text: "" })
  })

  it("replaces a word the keyboard corrected", () => {
    expect(boxEdit("say teh", "say the")).toEqual({ deletes: 2, text: "he" })
    expect(boxEdit("hel", "hello ")).toEqual({ deletes: 0, text: "lo " })
    expect(boxEdit("helo", "hello")).toEqual({ deletes: 1, text: "lo" })
  })

  it("changes nothing when nothing changed", () => {
    expect(boxEdit("same", "same")).toEqual({ deletes: 0, text: "" })
  })

  it("counts an emoji as one key", () => {
    expect(boxEdit("a😀", "a")).toEqual({ deletes: 1, text: "" })
    expect(boxEdit("a", "a😀")).toEqual({ deletes: 0, text: "😀" })
  })

  it("never deletes more than a keyboard may ask for at once", () => {
    const long = "x".repeat(KEYBOARD_EDIT_MAX + 100)
    expect(boxEdit(long, "").deletes).toBe(KEYBOARD_EDIT_MAX)
  })
})

describe("keyPress", () => {
  it("is a key down and a key up, with the key code a page expects", () => {
    expect(keyPress(5, "Enter")).toEqual([
      {
        type: "keydown",
        repeat: false,
        t: 5,
        key: "Enter",
        code: "",
        keyCode: 13,
        modifiers: 0,
      },
      {
        type: "keyup",
        t: 5,
        key: "Enter",
        code: "",
        keyCode: 13,
        modifiers: 0,
      },
    ])
    expect(keyPress(0, "a")[0]).toMatchObject({ key: "a", keyCode: 65 })
    expect(keyPress(0, "7")[0]).toMatchObject({ key: "7", keyCode: 55 })
    expect(keyPress(0, "é")[0]).toMatchObject({ key: "é", keyCode: 0 })
  })
})

describe("editEvents", () => {
  const keys = (events: ReturnType<typeof editEvents>) =>
    events.map((event) => {
      if (event.type === "text") return `text:${event.text}`
      if (event.type === "keydown" || event.type === "keyup") {
        return `${event.type}:${event.key}`
      }
      return event.type
    })

  it("presses a letter as a key", () => {
    expect(keys(editEvents(1, { deletes: 0, text: "h" }))).toEqual([
      "keydown:h",
      "keyup:h",
    ])
  })

  it("types more than a letter in one go", () => {
    expect(keys(editEvents(1, { deletes: 0, text: "hello " }))).toEqual([
      "text:hello ",
    ])
    expect(keys(editEvents(1, { deletes: 0, text: "😀" }))).toEqual([
      "keydown:😀",
      "keyup:😀",
    ])
  })

  it("presses Backspace for each letter taken out, then types", () => {
    expect(keys(editEvents(1, { deletes: 2, text: "he" }))).toEqual([
      "keydown:Backspace",
      "keyup:Backspace",
      "keydown:Backspace",
      "keyup:Backspace",
      "text:he",
    ])
  })

  it("makes nothing of no edit", () => {
    expect(editEvents(1, { deletes: 0, text: "" })).toEqual([])
  })

  it("makes events the server accepts", () => {
    const events = editEvents(3, { deletes: 1, text: "ab" }).concat(
      keyPress(3, "Enter"),
    )
    for (const event of events) {
      expect(InputEventSchema.safeParse(event).success).toBe(true)
    }
  })

  it("keeps the text to what the server takes", () => {
    const [event] = editEvents(1, { deletes: 0, text: "x".repeat(20_000) })
    expect(event).toMatchObject({ type: "text" })
    expect(InputEventSchema.safeParse(event).success).toBe(true)
  })
})

describe("isNamedKey", () => {
  it("is a key a keyboard names and types no letter with", () => {
    for (const key of ["Backspace", "Enter", "ArrowLeft", "Tab", "Escape"]) {
      expect(isNamedKey({ key, keyCode: 8 })).toBe(true)
    }
  })

  it("is not a letter, which arrives as an edit of the box", () => {
    expect(isNamedKey({ key: "a", keyCode: 65 })).toBe(false)
    expect(isNamedKey({ key: " ", keyCode: 32 })).toBe(false)
  })

  it("is not a key pressed in the middle of a word", () => {
    expect(isNamedKey({ key: "Backspace", keyCode: 229 })).toBe(false)
    expect(isNamedKey({ key: "Enter", keyCode: 13, isComposing: true })).toBe(
      false,
    )
    expect(isNamedKey({ key: "Unidentified", keyCode: 0 })).toBe(false)
    expect(isNamedKey({ key: "Process", keyCode: 229 })).toBe(false)
    expect(isNamedKey({ key: "Dead", keyCode: 0 })).toBe(false)
  })
})
