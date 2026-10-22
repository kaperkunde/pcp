import YAML from "yaml"

import type { Skill } from "@/lib/generated/prisma/client"

import { requireLiveToken } from "./api-tokens"
import {
  MAX_SKILL_BODY,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_FILE_CHARS,
  MAX_SKILL_FILE_PATH,
  MAX_SKILL_FILES,
  MAX_SKILL_NAME,
  MAX_SKILL_TOOLS,
  MAX_SKILLS,
} from "./constants"
import type { VaultContext } from "./context"
import { asBytes, decryptString, encryptString } from "./crypto"
import { db } from "./db"
import { invalid, notFound, PcpError } from "./errors"
import { newId } from "./ids"
import { diffLines, type DiffLine } from "./line-merge"
import { hiddenCharacter, withoutPresentation } from "./memories"
import { readSkillNote } from "./personal-notes"
import { canonicalJson } from "./permission-rules"
import { readStrictYaml } from "./strict-yaml"

/**
 * Skills: procedures the owner approved, for an assistant to follow when a
 * task matches. Modelled on Agent Skills: a skill is a SKILL.md (YAML
 * frontmatter with its name, a description of when to use it, its version
 * and the server/tool names it uses, then Markdown steps), with a few
 * reference text files beside it. Nothing in one is ever run: a "script"
 * among its files is text to read.
 *
 * A memory is a note an assistant weighs; a skill is how the owner wants a
 * kind of task done. So every word of one is the owner's or one they read:
 *
 * - The owner writes, edits, imports and deletes skills on PCP's Skills page.
 * - An assistant changes them only by asking: the gateway's memory tool takes
 *   paths under /skills/<name>/ (SKILL.md, or a file), and every write there
 *   becomes a permission request (`skill_change`) that shows the owner the
 *   whole skill as it would be, with a line diff against what it is now.
 *   Nothing is written until they agree, what is written is what they read,
 *   and only onto the version they were shown (`basis`): a skill that
 *   changed in the meantime is left alone.
 *
 * Which tokens see a skill is the token's (`allSkills`, or the skills in
 * api_token_skill), resolved into ResolvedToken.skillIds. Discovery is the
 * gateway's search and describe; the instructions list the skills a token
 * sees by name and description.
 *
 * The name, description, version, body, tools and files are one ciphertext
 * under the vault's key with "skill:<id>" as associated data, so names are
 * unique by checking here, not by an index, as memory paths are.
 */

export const SKILL_ROOT = "/skills"
export const SKILL_FILE = "SKILL.md"
/** How search and describe name a skill: skill:<name>, or skill:<name>/<file>. */
export const SKILL_REF = "skill:"

/** The line describe puts above a skill. */
export const SKILL_FRAME =
  "A procedure the owner approved: follow it when the task matches."

/**
 * How many characters of skill names and descriptions the gateway's
 * instructions carry; past it, skills are named only, and past
 * MAX_INSTRUCTION_SKILLS not at all (search finds them).
 */
export const SKILL_INSTRUCTIONS_CHARS = 3_000
export const MAX_INSTRUCTION_SKILLS = 60

/** The most characters of YAML a SKILL.md's frontmatter may have. */
const MAX_FRONTMATTER_CHARS = 4_000

export type SkillAuthor = "owner" | "assistant"
export type SkillFile = { path: string; text: string }
/**
 * Frontmatter keys PCP does not use itself, which other tools write
 * (license, metadata, allowed-tools, compatibility and anything else): kept
 * with the skill and written back out as they were, so a skill imported from
 * elsewhere goes back the way it came. Plain YAML values; nothing reads them.
 */
export type SkillExtra = Record<string, unknown>

/** What a skill is: what the ciphertext holds. */
export type SkillBody = {
  name: string
  description: string
  /** 1 when made, one more with every change. */
  version: number
  /** The Markdown after the frontmatter: the steps. */
  body: string
  /** The server/tool names it uses. */
  tools: string[]
  files: SkillFile[]
  /** Left out by skills stored before PCP kept other tools' keys. */
  extra?: SkillExtra
}

export type SkillEntry = SkillBody & {
  id: string
  author: SkillAuthor
  /**
   * The owner's own note on the skill (lib/core/personal-notes.ts): not part
   * of its SKILL.md, never in a repository, read by assistants beside it.
   */
  note: string | null
  createdAt: Date
  updatedAt: Date
}

/** A skill's own fields, before PCP gives it a version. */
export type SkillInput = Omit<SkillBody, "version" | "files"> & {
  files?: SkillFile[]
}

/** What a SKILL.md says, read from its text. */
export type SkillText = {
  name: string
  description: string
  /** What the frontmatter said; PCP counts versions itself. */
  version: number | null
  tools: string[]
  body: string
  /** The frontmatter's other keys, as they were. */
  extra: SkillExtra
  /** The pcp_format a repository's copy carries (lib/core/repos/). */
  format: number | null
}

// ---- SKILL.md --------------------------------------------------------------

/** The frontmatter keys PCP reads; every other one is kept as it is. */
const KNOWN_KEYS = new Set([
  "name",
  "description",
  "version",
  "tools",
  "pcp_format",
])
/** How deep a kept key's value may nest. */
const MAX_EXTRA_DEPTH = 8
const MAX_EXTRA_KEY = 100

const NOT_SKILL_MD =
  "A SKILL.md starts with YAML frontmatter between two --- lines, with the skill's name and a description of when to use it, then the steps in Markdown."

/**
 * A SKILL.md's text as PCP reads it: the frontmatter's name, description,
 * version and tools, every other key as it is, and the Markdown body. What
 * it says is checked by checkSkill, not here.
 */
