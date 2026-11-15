import { randomInt } from "node:crypto"

import {
  DEFAULT_PASSWORD_RECIPE,
  MAX_GENERATE_EXCLUDE,
  MAX_GENERATED_LENGTH,
  MIN_GENERATED_LENGTH,
  PASSWORD_SYMBOLS,
  type PasswordRecipe,
} from "./constants"
import { invalid } from "./errors"

/**
 * A password PCP makes for one of the owner's secrets (request_secret's
 * `generate`, or the Generate switch on its page), so that neither the
 * owner nor an assistant has to come up with one and nobody sees it on the
 * way: it is made here, on PCP's machine, with Node's CSPRNG
 * (crypto.randomInt, which draws without modulo bias), and stored as the
 * secret's value at once. The owner can reveal it on the Secrets page; an
 * assistant never gets it back.
 *
 * Pure but for the random source, which a test may swap.
 */

const SETS = {
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: PASSWORD_SYMBOLS,
} as const

type SetName = keyof typeof SETS

const SET_NAMES = Object.keys(SETS) as SetName[]

const SET_WORDS: Record<SetName, string> = {
  lowercase: "lower-case letters",
  uppercase: "capital letters",
  digits: "digits",
  symbols: "symbols",
}

/** A whole number in [0, max): uniform, from a CSPRNG. */
export type RandomBelow = (max: number) => number

const cryptoBelow: RandomBelow = (max) => randomInt(max)

/**
 * A recipe as an assistant or the owner's page sent it, checked: a whole
 * length within bounds, at least one kind of character, and printable
 * ASCII to leave out that leaves something of every kind asked for. What is
 * left out takes the default.
 */
export function checkPasswordRecipe(input: unknown): PasswordRecipe {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("Describe the password to make as an object.")
  }

  const raw = input as Record<string, unknown>
  const length = raw.length ?? DEFAULT_PASSWORD_RECIPE.length

  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < MIN_GENERATED_LENGTH ||
    length > MAX_GENERATED_LENGTH
  ) {
    throw invalid(
      `A made password is ${MIN_GENERATED_LENGTH} to ${MAX_GENERATED_LENGTH} characters long.`,
    )
  }

  const recipe: PasswordRecipe = { ...DEFAULT_PASSWORD_RECIPE, length }

  for (const name of SET_NAMES) {
    const value = raw[name]

    if (value !== undefined) {
      if (typeof value !== "boolean") {
        throw invalid(`${name} is true or false.`)
      }

      recipe[name] = value
    }
  }

  const exclude = raw.exclude ?? ""

  if (typeof exclude !== "string") {
    throw invalid("exclude is the characters to leave out, as text.")
  }

  if (exclude.length > MAX_GENERATE_EXCLUDE) {
    throw invalid(
      `Leave out at most ${MAX_GENERATE_EXCLUDE} characters with exclude.`,
    )
  }

  if (!/^[\x21-\x7e]*$/.test(exclude)) {
    throw invalid(
      "exclude holds printable characters only, with no spaces: the ones a made password may not have.",
    )
  }

  recipe.exclude = [...new Set(exclude)].join("")
  const sets = chosenSets(recipe)

  if (sets.length === 0) {
    throw invalid(
      "Choose at least one kind of character: lowercase, uppercase, digits or symbols.",
    )
  }

  for (const [name, chars] of sets) {
    if (chars.length === 0) {
      throw invalid(
        `exclude leaves out every one of the ${SET_WORDS[name]}: turn them off instead.`,
      )
    }
  }

  if (sets.length > recipe.length) {
    throw invalid("The password is too short for every kind of character.")
  }

  return recipe
}

/** The kinds of character a recipe asks for, without the ones left out. */
function chosenSets(recipe: PasswordRecipe): Array<[SetName, string]> {
  return SET_NAMES.filter((name) => recipe[name]).map((name) => [
    name,
    [...SETS[name]].filter((char) => !recipe.exclude.includes(char)).join(""),
  ])
}

/**
 * A new password from a checked recipe: one character of every kind it
 * asks for (sites that demand each are common), the rest from all of them,
 * then shuffled (Fisher–Yates), every draw a uniform one from `random`.
 */
export function generatePassword(
  recipe: PasswordRecipe,
  random: RandomBelow = cryptoBelow,
): string {
  const sets = chosenSets(checkPasswordRecipe(recipe)).map(([, chars]) => chars)
  const all = sets.join("")
  const chars: string[] = sets.map((set) => set[random(set.length)]!)

  while (chars.length < recipe.length) {
    chars.push(all[random(all.length)]!)
  }

  for (let i = chars.length - 1; i > 0; i--) {
    const j = random(i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }

  return chars.join("")
}

/** A recipe in the owner's words, for the request's page and its answer. */
export function describeRecipe(recipe: PasswordRecipe): string {
  const kinds = SET_NAMES.filter((name) => recipe[name]).map(
    (name) => SET_WORDS[name],
  )

  return `${recipe.length} characters: ${kinds.join(", ")}${recipe.exclude ? `, without ${recipe.exclude}` : ""}`
}
