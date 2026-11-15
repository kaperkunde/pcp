import { describe, expect, it } from "vitest"

import type { LimitFieldShown } from "@/lib/core/gate/proposals"
import { initialLimitInputs, limitsFromInputs } from "./limit-inputs"

const field = (
  over: Partial<LimitFieldShown> & Pick<LimitFieldShown, "field" | "unit">,
): LimitFieldShown => ({
  label: over.field,
  nullable: false,
  defaultShown: "",
  defaultValue: null,
  ...over,
})

describe("limits as the owner types them", () => {
  it("keeps a value left as it was filled in exactly, whatever the unit rounds", () => {
    const fields = [
      field({
        field: "bytesPerDay",
        unit: "bytes",
        nullable: true,
        value: 1_234_567,
      }),
      field({ field: "timeoutMs", unit: "ms", value: 45_123 }),
      field({ field: "maxConcurrent", unit: "calls", value: 2 }),
    ]
    const inputs = initialLimitInputs(fields)

    expect(inputs).toEqual({
      bytesPerDay: "1205.632",
      timeoutMs: "45.123",
      maxConcurrent: "2",
    })
    expect(limitsFromInputs(fields, inputs)).toEqual({
      limits: { bytesPerDay: 1_234_567, timeoutMs: 45_123, maxConcurrent: 2 },
    })
  })

  it("reads what was typed in seconds and KiB, none, and empty as the default", () => {
    const fields = [
      field({ field: "bytesPerDay", unit: "bytes", nullable: true }),
      field({ field: "callsPerMinute", unit: "calls", nullable: true }),
      field({ field: "timeoutMs", unit: "ms" }),
      field({ field: "maxConcurrent", unit: "calls" }),
    ]

    expect(
      limitsFromInputs(fields, {
        bytesPerDay: "2048",
        callsPerMinute: "none",
        timeoutMs: "1.5",
        maxConcurrent: "",
      }),
    ).toEqual({
      limits: {
        bytesPerDay: 2_097_152,
        callsPerMinute: null,
        timeoutMs: 1_500,
      },
    })
    expect(limitsFromInputs(fields, { maxConcurrent: "none" })).toEqual({
      error: expect.stringContaining("maxConcurrent: enter a number"),
    })
    expect(limitsFromInputs(fields, { timeoutMs: "soon" })).toEqual({
      error: expect.stringContaining("of seconds"),
    })
  })
})