export function parseSkillMd(input: string): SkillText {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n")
  const opening = text.match(/^---[ \t]*\n/)

  if (!opening) {
    throw invalid(NOT_SKILL_MD)
  }

  const rest = text.slice(opening[0].length)
  const closing = rest.match(/(^|\n)---[ \t]*(\n|$)/)

  if (!closing || closing.index === undefined) {
    throw invalid(`${NOT_SKILL_MD} The closing --- is missing.`)
  }

  const yaml = rest.slice(0, closing.index)
  const body = rest
    .slice(closing.index + closing[0].length)
    .replace(/^\n+/, "")
    .replace(/\s+$/, "")

  if (yaml.length > MAX_FRONTMATTER_CHARS) {
    throw invalid(
      `Keep the frontmatter under ${MAX_FRONTMATTER_CHARS} characters: a name, a description, a version and the tools.`,
    )
  }

  const front = readStrictYaml(yaml, "The frontmatter")

  if (front === null || typeof front !== "object" || Array.isArray(front)) {
    throw invalid(NOT_SKILL_MD)
  }

  const fields = front as Record<string, unknown>
  const extra: SkillExtra = {}

  for (const [key, value] of Object.entries(fields)) {
    if (!KNOWN_KEYS.has(key)) {
      extra[key] = value
    }
  }

  const string = (key: string): string => {
    const value = fields[key]

    if (value === undefined || value === null) {
      return ""
    }

    if (typeof value !== "string" && typeof value !== "number") {
      throw invalid(`The frontmatter's ${key} is text.`)
    }

    return String(value)
  }

  const version = fields.version
  const tools = fields.tools
  const format = fields.pcp_format

  if (
    format !== undefined &&
    format !== null &&
    !(typeof format === "number" && Number.isInteger(format) && format > 0)
  ) {
    throw invalid("The frontmatter's pcp_format is a whole number, like 1.")
  }

  if (
    version !== undefined &&
    version !== null &&
    !(typeof version === "number" && Number.isInteger(version) && version > 0)
  ) {
    throw invalid("The frontmatter's version is a whole number, like 3.")
  }

  let toolList: string[] = []

  if (Array.isArray(tools)) {
    if (tools.some((tool) => typeof tool !== "string")) {
      throw invalid(
        'The frontmatter\'s tools are server/tool names, like ["github/create_issue"].',
      )
    }

    toolList = tools as string[]
  } else if (typeof tools === "string") {
    toolList = tools.split(/[\s,]+/).filter(Boolean)
  } else if (tools !== undefined && tools !== null) {
    throw invalid(
      'The frontmatter\'s tools are server/tool names, like ["github/create_issue"].',
    )
  }

  return {
    name: string("name"),
    description: string("description"),
    version: typeof version === "number" ? version : null,
    tools: toolList,
    body,
    extra,
    format: typeof format === "number" ? format : null,
  }
}

/**
 * A skill as its SKILL.md text: frontmatter, then the body. `format` is
 * the pcp_format a repository's copy carries; the Skills page leaves it out.
 */
export function serializeSkillMd(
  skill: Pick<
    SkillBody,
    "name" | "description" | "version" | "body" | "tools" | "extra"
  >,
  { format }: { format?: number } = {},
): string {
  const front: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    ...(format !== undefined ? { pcp_format: format } : {}),
    ...(skill.tools.length > 0 ? { tools: skill.tools } : {}),
  }

  for (const [key, value] of Object.entries(skill.extra ?? {})) {
    if (!KNOWN_KEYS.has(key)) {
      front[key] = value
    }
  }

  return `---\n${YAML.stringify(front, { lineWidth: 0, aliasDuplicateObjects: false })}---\n\n${skill.body}\n`
}

// ---- Checks ----------------------------------------------------------------

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TOOL = /^[a-z0-9][a-z0-9_-]*\/[^\s/][^\s]*$/i
const FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function noHidden(text: string, what: string): void {
  const hidden = hiddenCharacter(text)

  if (hidden) {
    throw invalid(
      `The ${what} has a character that does not show on screen (${hidden}). Take it out: a skill holds only what a person can read.`,
    )
  }
}

/** A skill's name, checked: a slug, as an Agent Skill's is. */
export function checkSkillName(input: string): string {
  const name = input.trim()

  if (!name) {
    throw invalid("Give the skill a name, like release-notes.")
  }

  if (name.length > MAX_SKILL_NAME || !NAME.test(name)) {
    throw invalid(
      `"${name.slice(0, MAX_SKILL_NAME)}" is not a usable skill name: lower-case letters, numbers and single hyphens, like release-notes, at most ${MAX_SKILL_NAME} characters.`,
    )
  }

  return name
}

/** A reference file's path inside its skill, like reference/api.md. */
export function checkSkillFilePath(input: string): string {
  const path = input.trim().replace(/^\/+/, "")

  if (!path) {
    throw invalid("Give the file a path, like reference.md.")
  }

  if (path.length > MAX_SKILL_FILE_PATH) {
    throw invalid(`Keep a file's path under ${MAX_SKILL_FILE_PATH} characters.`)
  }

  noHidden(path, "file's path")

  if (
    path
      .split("/")
      .some((segment) => !FILE_SEGMENT.test(segment) || /^\.+$/.test(segment))
  ) {
    throw invalid(
      `"${path}" is not a usable file path: letters, numbers, dots, dashes and underscores, with / between folders.`,
    )
  }

  if (path.toLowerCase() === SKILL_FILE.toLowerCase()) {
    throw invalid(`${SKILL_FILE} is the skill itself, not one of its files.`)
  }

  return path
}

function checkText(input: string, what: string, max: number): string {
  const text = input.replace(/\r\n?/g, "\n").replace(/\s+$/, "")

  if (!text.trim()) {
    throw invalid(`The ${what} is empty.`)
  }

  noHidden(text, what)

  if (text.length > max) {
    throw invalid(
      `The ${what} is at most ${max.toLocaleString("en")} characters, so the owner can read all of it; this one has ${text.length.toLocaleString("en")}.`,
    )
  }

  return text
}

/**
 * Other tools' frontmatter keys, checked: plain values, nothing that does
 * not show on screen, and no more than a frontmatter holds.
 */
