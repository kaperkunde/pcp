import type { ToolTier } from "../constants"
import { capability, type CapabilityId } from "./list"

/**
 * Which of the token's tools can do a capability's work, and how to call
 * each: found by words, as search would, never by naming a vendor; the
 * common item a server was launched from (list.ts) only ranks it higher.
 * Pure: the gateway hands in the token's tools (blocked ones left out) with
 * their schemas, and calls what this finds through the token's own levels.
 *
 * How a provider takes a file, read off its input schema:
 * - a kept result's handle ({"$result": id}), as an API endpoint's file
 *   field does (a multipart upload's `files`): the handle goes in as it is;
 * - a string of base64 (`content_base64`, `image_base64`): the handle goes
 *   in where the string would, and PCP puts the file there as base64;
 * - a path in the provider's own folder (`pdf_path`, `input_path`), on a
 *   server that keeps files by the #92 convention: put_file(file_path,
 *   content_base64) first, the tool on that path, and get_file(file_path)
 *   for what it wrote (`output_path`), which comes back as a handle.
 */

export type OperationId =
  | "read"
  | "convert"
  | "form_fields"
  | "fill_form"
  | "flatten"
  | "merge"
  | "sign"

/** One of the token's tools, as detection reads it. */
export type CandidateTool = {
  serverId: string
  /** The server's short name: assistants refer to tools as server/tool. */
  server: string
  tool: string
  title?: string | null
  description: string
  access: "allowed" | "ask"
  tier: ToolTier
  /** Its input schema, parsed; anything else counts as none. */
  schema: unknown
}

/** Where a file goes in a provider's call. */
export type FileSlot =
  | { kind: "handle"; path: string[]; many: boolean }
  | { kind: "base64"; path: string[] }
  | { kind: "path"; path: string[]; many: boolean }

/** The file step on a provider's server: put_file and get_file. */
export type FileStep = {
  put: string
  get: string
  /** put_file takes overwrite: a second run replaces what the first put. */
  overwrite: boolean
}

/** A property of a provider's arguments: where it is, and its schema. */
type Prop = { path: string[]; schema: Record<string, unknown> }

export type Provider = {
  operation: OperationId
  tool: CandidateTool
  /** Where the main file goes (several, for merge). */
  input: FileSlot
  /** Where a second file goes: sign's picture of a signature. */
  image: FileSlot | null
  /** It takes PDFs only (its file argument says pdf). */
  pdfOnly: boolean
  /** The argument it writes its result to, in the file step. */
  output: string[] | null
  step: FileStep | null
  /** Its other arguments, by name, for the operation's options. */
  props: Record<string, Prop>
  /** The common item its server was launched from, if any. */
  item: string | null
  score: number
}

type Alternative = {
  /** Every one matches the tool's name and description. */
  text?: RegExp[]
  /** It matches the tool's name. */
  name?: RegExp
  /** It matches the tool's input schema as JSON. */
  schema?: RegExp
}

export type OperationOption = {
  /** The argument's names, the first one present taken. */
  names: string[]
  type: "boolean" | "object" | "array" | "integer" | "string"
  /**
   * The value an enum must hold: an array's items', or a string's own. The
   * option is left out where the enum does not.
   */
  item?: string
}

type Operation = {
  id: OperationId
  capability: CapabilityId
  /** Any one of them makes a tool a candidate. */
  match: Alternative[]
  /** Never these, by name. */
  nameNot?: RegExp
  /** Names that do this, ranked higher. */
  nameBonus?: RegExp
  inputs: "one" | "many" | "pdf+image"
  /** What it answers with: a value, or a file it writes. */
  output: "value" | "file"
  /** Arguments it sets where the tool has them. */
  options: Record<string, OperationOption>
}

const OCR =
  /(^|[^a-z])ocr([^a-z]|$)|optical character|tesseract|text recognition/i

/** Tools that are about a job, not the work: polling, chunks, setup. */
const NOT_THE_WORK =
  /async|status|poll|task|batch|chunk|health|languages?$|backend|llm|template|ai_|auto_/i

