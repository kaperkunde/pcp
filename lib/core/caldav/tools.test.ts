import { describe, expect, it } from "vitest"

import { calendarTools, calendarToolSpec } from "./tools"

// The calendar tools on PCP's one tool interface: schemas that say what the
// check does, and recurrence's month_days under its old name for a release.

describe("the calendar tools", () => {
  it("describe every argument, and publish their rules", () => {
    for (const tool of calendarTools({ readOnly: false })) {
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      })
    }

    expect(calendarToolSpec("complete_reminder")!.inputSchema().allOf).toEqual([
      { oneOf: [{ required: ["id"] }, { required: ["ids"] }] },
    ])
  })

  it("take recurrence.monthDays as month_days for a release, with a note", () => {
    const create = calendarToolSpec("create_event")!

    expect(
      create.check({
        title: "Rent",
        start: "2026-11-01",
        recurrence: { frequency: "monthly", monthDays: [1] },
      }),
    ).toMatchObject({
      fits: true,
      args: { recurrence: { frequency: "monthly", month_days: [1] } },
      notes: [
        "recurrence.monthDays was renamed to month_days; use month_days.",
      ],
    })
  })

  it("refuse in the rule's own words", () => {
    const update = calendarToolSpec("update_event")!

    expect(update.check({ id: "home/a.ics" })).toMatchObject({
      fits: false,
      problems: ["Say what to change."],
    })
    expect(
      update.check({
        id: "home/a.ics",
        occurrence: "20261101T090000Z",
        calendar: "Work",
      }),
    ).toMatchObject({
      fits: false,
      problems: [
        "A whole event moves to another calendar: leave occurrence out.",
      ],
    })
    expect(
      update.check({
        id: "home/a.ics",
        occurrence: "20261101T090000Z",
        calendar: "Work",
        scope: "all",
      }),
    ).toMatchObject({ fits: true })
  })
})