function checkExtra(input: unknown): SkillExtra {
  if (input === undefined || input === null) {
    return {}
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    throw invalid("The frontmatter's other keys are a map of names to values.")
  }

  const walk = (value: unknown, depth: number, where: string): void => {
    if (depth > MAX_EXTRA_DEPTH) {
      throw invalid(
        `The frontmatter's ${where} nests deeper than ${MAX_EXTRA_DEPTH} levels.`,
      )
    }

    if (value === null || typeof value === "boolean") {
      return
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw invalid(`The frontmatter's ${where} is not a number PCP keeps.`)
      }
      return
    }

    if (typeof value === "string") {
      noHidden(value.replace(/\r\n?/g, "\n"), `frontmatter's ${where}`)
      return
    }

    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, depth + 1, where))
      return
    }

    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        noHidden(key, `frontmatter's ${where}`)
        walk(item, depth + 1, where)
      }
      return
    }

    throw invalid(`The frontmatter's ${where} is not a plain value.`)
  }

  const extra: SkillExtra = {}

  for (const [key, value] of Object.entries(input)) {
    if (KNOWN_KEYS.has(key)) {
      throw invalid(`The frontmatter's ${key} is the skill's own.`)
    }

    if (!key.trim() || key.length > MAX_EXTRA_KEY) {
      throw invalid(
        `A frontmatter key is 1 to ${MAX_EXTRA_KEY} characters long.`,
      )
    }

    noHidden(key, "frontmatter's key")
    walk(value, 1, `"${key}"`)
    extra[key] = value
  }

  if (
    Object.keys(extra).length > 0 &&
    YAML.stringify(extra, { lineWidth: 0, aliasDuplicateObjects: false })
      .length > MAX_FRONTMATTER_CHARS
  ) {
    throw invalid(
      `Keep the frontmatter under ${MAX_FRONTMATTER_CHARS} characters, its other keys included.`,
    )
  }

  return extra
}

/**
 * Everything a skill says, checked and made plain (newlines, the
 * description on one line). Text that has just arrived goes through
 * `arrived` first; what an owner's answer writes is checked as they read it.
 */
export function checkSkill(
  input: SkillInput,
): Omit<SkillBody, "version"> & { files: SkillFile[]; extra: SkillExtra } {
  const name = checkSkillName(input.name)
  const description = checkText(
    input.description.replace(/\s+/g, " ").trim(),
    "description",
    MAX_SKILL_DESCRIPTION,
  )
  const body = checkText(input.body, "skill's text", MAX_SKILL_BODY)
  const tools = [...new Set(input.tools.map((tool) => tool.trim()))].filter(
    Boolean,
  )

  if (tools.length > MAX_SKILL_TOOLS) {
    throw invalid(`A skill names at most ${MAX_SKILL_TOOLS} tools.`)
  }

  for (const tool of tools) {
    noHidden(tool, "tool name")

    if (tool.length > 200 || !TOOL.test(tool)) {
      throw invalid(
        `"${tool.slice(0, 200)}" is not a tool name: write it as server/tool, like github/create_issue.`,
      )
    }
  }

  const files = input.files ?? []

  if (files.length > MAX_SKILL_FILES) {
    throw invalid(`A skill carries at most ${MAX_SKILL_FILES} files.`)
  }

  const paths = new Set<string>()
  const checked = files.map((file) => {
    const path = checkSkillFilePath(file.path)

    if (paths.has(path)) {
      throw invalid(`The skill has two files at ${path}.`)
    }

    paths.add(path)

    return {
      path,
      text: checkText(file.text, `file ${path}`, MAX_SKILL_FILE_CHARS),
    }
  })

  return {
    name,
    description,
    body,
    tools,
    files: checked,
    extra: checkExtra(input.extra),
  }
}

/** Every string in a kept value, without its emoji presentation selectors. */
function plainValues(value: unknown): unknown {
  if (typeof value === "string") {
    return withoutPresentation(value)
  }

  if (Array.isArray(value)) {
    return value.map(plainValues)
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, plainValues(item)]),
    )
  }

  return value
}

/** Text that has just arrived, before anything checks or shows it. */
function arrived(input: SkillInput): SkillInput {
  return {
    name: input.name,
    description: withoutPresentation(input.description),
    body: withoutPresentation(input.body),
    tools: input.tools,
    files: input.files?.map((file) => ({
      path: file.path,
      text: withoutPresentation(file.text),
    })),
    ...(input.extra !== undefined
      ? { extra: plainValues(input.extra) as SkillExtra }
      : {}),
  }
}

/**
 * A skill that has just arrived from outside PCP (a linked repository),
 * checked as the owner's own import is: prose without its emoji
 * presentation selectors, then everything checkSkill checks.
 */
export function checkArrivedSkill(
  input: SkillInput,
): ReturnType<typeof checkSkill> {
  return checkSkill(arrived(input))
}

// ---- Storage ---------------------------------------------------------------

function aad(id: string): string {
  return `skill:${id}`
}

function seal(ctx: VaultContext, id: string, body: SkillBody) {
  return asBytes(
    encryptString(
      ctx.dek,
      JSON.stringify({
        name: body.name,
        description: body.description,
        version: body.version,
        body: body.body,
        tools: body.tools,
        files: body.files,
        ...(body.extra && Object.keys(body.extra).length > 0
          ? { extra: body.extra }
          : {}),
      }),
      aad(id),
    ),
  )
}