export const OPERATIONS: Record<OperationId, Operation> = {
  read: {
    id: "read",
    capability: "read_image",
    match: [
      { text: [OCR] },
      {
        text: [/convert|extract|text|read|recogni/i],
        schema: /"(force_ocr|do_ocr|ocr_engine|ocr_lang)"/,
      },
    ],
    nameNot: NOT_THE_WORK,
    nameBonus: /ocr|text|read|recogni|extract|convert/i,
    inputs: "one",
    output: "value",
    options: {
      force_ocr: { names: ["force_ocr"], type: "boolean" },
      do_ocr: { names: ["do_ocr"], type: "boolean" },
      include_confidence: { names: ["include_confidence"], type: "boolean" },
      image_export_mode: {
        names: ["image_export_mode"],
        type: "string",
        item: "placeholder",
      },
    },
  },
  convert: {
    id: "convert",
    capability: "convert_document",
    match: [
      {
        text: [
          /\bconvert|\bexport|markdown|text extraction|extract.?text|to text/i,
        ],
      },
    ],
    nameNot: NOT_THE_WORK,
    nameBonus: /convert|markdown|text/i,
    inputs: "one",
    output: "value",
    options: {
      to_formats: { names: ["to_formats"], type: "array", item: "md" },
      image_export_mode: {
        names: ["image_export_mode"],
        type: "string",
        item: "placeholder",
      },
    },
  },
  form_fields: {
    id: "form_fields",
    capability: "pdf_edit",
    match: [{ name: /form.?fields?/i }],
    nameNot: /fill|clear|detect|create|set|update|remove|delete|add|template/i,
    inputs: "one",
    output: "value",
    options: {},
  },
  fill_form: {
    id: "fill_form",
    capability: "pdf_edit",
    match: [{ name: /fill/i, text: [/form/i] }],
    nameNot: /any|auto|clear|create|template/i,
    inputs: "one",
    output: "file",
    options: {
      fields: {
        names: ["data", "fields", "values", "field_values", "form_data"],
        type: "object",
      },
      flatten: { names: ["flatten"], type: "boolean" },
    },
  },
  flatten: {
    id: "flatten",
    capability: "pdf_edit",
    match: [{ name: /flatten/i }],
    nameNot: /fill|clear/i,
    inputs: "one",
    output: "file",
    options: {},
  },
  merge: {
    id: "merge",
    capability: "pdf_edit",
    match: [{ name: /merge|combine/i }],
    nameNot: /comment|annotation|cell|field/i,
    inputs: "many",
    output: "file",
    options: {},
  },
  sign: {
    id: "sign",
    capability: "pdf_edit",
    match: [{ name: /signature/i, text: [/image|picture/i] }],
    nameNot: /update|remove|verify|detect|digital/i,
    inputs: "pdf+image",
    output: "file",
    options: {
      page: { names: ["page"], type: "integer" },
      rect: { names: ["rect", "box"], type: "array" },
    },
  },
}

/** The operations that make up a capability. */
export function operationsOf(id: CapabilityId): OperationId[] {
  return (Object.keys(OPERATIONS) as OperationId[]).filter(
    (op) => OPERATIONS[op].capability === id,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function typesOf(schema: Record<string, unknown>): string[] {
  const type = schema.type

  if (typeof type === "string") {
    return [type]
  }

  if (Array.isArray(type)) {
    return type.filter((entry): entry is string => typeof entry === "string")
  }

  // anyOf [{type: X}, {type: "null"}], as pydantic writes an Optional.
  const any = Array.isArray(schema.anyOf) ? schema.anyOf : []
  return any.flatMap((entry) => (isRecord(entry) ? typesOf(entry) : []))
}

function itemsOf(schema: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(schema.items)) {
    return schema.items
  }

  const any = Array.isArray(schema.anyOf) ? schema.anyOf : []
  const array = any.find((entry) => isRecord(entry) && isRecord(entry.items))

  return isRecord(array) && isRecord(array.items) ? array.items : {}
}

/** A schema's enum, or the first enum among its anyOf. */
function enumOf(schema: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(schema.enum)) {
    return schema.enum
  }

  const any = Array.isArray(schema.anyOf) ? schema.anyOf : []

  for (const entry of any) {
    if (isRecord(entry) && Array.isArray(entry.enum)) {
      return entry.enum
    }
  }

  return null
}

