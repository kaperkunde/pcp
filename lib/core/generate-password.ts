import { randomInt } from "node:crypto"

import {
  DEFAULT_PASSWORD_RECIPE,
  DEFAULT_TOKEN_RECIPE,
  MAX_GENERATE_EXCLUDE,
  MAX_GENERATED_LENGTH,
  MIN_GENERATED_LENGTH,
  PASSWORD_SYMBOLS,
  SECRET_FORMATS,
  type PasswordRecipe,
  type SecretFormat,
} from "./constants"
import { invalid } from "./errors"

/**
 * A value PCP makes for one of the owner's secrets (request_secret's
 * `generate`, a proposal's, or "Have PCP make it" on a request's page), so
 * that neither the owner nor an assistant has to come up with one and
 * nobody sees it on the way: it is made here, on PCP's machine, with Node's
 * CSPRNG (crypto.randomInt, which draws without modulo bias), and stored as
 * the secret's value at once. The owner can reveal it on the Secrets page;
 * an assistant never gets it back.
 *
 * A recipe's `format` says what it looks like: a password from the kinds
 * of character it turns on (a character of each), or a token of letters
 * and digits, hex digits or base64url characters, `length` characters
 * long. (@kaperkunde/next-kit's randomCode makes grouped codes from one
 * alphabet, with no random source a test can swap, so it is not used.)
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
    throw invalid("Describe the value to make as an object.")
  }

  const raw = input as Record<string, unknown>
  const format = raw.format ?? "password"

  if (
    typeof format !== "string" ||
    !(SECRET_FORMATS as readonly string[]).includes(format)
  ) {
    throw invalid(`format is one of ${SECRET_FORMATS.join(", ")}.`)
  }

  const base =
    format === "password" ? DEFAULT_PASSWORD_RECIPE : DEFAULT_TOKEN_RECIPE
  const length = raw.length ?? base.length

  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < MIN_GENERATED_LENGTH ||
    length > MAX_GENERATED_LENGTH
  ) {
    throw invalid(
      `A made value is ${MIN_GENERATED_LENGTH} to ${MAX_GENERATED_LENGTH} characters long.`,
    )
  }

  const recipe: PasswordRecipe = {
    ...DEFAULT_PASSWORD_RECIPE,
    format: format as SecretFormat,
    length,
  }

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

  if (recipe.format !== "password") {
    // A token's alphabet is fixed by its format: hex and base64url are
    // encodings, so nothing is left out of them.
    if (recipe.exclude && recipe.format !== "alphanumeric") {
      throw invalid(
        `exclude is for a password or letters and digits, not ${recipe.format}.`,
      )
    }

    if (alphabetOf(recipe).length < 2) {
      throw invalid("exclude leaves too few characters to make it from.")
    }

    return recipe
  }

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
  const checked = checkPasswordRecipe(recipe)

  if (checked.format !== "password") {
    const alphabet = alphabetOf(checked)
    let value = ""

    while (value.length < checked.length) {
      value += alphabet[random(alphabet.length)]!
    }

    return value
  }

  const sets = chosenSets(checked).map(([, chars]) => chars)
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

const TOKEN_ALPHABETS: Record<Exclude<SecretFormat, "password">, string> = {
  alphanumeric:
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  hex: "0123456789abcdef",
  base64url:
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
}

/** A token format's characters, without the ones left out. */
function alphabetOf(recipe: PasswordRecipe): string {
  const format = recipe.format ?? "password"

  return format === "password"
    ? ""
    : [...TOKEN_ALPHABETS[format]]
        .filter((char) => !recipe.exclude.includes(char))
        .join("")
}

const FORMAT_WORDS: Record<Exclude<SecretFormat, "password">, string> = {
  alphanumeric: "letters and digits",
  hex: "hex digits",
  base64url: "base64url characters (letters, digits, - and _)",
}

/** A recipe in the owner's words, for the request's page and its answer. */
export function describeRecipe(recipe: PasswordRecipe): string {
  const format = recipe.format ?? "password"

  if (format !== "password") {
    return `${recipe.length} characters: ${FORMAT_WORDS[format]}${recipe.exclude ? `, without ${recipe.exclude}` : ""}`
  }

  const kinds = SET_NAMES.filter((name) => recipe[name]).map(
    (name) => SET_WORDS[name],
  )

  return `${recipe.length} characters: ${kinds.join(", ")}${recipe.exclude ? `, without ${recipe.exclude}` : ""}`
}