function unseal(ctx: VaultContext, row: Skill): SkillEntry {
  const body = JSON.parse(
    decryptString(ctx.dek, Buffer.from(row.ciphertext), aad(row.id)),
  ) as SkillBody

  return {
    id: row.id,
    name: body.name,
    description: body.description,
    version: body.version,
    body: body.body,
    tools: body.tools ?? [],
    files: body.files ?? [],
    extra: body.extra ?? {},
    author: row.author === "assistant" ? "assistant" : "owner",
    note: readSkillNote(ctx, row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function load(ctx: VaultContext): Promise<SkillEntry[]> {
  const rows = await db().skill.findMany({ where: { vaultId: ctx.vaultId } })

  return rows
    .map((row) => unseal(ctx, row))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function taken(entries: SkillEntry[], name: string, exceptId?: string) {
  return entries.some((entry) => entry.name === name && entry.id !== exceptId)
}

function takenError(name: string): PcpError {
  return new PcpError(
    "conflict",
    `A skill called ${name} exists already. Pick another name.`,
  )
}

async function roomForOneMore(ctx: VaultContext): Promise<void> {
  const count = await db().skill.count({ where: { vaultId: ctx.vaultId } })

  if (count >= MAX_SKILLS) {
    throw new PcpError(
      "conflict",
      `This vault already keeps ${MAX_SKILLS} skills, the most it holds. Delete some first.`,
    )
  }
}

/** The skills a token sees: all of them (null), or the ones it was given. */
export async function skillsFor(
  ctx: VaultContext,
  skillIds: string[] | null,
): Promise<SkillEntry[]> {
  const entries = await load(ctx)

  if (skillIds === null) {
    return entries
  }

  const seen = new Set(skillIds)
  return entries.filter((entry) => seen.has(entry.id))
}

/** A skill's whole SKILL.md text. */
export function skillText(skill: SkillBody): string {
  return serializeSkillMd(skill)
}

/** What the gateway's instructions name of the skills a token sees. */
export type InstructionSkill = {
  name: string
  description: string
  /** The owner's note on it, when they wrote one. */
  note?: string | null
}

export async function instructionSkills(
  ctx: VaultContext,
  skillIds: string[] | null,
): Promise<InstructionSkill[]> {
  return (await skillsFor(ctx, skillIds)).map(
    ({ name, description, note }) => ({ name, description, note }),
  )
}

// ---- The owner's own changes ------------------------------------------------

/** A skill as the owner sees it in PCP. */
export type SkillSummary = SkillEntry & { text: string }

export async function listSkills(ctx: VaultContext): Promise<SkillSummary[]> {
  return (await load(ctx)).map((entry) => ({
    ...entry,
    text: skillText(entry),
  }))
}

export async function getSkill(
  ctx: VaultContext,
  id: string,
): Promise<SkillSummary> {
  const entry = (await load(ctx)).find((item) => item.id === id)

  if (!entry) {
    throw notFound("That skill")
  }

  return { ...entry, text: skillText(entry) }
}

/** A skill the owner writes themselves, at version 1. */
export async function createSkill(
  ctx: VaultContext,
  input: SkillInput,
): Promise<{ id: string; name: string }> {
  const skill = checkSkill(arrived(input))
  const entries = await load(ctx)

  if (taken(entries, skill.name)) {
    throw takenError(skill.name)
  }

  await roomForOneMore(ctx)
  const id = newId()

  await db().skill.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      author: "owner",
      ciphertext: seal(ctx, id, { ...skill, version: 1 }),
    },
  })

  return { id, name: skill.name }
}

/** A SKILL.md the owner pasted: its frontmatter names and describes it. */
export async function importSkill(
  ctx: VaultContext,
  text: string,
): Promise<{ id: string; name: string }> {
  const parsed = parseSkillMd(text)

  return createSkill(ctx, {
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    tools: parsed.tools,
    extra: parsed.extra,
  })
}

async function ownerEntry(ctx: VaultContext, id: string) {
  const entries = await load(ctx)
  const entry = entries.find((item) => item.id === id)

  if (!entry) {
    throw notFound("That skill")
  }

  return { entries, entry }
}

async function write(
  ctx: VaultContext,
  entry: SkillEntry,
  next: Omit<SkillBody, "version">,
  author: SkillAuthor,
): Promise<number> {
  const version = entry.version + 1

  await db().skill.update({
    where: { id: entry.id },
    data: { author, ciphertext: seal(ctx, entry.id, { ...next, version }) },
  })

  return version
}

/**
 * The owner's edit of a skill's name, description, tools and steps; its
 * files, and other tools' frontmatter keys unless given, stay as they are.
 * Every change is a new version.
 */
export async function updateSkill(
  ctx: VaultContext,
  id: string,
  input: Omit<SkillInput, "files">,
): Promise<{ version: number }> {
  const { entries, entry } = await ownerEntry(ctx, id)
  const skill = checkSkill(
    arrived({
      ...input,
      files: entry.files,
      extra: input.extra ?? entry.extra,
    }),
  )

  if (taken(entries, skill.name, id)) {
    throw takenError(skill.name)
  }

  return { version: await write(ctx, entry, skill, "owner") }
}

/**
 * A whole skill the owner approved as it is, files and all, from a linked
 * repository (lib/core/repos/apply.ts): a new one at the version it carries,
 * or onto `id` at that version, or one past the skill's own when that is not
 * higher, so a version never goes back.
 */
export async function saveSkillByOwner(
  ctx: VaultContext,
  id: string | null,
  input: SkillInput & { version: number },
): Promise<{ id: string; name: string; version: number }> {
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw invalid("A skill's version is a whole number, 1 or more.")
  }

  const skill = checkSkill(arrived(input))

  if (id === null) {
    const entries = await load(ctx)

    if (taken(entries, skill.name)) {
      throw takenError(skill.name)
    }

    await roomForOneMore(ctx)
    const newSkillId = newId()

    await db().skill.create({
      data: {
        id: newSkillId,
        vaultId: ctx.vaultId,
        author: "owner",
        ciphertext: seal(ctx, newSkillId, { ...skill, version: input.version }),
      },
    })

    return { id: newSkillId, name: skill.name, version: input.version }
  }

  const { entries, entry } = await ownerEntry(ctx, id)

  if (taken(entries, skill.name, id)) {
    throw takenError(skill.name)
  }

  const content = (value: Omit<SkillBody, "version">) =>
    canonicalJson([
      value.name,
      value.description,
      value.body,
      value.tools,
      value.files.map((file) => [file.path, file.text]),
      value.extra ?? {},
    ])
  const sameText = content(skill) === content(entry)

  // The same skill is left as it is; its version moves only forward.
  if (sameText && input.version <= entry.version) {
    return { id, name: entry.name, version: entry.version }
  }

  const version = sameText
    ? input.version
    : Math.max(input.version, entry.version + 1)

  await db().skill.update({
    where: { id },
    data: {
      author: "owner",
      ciphertext: seal(ctx, id, { ...skill, version }),
    },
  })

  return { id, name: skill.name, version }
}