function isHandleSchema(schema: unknown): boolean {
  return (
    isRecord(schema) &&
    isRecord(schema.properties) &&
    isRecord(schema.properties.$result)
  )
}

/**
 * A tool's properties, at the top and one object down (an API's `body`),
 * by name; a name at the top wins. Also which of them are required.
 */
function propsOf(schema: unknown): {
  props: Record<string, Prop>
  required: string[][]
} {
  const props: Record<string, Prop> = {}
  const required: string[][] = []

  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return { props, required }
  }

  const top = schema.properties
  const topRequired = Array.isArray(schema.required) ? schema.required : []

  for (const [name, value] of Object.entries(top)) {
    if (!isRecord(value)) {
      continue
    }

    props[name] = { path: [name], schema: value }

    if (topRequired.includes(name)) {
      required.push([name])
    }

    if (isRecord(value.properties) && !isHandleSchema(value)) {
      const inner = Array.isArray(value.required) ? value.required : []

      for (const [key, nested] of Object.entries(value.properties)) {
        if (isRecord(nested) && !Object.hasOwn(props, key)) {
          props[key] = { path: [name, key], schema: nested }
        }

        if (inner.includes(key) && topRequired.includes(name)) {
          required.push([name, key])
        }
      }
    }
  }

  // Names at the top come first, whatever order they were read in.
  for (const [name, value] of Object.entries(top)) {
    if (isRecord(value)) {
      props[name] = { path: [name], schema: value }
    }
  }

  return { props, required }
}

const OUTPUT_NAME =
  /^(out|output|dest|destination|target|save)(_(path|file))?$/i
const PATH_NAME = /(^|_)(path|file)$/i
const PATHS_NAME = /(_paths|_list|_files)$/i
const IMAGE_NAME = /image|signature|picture/i
const BASE64 = /base64|b64/i

type Slots = {
  handles: Array<{ name: string; slot: FileSlot }>
  base64: Array<{ name: string; slot: FileSlot }>
  paths: Array<{ name: string; slot: FileSlot }>
  output: string[] | null
}

function slotsOf(props: Record<string, Prop>): Slots {
  const slots: Slots = { handles: [], base64: [], paths: [], output: null }

  for (const [name, { path, schema }] of Object.entries(props)) {
    const types = typesOf(schema)

    if (isHandleSchema(schema)) {
      slots.handles.push({ name, slot: { kind: "handle", path, many: false } })
      continue
    }

    if (types.includes("array") && isHandleSchema(itemsOf(schema))) {
      slots.handles.push({ name, slot: { kind: "handle", path, many: true } })
      continue
    }

    if (types.includes("string") && OUTPUT_NAME.test(name)) {
      slots.output ??= path
      continue
    }

    const description =
      typeof schema.description === "string" ? schema.description : ""

    if (
      types.includes("string") &&
      (BASE64.test(name) ||
        (/^(content|data|image|file)$/.test(name) && BASE64.test(description)))
    ) {
      slots.base64.push({ name, slot: { kind: "base64", path } })
      continue
    }

    if (
      types.includes("string") &&
      PATH_NAME.test(name) &&
      !/dir/i.test(name)
    ) {
      slots.paths.push({ name, slot: { kind: "path", path, many: false } })
      continue
    }

    if (
      types.includes("array") &&
      (PATHS_NAME.test(name) || name === "pdf_list") &&
      typesOf(itemsOf(schema)).includes("string")
    ) {
      slots.paths.push({ name, slot: { kind: "path", path, many: true } })
    }
  }

  return slots
}

