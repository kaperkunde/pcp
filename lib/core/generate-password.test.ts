import { describe, expect, it } from "vitest"

import { DEFAULT_PASSWORD_RECIPE, PASSWORD_SYMBOLS } from "./constants"
import {
  checkPasswordRecipe,
  describeRecipe,
  generatePassword,
} from "./generate-password"

// A password PCP makes for a secret (#70): the length asked for, a
// character of every kind chosen, none it was told to leave out, drawn
// evenly, and recipes that cannot be met refused before anything is made.

describe("generatePassword", () => {
  it("makes the length asked for, from the kinds chosen only", () => {
    for (let i = 0; i < 50; i++) {
      const value = generatePassword({
        ...DEFAULT_PASSWORD_RECIPE,
        length: 12,
        symbols: false,
      })

      expect(value).toHaveLength(12)
      expect(value).toMatch(/^[A-Za-z0-9]+$/)
      expect(value).toMatch(/[a-z]/)
      expect(value).toMatch(/[A-Z]/)
      expect(value).toMatch(/[0-9]/)
    }
  })

  it("has a character of every kind, even at the shortest", () => {
    for (let i = 0; i < 200; i++) {
      const value = generatePassword({ ...DEFAULT_PASSWORD_RECIPE, length: 8 })
      expect(value).toMatch(/[a-z]/)
      expect(value).toMatch(/[A-Z]/)
      expect(value).toMatch(/[0-9]/)
      expect([...value].some((char) => PASSWORD_SYMBOLS.includes(char))).toBe(
        true,
      )
    }
  })

  it("leaves out what exclude names", () => {
    const exclude = "0O1lI|"

    for (let i = 0; i < 100; i++) {
      const value = generatePassword({
        ...DEFAULT_PASSWORD_RECIPE,
        length: 64,
        exclude,
      })
      expect([...value].some((char) => exclude.includes(char))).toBe(false)
    }
  })

  it("draws every character about as often as the others", () => {
    const counts = new Map<string, number>()
    const recipe = {
      ...DEFAULT_PASSWORD_RECIPE,
      length: 100,
      uppercase: false,
      symbols: false,
    }

    for (let i = 0; i < 400; i++) {
      for (const char of generatePassword(recipe)) {
        counts.set(char, (counts.get(char) ?? 0) + 1)
      }
    }

    // 36 characters, 40,000 draws: about 1,111 each.
    expect(counts.size).toBe(36)
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(850)
      expect(count).toBeLessThan(1450)
    }
  })

  it("takes every draw from the random source it is given", () => {
    const draws: number[] = []
    const value = generatePassword(
      { ...DEFAULT_PASSWORD_RECIPE, length: 10, symbols: false },
      (max) => {
        draws.push(max)
        return 0
      },
    )

    expect(value).toHaveLength(10)
    // One per kind, the rest from all 62, then the shuffle.
    expect(draws.slice(0, 3)).toEqual([26, 26, 10])
    expect(draws.slice(3, 10)).toEqual(Array(7).fill(62))
  })
})

describe("checkPasswordRecipe", () => {
  it("fills in what is left out", () => {
    expect(checkPasswordRecipe({})).toEqual(DEFAULT_PASSWORD_RECIPE)
    expect(checkPasswordRecipe({ length: 16, symbols: false })).toMatchObject({
      length: 16,
      symbols: false,
      digits: true,
    })
  })

  it("refuses a recipe that cannot be met", () => {
    expect(() => checkPasswordRecipe({ length: 7 })).toThrow(/8 to 128/)
    expect(() => checkPasswordRecipe({ length: 129 })).toThrow(/8 to 128/)
    expect(() => checkPasswordRecipe({ length: 12.5 })).toThrow(/8 to 128/)
    expect(() =>
      checkPasswordRecipe({
        lowercase: false,
        uppercase: false,
        digits: false,
        symbols: false,
      }),
    ).toThrow(/at least one kind/)
    expect(() => checkPasswordRecipe({ exclude: "0123456789" })).toThrow(
      /every one of the digits/,
    )
    expect(() => checkPasswordRecipe({ exclude: "a b" })).toThrow(/printable/)
    expect(() => checkPasswordRecipe({ exclude: "é" })).toThrow(/printable/)
    expect(() => checkPasswordRecipe({ digits: "yes" })).toThrow(
      /true or false/,
    )
    expect(() => checkPasswordRecipe(null)).toThrow(/object/)
  })

  it("says what it makes", () => {
    expect(
      describeRecipe({
        ...DEFAULT_PASSWORD_RECIPE,
        symbols: false,
        exclude: "0O",
      }),
    ).toBe(
      "24 characters: lower-case letters, capital letters, digits, without 0O",
    )
  })
})