/**
 * The owner adds a reference file, or changes one (`previousPath` names it
 * when its path changes too).
 */
export async function saveSkillFile(
  ctx: VaultContext,
  id: string,
  input: { path: string; text: string; previousPath?: string | null },
): Promise<{ version: number }> {
  const { entry } = await ownerEntry(ctx, id)
  const replaced = input.previousPath?.trim() || input.path.trim()
  const files = [
    ...entry.files.filter((file) => file.path !== replaced),
    { path: input.path, text: input.text },
  ].sort((a, b) => a.path.localeCompare(b.path))
  const skill = checkSkill(arrived({ ...entry, files }))

  return { version: await write(ctx, entry, skill, "owner") }
}

export async function deleteSkillFile(
  ctx: VaultContext,
  id: string,
  path: string,
): Promise<{ version: number }> {
  const { entry } = await ownerEntry(ctx, id)

  if (!entry.files.some((file) => file.path === path)) {
    throw notFound("That file")
  }

  return {
    version: await write(
      ctx,
      entry,
      { ...entry, files: entry.files.filter((file) => file.path !== path) },
      "owner",
    ),
  }
}

export async function deleteSkill(
  ctx: VaultContext,
  id: string,
): Promise<void> {
  const { count } = await db().skill.deleteMany({
    where: { id, vaultId: ctx.vaultId },
  })

  if (count === 0) {
    throw notFound("That skill")
  }
}

// ---- Which tokens see which skills ----------------------------------------

export type TokenSkills = { all: boolean; skillIds: string[] }

export async function tokenSkills(
  ctx: VaultContext,
  tokenId: string,
): Promise<TokenSkills> {
  const token = await db().apiToken.findFirst({
    where: { id: tokenId, vaultId: ctx.vaultId },
    include: { skills: { select: { skillId: true } } },
  })

  if (!token) {
    throw notFound("That token")
  }

  return {
    all: token.allSkills,
    skillIds: token.skills.map((link) => link.skillId),
  }
}

/**
 * The skills a token sees: every one (including ones added later), or the
 * ones chosen, which may be none.
 */
export async function setTokenSkills(
  ctx: VaultContext,
  tokenId: string,
  input: TokenSkills,
): Promise<void> {
  await requireLiveToken(ctx, tokenId)
  const skillIds = input.all ? [] : [...new Set(input.skillIds)]

  if (skillIds.length > 0) {
    const known = await db().skill.count({
      where: { vaultId: ctx.vaultId, id: { in: skillIds } },
    })

    if (known !== skillIds.length) {
      throw invalid("One of the chosen skills does not exist any more.")
    }
  }

  await db().$transaction([
    db().apiToken.update({
      where: { id: tokenId },
      data: { allSkills: input.all },
    }),
    db().apiTokenSkill.deleteMany({ where: { tokenId } }),
    ...(skillIds.length > 0
      ? [
          db().apiTokenSkill.createMany({
            data: skillIds.map((skillId) => ({ tokenId, skillId })),
          }),
        ]
      : []),
  ])
}

// ---- An assistant's change, through the memory tool ------------------------

/** Who is asking through the gateway, and the skills it sees. */
export type SkillScope = {
  ctx: VaultContext
  tokenId: string
  /** null: every skill. */
  skillIds: string[] | null
}

/**
 * An assistant asking to add, change, rename or delete a skill. `basis` is
 * the version it was shown; `after` is the whole skill as it would be
 * (null: delete it), at the version it would get.
 */
export type SkillChangeAsk = {
  skillId: string | null
  basis: number | null
  before: SkillBody | null
  after: SkillBody | null
}

export type SkillAsk = { kind: "skill_change"; input: SkillChangeAsk }

export type SkillOutcome = { text: string } | { ask: SkillAsk; lead: string }

/** What the owner's page shows of a skill request, in full. */
export type SkillShown = {
  name: string
  /** Set when it gets a new name. */
  newName: string | null
  /** null for a new skill. */
  basis: number | null
  /** The version it becomes; null when it is deleted. */
  version: number | null
  deleting: boolean
  /** The whole SKILL.md: as it would be, or (deleting) as it is. */
  text: string
  /** Against the SKILL.md as it is, when it changes. */
  diff: DiffLine[] | null
  files: Array<{
    path: string
    text: string
    change: "added" | "changed" | "removed" | "same"
    diff: DiffLine[] | null
  }>
}

const SKILL_WARNING =
  "Every assistant that sees this skill will follow it as your procedure when a task matches, more readily than a memory. Agree only to steps you would give them yourself. Watch for places to send things (addresses, links, other servers or tools), steps that skip asking you, and anything private."

const ASKS_FIRST =
  "Nothing is written until the owner answers, and they see the whole skill and what changes."

export function skillPath(name: string, file: string = SKILL_FILE): string {
  return `${SKILL_ROOT}/${name}/${file}`
}