/** The file step a server offers, when its tools follow the convention. */
export function fileStepOf(tools: CandidateTool[]): FileStep | null {
  const put = tools.find((tool) => tool.tool === "put_file")
  const get = tools.find((tool) => tool.tool === "get_file")

  if (!put || !get) {
    return null
  }

  const putProps = propsOf(put.schema).props
  const getProps = propsOf(get.schema).props

  if (!putProps.file_path || !putProps.content_base64 || !getProps.file_path) {
    return null
  }

  return { put: put.tool, get: get.tool, overwrite: !!putProps.overwrite }
}

function textOf(tool: CandidateTool): string {
  return [tool.tool.replace(/_/g, " "), tool.title ?? "", tool.description]
    .join(" ")
    .trim()
}

/** How well a tool matches an operation: null when it does not. */
function matchOf(
  op: Operation,
  tool: CandidateTool,
): { words: boolean } | null {
  if (op.nameNot?.test(tool.tool)) {
    return null
  }

  const text = textOf(tool)
  let schemaJson: string | null = null
  let words = false
  let found = false

  for (const alternative of op.match) {
    if (alternative.name && !alternative.name.test(tool.tool)) {
      continue
    }

    if (
      alternative.text &&
      !alternative.text.every((word) => word.test(text))
    ) {
      continue
    }

    if (alternative.schema) {
      schemaJson ??= JSON.stringify(tool.schema ?? {})

      if (!alternative.schema.test(schemaJson)) {
        continue
      }
    } else {
      words = true
    }

    found = true
  }

  return found ? { words } : null
}

/** Where the operation's files go in this tool, or null when they cannot. */
function inputsOf(
  op: Operation,
  slots: Slots,
  step: FileStep | null,
): { input: FileSlot; image: FileSlot | null; pdfOnly: boolean } | null {
  const usablePaths = step ? slots.paths : []
  // One file goes where one goes, or as a list of one where only a list
  // does (an upload's `files`); several go only where a list does.
  const pick = (many: boolean, image: boolean) => {
    const fits =
      (manyWanted: boolean) => (entry: { name: string; slot: FileSlot }) =>
        (entry.slot.kind === "base64"
          ? !manyWanted
          : entry.slot.many === manyWanted) &&
        IMAGE_NAME.test(entry.name) === image
    const find = (manyWanted: boolean) =>
      slots.handles.find(fits(manyWanted)) ??
      slots.base64.find(fits(manyWanted)) ??
      usablePaths.find(fits(manyWanted)) ??
      null

    return many ? find(true) : (find(false) ?? find(true))
  }
  const main =
    op.inputs === "many"
      ? pick(true, false)
      : (pick(false, false) ?? (op.inputs === "one" ? pick(false, true) : null))

  if (!main) {
    return null
  }

  const image = op.inputs === "pdf+image" ? pick(false, true) : null

  if (op.inputs === "pdf+image" && !image) {
    return null
  }

  return {
    input: main.slot,
    image: image?.slot ?? null,
    pdfOnly: /pdf/i.test(main.name),
  }
}

/** A required path is filled when it, or a part of it, or a part in it is. */
function covers(path: string[], filled: string[][]): boolean {
  const prefix = (short: string[], long: string[]) =>
    short.length <= long.length &&
    short.every((part, index) => part === long[index])

  return filled.some((entry) => prefix(entry, path) || prefix(path, entry))
}

/**
 * The providers of one operation among the token's tools, best first: one
 * per server (its best tool), each with how to call it. `items` names the
 * common item each server was launched from, where it was.
 */