/** What the owner is shown before an assistant's skill request is decided. */
export function describeSkillAsk(ask: SkillAsk): {
  title: string
  lines: string[]
  warning: string
  skill: SkillShown
} {
  const { before, after, basis } = ask.input
  const shown = after ?? before!
  const beforeText = before ? skillText(before) : null
  const afterText = after ? skillText(after) : null
  const files = new Map<string, SkillShown["files"][number]>()

  for (const file of after?.files ?? []) {
    const old = before?.files.find((item) => item.path === file.path)

    files.set(file.path, {
      path: file.path,
      text: file.text,
      change: !old ? "added" : old.text === file.text ? "same" : "changed",
      diff:
        old && old.text !== file.text ? diffLines(old.text, file.text) : null,
    })
  }

  for (const file of before?.files ?? []) {
    if (!files.has(file.path) && after) {
      files.set(file.path, {
        path: file.path,
        text: file.text,
        change: "removed",
        diff: null,
      })
    }

    if (!after) {
      files.set(file.path, {
        path: file.path,
        text: file.text,
        change: "removed",
        diff: null,
      })
    }
  }

  const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
  const changes = (kind: string) =>
    list.filter((file) => file.change === kind).map((file) => file.path)
  const renamed = before && after && before.name !== after.name

  const skill: SkillShown = {
    name: before?.name ?? shown.name,
    newName: renamed ? after.name : null,
    basis,
    version: after ? after.version : null,
    deleting: !after,
    text: afterText ?? beforeText ?? "",
    diff:
      beforeText !== null && afterText !== null && beforeText !== afterText
        ? diffLines(beforeText, afterText)
        : null,
    files: list,
  }

  const fileLines = [
    ...(changes("added").length
      ? [`Files added: ${changes("added").join(", ")}`]
      : []),
    ...(changes("changed").length
      ? [`Files changed: ${changes("changed").join(", ")}`]
      : []),
    ...(changes("removed").length
      ? [`Files removed: ${changes("removed").join(", ")}`]
      : []),
  ]

  if (!before) {
    return {
      title: `Add the skill ${shown.name}?`,
      lines: [
        `Skill: ${skillPath(shown.name)}`,
        `Description: ${shown.description}`,
        ...(shown.tools.length ? [`Tools: ${shown.tools.join(", ")}`] : []),
        ...fileLines,
      ],
      warning: SKILL_WARNING,
      skill,
    }
  }

  if (!after) {
    return {
      title: `Delete the skill ${before.name}?`,
      lines: [
        `Skill: ${skillPath(before.name)} (version ${before.version})`,
        ...(before.files.length
          ? [
              `Its files go with it: ${before.files.map((file) => file.path).join(", ")}`,
            ]
          : []),
      ],
      warning:
        "Every assistant that sees this skill loses it. Nothing else is deleted.",
      skill,
    }
  }

  return {
    title: `Change the skill ${before.name}?`,
    lines: [
      `Skill: ${skillPath(before.name)}`,
      `Version: ${before.version} → ${after.version}`,
      ...(renamed ? [`New name: ${after.name}`] : []),
      ...(skill.diff
        ? [
            `${SKILL_FILE}: ${skill.diff.filter((line) => line.kind === "removed").length} lines out, ${skill.diff.filter((line) => line.kind === "added").length} in`,
          ]
        : [`${SKILL_FILE}: unchanged`]),
      ...fileLines,
    ],
    warning: SKILL_WARNING,
    skill,
  }
}

type SkillPath = { name: string | null; file: string | null }

/** A path as the memory tool takes it: /skills, /skills/<name>[/<file>]. */
function parseSkillPath(input: string): SkillPath {
  const raw = input.trim().replace(/\/+$/, "")

  if (raw !== SKILL_ROOT && !raw.startsWith(`${SKILL_ROOT}/`)) {
    throw invalid(
      `Skill paths start with ${SKILL_ROOT}/, like ${skillPath("release-notes")}.`,
    )
  }

  const rest = raw.slice(SKILL_ROOT.length + 1)

  if (!rest) {
    return { name: null, file: null }
  }

  const slash = rest.indexOf("/")
  const name = checkSkillName(slash < 0 ? rest : rest.slice(0, slash))
  const file = slash < 0 ? null : rest.slice(slash + 1)

  return {
    name,
    file:
      file === null
        ? null
        : file === SKILL_FILE
          ? SKILL_FILE
          : checkSkillFilePath(file),
  }
}

/** Whether a path the memory tool was given is a skill's. */
export function isSkillPath(path: string | undefined): boolean {
  const raw = path?.trim() ?? ""
  return raw === SKILL_ROOT || raw.startsWith(`${SKILL_ROOT}/`)
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw invalid(`This command needs ${name}.`)
  }

  return value
}

function missing(path: string): PcpError {
  return new PcpError(
    "not_found",
    `There is no skill at ${path.trim()} that this token sees. View ${SKILL_ROOT} to list them, or search.`,
  )
}

function numbered(text: string, range?: number[]): string {
  const lines = text.split("\n")
  let from = 1
  let to = lines.length

  if (range) {
    const [start, end] = range

    if (
      range.length !== 2 ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start! < 1 ||
      start! > lines.length ||
      (end !== -1 && (end! < start! || end! > lines.length))
    ) {
      throw invalid(
        `view_range is [first line, last line] between 1 and ${lines.length}, or -1 for the end.`,
      )
    }

    from = start!
    to = end === -1 ? lines.length : end!
  }

  return lines
    .slice(from - 1, to)
    .map((line, index) => `${String(from + index).padStart(6)}\t${line}`)
    .join("\n")
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function aboutSkill(entry: SkillEntry): string {
  return `${skillPath(entry.name)}: version ${entry.version}, ${entry.author === "owner" ? "written by the owner" : "written by an assistant, and the owner agreed to it"}, updated ${day(entry.updatedAt)}. ${SKILL_FRAME}`
}

/** One line per skill, for a listing. */
function skillLine(entry: SkillEntry): string {
  return `- ${skillPath(entry.name)} (version ${entry.version}${entry.files.length ? `, files: ${entry.files.map((file) => file.path).join(", ")}` : ""}): ${entry.description}`
}

/** A skill's SKILL.md, or one of its files, as describe and view give it. */
export function viewSkill(
  entry: SkillEntry,
  file: string | null,
  range?: number[],
): string {
  if (file === null || file === SKILL_FILE) {
    return `${aboutSkill(entry)}\n${numbered(skillText(entry).replace(/\n$/, ""), range)}`
  }

  const found = entry.files.find((item) => item.path === file)

  if (!found) {
    throw missing(skillPath(entry.name, file))
  }

  return `${skillPath(entry.name, file)}: a file of the skill ${entry.name} (version ${entry.version}).\n${numbered(found.text, range)}`
}

function change(
  entry: SkillEntry | null,
  next: Omit<SkillBody, "version">,
  verb: string,
): SkillOutcome {
  const skill = checkSkill(arrived(next))

  if (
    entry &&
    skillText({ ...skill, version: entry.version }) === skillText(entry) &&
    JSON.stringify(skill.files) === JSON.stringify(entry.files)
  ) {
    return { text: "Nothing changed: the skill is the same." }
  }

  const before: SkillBody | null = entry
    ? {
        name: entry.name,
        description: entry.description,
        version: entry.version,
        body: entry.body,
        tools: entry.tools,
        files: entry.files,
        extra: entry.extra ?? {},
      }
    : null

  return {
    ask: {
      kind: "skill_change",
      input: {
        skillId: entry?.id ?? null,
        basis: entry?.version ?? null,
        before,
        after: { ...skill, version: (entry?.version ?? 0) + 1 },
      },
    },
    lead: `${verb} a skill asks the owner. ${ASKS_FIRST}`,
  }
}

function deleteAsk(entry: SkillEntry): SkillOutcome {
  return {
    ask: {
      kind: "skill_change",
      input: {
        skillId: entry.id,
        basis: entry.version,
        before: {
          name: entry.name,
          description: entry.description,
          version: entry.version,
          body: entry.body,
          tools: entry.tools,
          files: entry.files,
          extra: entry.extra ?? {},
        },
        after: null,
      },
    },
    lead: `Deleting a skill asks the owner. ${ASKS_FIRST}`,
  }
}

/** The SKILL.md text an edit made, read back into the skill. */
function fromText(
  entry: SkillEntry | null,
  text: string,
  pathName: string,
): Omit<SkillBody, "version"> {
  const parsed = parseSkillMd(withoutPresentation(text))

  return {
    name: parsed.name.trim() || pathName,
    description: parsed.description,
    body: parsed.body,
    tools: parsed.tools,
    files: entry?.files ?? [],
    extra: parsed.extra,
  }
}

function replaceOnce(text: string, old: string, next: string): string {
  const count = text.split(old).length - 1

  if (count === 0) {
    throw invalid("old_str is not in it. View it and copy the text exactly.")
  }

  if (count > 1) {
    throw invalid(
      `old_str appears ${count} times. Include more of the text around it so it appears once.`,
    )
  }

  return text.replace(old, () => next)
}

function insertAt(text: string, at: number | undefined, insert: string) {
  const lines = text.split("\n")

  if (
    at === undefined ||
    !Number.isInteger(at) ||
    at < 0 ||
    at > lines.length
  ) {
    throw invalid(
      `insert_line is the line to insert after: 0 for the top, up to ${lines.length}.`,
    )
  }

  lines.splice(at, 0, ...insert.split("\n"))
  return lines.join("\n")
}

/** The command arguments the memory tool takes, as skills use them. */
export type SkillCommand = {
  command: string
  path?: string
  view_range?: number[]
  file_text?: string
  old_str?: string
  new_str?: string
  insert_line?: number
  insert_text?: string
  new_path?: string
  query?: string
}

/**
 * One memory tool command on a /skills path. Reads are answered here; every
 * write comes back as an ask for the owner, which the gateway hands to
 * permissions.ts. Only the skills the token sees can be read or changed.
 */
export async function runSkillCommand(
  scope: SkillScope,
  args: SkillCommand,
): Promise<SkillOutcome> {
  const all = await load(scope.ctx)
  const visible =
    scope.skillIds === null
      ? all
      : all.filter((entry) => scope.skillIds!.includes(entry.id))
  const target = parseSkillPath(required(args.path, "path"))
  const entry =
    target.name !== null
      ? (visible.find((item) => item.name === target.name) ?? null)
      : null
  const needEntry = (): SkillEntry => {
    if (!entry) {
      throw missing(args.path!)
    }

    return entry
  }

  switch (args.command) {
    case "view": {
      if (target.name === null) {
        return {
          text: [
            `${SKILL_ROOT}: procedures the owner approved, to follow when a task matches (${visible.length})`,
            ...(visible.length ? visible.map(skillLine) : ["  (none)"]),
          ].join("\n"),
        }
      }

      const found = needEntry()

      return { text: viewSkill(found, target.file, args.view_range) }
    }

    case "search": {
      const terms = required(args.query, "query")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
      const inside = target.name
        ? visible.filter((item) => item === entry)
        : visible
      const hits = inside
        .map((item) => {
          const haystack =
            `${item.name}\n${item.description}\n${item.body}\n${item.files.map((file) => `${file.path}\n${file.text}`).join("\n")}`.toLowerCase()
          return {
            item,
            score: terms.filter((term) => haystack.includes(term)).length,
          }
        })
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)

      return {
        text: hits.length
          ? hits.map(({ item }) => skillLine(item)).join("\n")
          : "No skill mentions that.",
      }
    }

    case "create": {
      if (target.name === null || target.file === null) {
        throw invalid(
          `Name the skill's ${SKILL_FILE} or one of its files, like ${skillPath("release-notes")}.`,
        )
      }

      const text = required(args.file_text, "file_text")

      if (target.file === SKILL_FILE) {
        const next = fromText(entry, text, target.name)

        if (next.name !== target.name) {
          throw invalid(
            `The frontmatter names the skill ${next.name}, but the path names ${target.name}. Make them the same; rename moves a skill.`,
          )
        }

        if (!entry && taken(all, target.name)) {
          throw new PcpError(
            "conflict",
            `A skill called ${target.name} exists already. Pick another name.`,
          )
        }

        if (!entry) {
          await roomForOneMore(scope.ctx)
        }

        return change(entry, next, entry ? "Changing" : "Adding")
      }

      const found = needEntry()

      return change(
        found,
        {
          ...found,
          files: [
            ...found.files.filter((file) => file.path !== target.file),
            { path: target.file, text },
          ].sort((a, b) => a.path.localeCompare(b.path)),
        },
        "Changing",
      )
    }

    case "str_replace":
    case "insert": {
      const found = needEntry()
      const edit = (text: string) =>
        args.command === "str_replace"
          ? replaceOnce(
              text,
              required(args.old_str, "old_str"),
              args.new_str ?? "",
            )
          : insertAt(
              text,
              args.insert_line,
              required(args.insert_text, "insert_text"),
            )

      if (target.file === null || target.file === SKILL_FILE) {
        const next = fromText(found, edit(skillText(found)), found.name)

        if (next.name !== found.name && taken(all, next.name, found.id)) {
          throw new PcpError(
            "conflict",
            `A skill called ${next.name} exists already. Pick another name.`,
          )
        }

        return change(found, next, "Changing")
      }

      const file = found.files.find((item) => item.path === target.file)

      if (!file) {
        throw missing(args.path!)
      }

      return change(
        found,
        {
          ...found,
          files: found.files.map((item) =>
            item === file ? { path: item.path, text: edit(item.text) } : item,
          ),
        },
        "Changing",
      )
    }

    case "delete": {
      if (target.name === null) {
        throw invalid(
          `Name the skill to delete, like ${SKILL_ROOT}/release-notes.`,
        )
      }

      const found = needEntry()

      if (target.file === null || target.file === SKILL_FILE) {
        return deleteAsk(found)
      }

      if (!found.files.some((file) => file.path === target.file)) {
        throw missing(args.path!)
      }

      return change(
        found,
        {
          ...found,
          files: found.files.filter((file) => file.path !== target.file),
        },
        "Changing",
      )
    }

    case "rename": {
      const found = needEntry()
      const to = parseSkillPath(required(args.new_path, "new_path"))

      if (to.name === null) {
        throw invalid(
          `new_path names where it goes, like ${SKILL_ROOT}/new-name.`,
        )
      }

      if (target.file === null || target.file === SKILL_FILE) {
        if (to.file !== null && to.file !== SKILL_FILE) {
          throw invalid(
            `A skill moves to ${SKILL_ROOT}/<new name>; its files go with it.`,
          )
        }

        if (to.name === found.name) {
          return { text: "Nothing changed: that is its name already." }
        }

        if (taken(all, to.name, found.id)) {
          throw new PcpError(
            "conflict",
            `A skill called ${to.name} exists already. Pick another name.`,
          )
        }

        return change(found, { ...found, name: to.name }, "Renaming")
      }

      if (
        to.name !== found.name ||
        to.file === null ||
        to.file === SKILL_FILE
      ) {
        throw invalid(
          `A file moves within its skill: new_path is ${skillPath(found.name, "<new path>")}.`,
        )
      }

      const file = found.files.find((item) => item.path === target.file)

      if (!file) {
        throw missing(args.path!)
      }

      if (found.files.some((item) => item.path === to.file)) {
        throw new PcpError(
          "conflict",
          `${skillPath(found.name, to.file)} is taken. Pick another path.`,
        )
      }

      return change(
        found,
        {
          ...found,
          files: found.files
            .map((item) =>
              item === file ? { path: to.file!, text: item.text } : item,
            )
            .sort((a, b) => a.path.localeCompare(b.path)),
        },
        "Changing",
      )
    }

    default:
      throw invalid(
        `${args.command} does not go with a skill: view, create, str_replace, insert, delete, rename and search do.`,
      )
  }
}