export function findProviders(
  operation: OperationId,
  tools: CandidateTool[],
  items: ReadonlyMap<string, string> = new Map(),
): Provider[] {
  const op = OPERATIONS[operation]
  const itemNames = new Set(
    capability(op.capability).items.map((item) => item.name),
  )
  const byServer = new Map<string, CandidateTool[]>()

  for (const tool of tools) {
    byServer.set(tool.serverId, [...(byServer.get(tool.serverId) ?? []), tool])
  }

  const best = new Map<string, Provider>()

  for (const [serverId, own] of byServer) {
    const step = fileStepOf(own)

    for (const tool of own) {
      if (step && (tool.tool === step.put || tool.tool === step.get)) {
        continue
      }

      const matched = matchOf(op, tool)

      if (!matched) {
        continue
      }

      const { props, required } = propsOf(tool.schema)
      const slots = slotsOf(props)
      const files = inputsOf(op, slots, step)

      if (!files) {
        continue
      }

      const output = files.input.kind === "path" ? slots.output : null

      if (op.output === "file" && !output) {
        // An edit whose result PCP cannot fetch is no use here.
        continue
      }

      const filled: string[][] = [
        files.input.path,
        ...(files.image ? [files.image.path] : []),
        ...(output ? [output] : []),
        ...Object.values(op.options).flatMap((option) => {
          const name = option.names.find((each) => props[each])
          return name ? [props[name]!.path] : []
        }),
      ]

      // A required argument the operation knows nothing to give.
      if (required.some((path) => !covers(path, filled))) {
        continue
      }

      const item = items.get(serverId) ?? null
      const score =
        (op.nameBonus?.test(tool.tool) ? 3 : 0) +
        (matched.words ? 2 : 0) +
        (item && itemNames.has(item) ? 2 : 0) +
        (tool.access === "allowed" ? 1 : 0) +
        (files.input.kind === "path" ? 0 : 1) +
        (op.output === "value" && output ? -3 : 0)
      const found: Provider = {
        operation,
        tool,
        input: files.input,
        image: files.image,
        pdfOnly: files.pdfOnly,
        output,
        step: files.input.kind === "path" ? step : null,
        props,
        item,
        score,
      }
      const kept = best.get(serverId)

      if (!kept || score > kept.score) {
        best.set(serverId, found)
      }
    }
  }

  return [...best.values()].sort(
    (a, b) =>
      b.score - a.score ||
      `${a.tool.server}/${a.tool.tool}`.localeCompare(
        `${b.tool.server}/${b.tool.tool}`,
      ),
  )
}

/** Every provider of a capability, by operation. */
export function providersOf(
  id: CapabilityId,
  tools: CandidateTool[],
  items: ReadonlyMap<string, string> = new Map(),
): Partial<Record<OperationId, Provider[]>> {
  return Object.fromEntries(
    operationsOf(id).map((op) => [op, findProviders(op, tools, items)]),
  )
}

/** Whether a capability has a provider for any of its operations. */
export function hasProvider(
  id: CapabilityId,
  tools: CandidateTool[],
  items: ReadonlyMap<string, string> = new Map(),
): boolean {
  return Object.values(providersOf(id, tools, items)).some(
    (found) => (found?.length ?? 0) > 0,
  )
}

/** Sets a value at a path of a call's arguments, making objects on the way. */
export function setAt(
  args: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let at = args

  for (const part of path.slice(0, -1)) {
    const next = at[part]

    if (!isRecord(next)) {
      at[part] = {}
    }

    at = at[part] as Record<string, unknown>
  }

  at[path.at(-1)!] = value
}

/**
 * Where an operation's option goes in this provider's arguments, when the
 * provider has it and of the type the option is: its path, or null.
 */
export function optionPath(
  provider: Provider,
  option: OperationOption,
): string[] | null {
  for (const name of option.names) {
    const prop = provider.props[name]

    if (!prop) {
      continue
    }

    const types = typesOf(prop.schema)
    const fits =
      types.length === 0 ||
      types.includes(option.type) ||
      (option.type === "integer" && types.includes("number"))

    if (!fits) {
      continue
    }

    if (option.item !== undefined) {
      const allowed = enumOf(
        option.type === "array" ? itemsOf(prop.schema) : prop.schema,
      )

      if (allowed && !allowed.includes(option.item)) {
        continue
      }
    }

    return prop.path
  }

  return null
}

/** The name assistants know a provider by: server/tool. */
export function providerName(provider: Provider): string {
  return `${provider.tool.server}/${provider.tool.tool}`
}