/**
 * The skill a request carries, checked again and refused unless the check
 * leaves it exactly as the owner read it.
 */
function asShown(after: SkillBody): Omit<SkillBody, "version"> {
  const skill = checkSkill(after)
  const canonical = (value: Omit<SkillBody, "version">) =>
    JSON.stringify([
      value.name,
      value.description,
      value.body,
      value.tools,
      value.files.map((file) => [file.path, file.text]),
      canonicalJson(value.extra ?? {}),
    ])

  if (canonical(skill) !== canonical(after)) {
    throw invalid("The skill is not as the owner was shown it; ask again.")
  }

  return skill
}

/**
 * The owner agreed to a skill request (permissions.ts, once the row is
 * claimed). Writes exactly the skill they were shown, onto the version they
 * were shown it against; anything else is refused and nothing is written.
 */
export async function applySkillChange(
  ctx: VaultContext,
  tokenId: string,
  ask: SkillChangeAsk,
): Promise<string> {
  const entries = await load(ctx)
  const stale = new PcpError(
    "conflict",
    "The skill changed since the owner was asked, so nothing was written. Describe it again and ask anew.",
  )

  if (ask.skillId === null) {
    if (!ask.after) {
      throw invalid("There is nothing to add.")
    }

    if (taken(entries, ask.after.name)) {
      throw stale
    }

    const skill = asShown(ask.after)
    await roomForOneMore(ctx)
    const id = newId()
    const token = await db().apiToken.findUnique({
      where: { id: tokenId },
      select: { allSkills: true },
    })

    await db().$transaction([
      db().skill.create({
        data: {
          id,
          vaultId: ctx.vaultId,
          author: "assistant",
          ciphertext: seal(ctx, id, { ...skill, version: ask.after.version }),
        },
      }),
      // A token that sees only some skills sees the one it proposed.
      ...(token && !token.allSkills
        ? [db().apiTokenSkill.create({ data: { tokenId, skillId: id } })]
        : []),
    ])

    return `The owner agreed: the skill ${skill.name} is added, at version ${ask.after.version}. Read it with describe and ref "${SKILL_REF}${skill.name}".`
  }

  const entry = entries.find((item) => item.id === ask.skillId)

  if (!entry || entry.version !== ask.basis) {
    throw stale
  }

  if (!ask.after) {
    await db().skill.delete({ where: { id: entry.id } })
    return `The owner agreed: the skill ${entry.name} is deleted.`
  }

  if (taken(entries, ask.after.name, entry.id)) {
    throw stale
  }

  const skill = asShown(ask.after)

  await db().skill.update({
    where: { id: entry.id },
    data: {
      author: "assistant",
      ciphertext: seal(ctx, entry.id, { ...skill, version: ask.after.version }),
    },
  })

  return `The owner agreed: the skill ${skill.name} is saved as version ${ask.after.version}.`
}
