import { createHash } from "node:crypto"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"

import { linkLastText, nextMessageCheck } from "../owner-link"
import { noteOwnerAsked } from "../request-log"
import {
  NEEDS_OWNER,
  needsOwner,
  ok,
  passOn,
  toolError,
  withLead,
  type Outcome,
} from "../tools/outcome"
import { capabilityPage, type Capability, type CommonItem } from "./list"
import { MAX_READ_PROVIDERS, MAX_TRIED_PROVIDERS, PAGE_DPI } from "./limits"
import {
  countsFromZero,
  OPERATIONS,
  optionPath,
  providerName,
  setAt,
  type FileSlot,
  type OperationId,
  type Provider,
} from "./providers"
import {
  CHECK_NUMBERS,
  compareReadings,
  isHandle,
  READ_FIELDS,
  readText,
  type Handle,
  type Reading,
} from "./readings"

/**
 * Running a capability's providers: each call through `Bridge`, which the
 * gateway gives as the token's own way to its tools (gateway.ts
 * forwardCall: blocked and missing tools refused, the capability tool's
 * tier checked, the arguments checked, asking the owner where the level
 * asks, paced, every call in the request log). What comes back is one of
 * the outcome kinds: the work's answer, a provider's ask passed on, a
 * refusal, or the owner's link to set a provider up.
 */

/** What one call through the bridge came to (permissions.ts CodeCallOutcome). */
export type BridgeOutcome =
  | { ok: true; value: unknown; notes?: string[] }
  | { ok: false; error: string; refused?: boolean; code?: string }
  | { owner: CallToolResult }

export type Bridge = (call: {
  server: string
  tool: string
  args: Record<string, unknown>
  /** Only these parts of a JSON answer (call_tool's fields). */
  fields?: string[]
}) => Promise<BridgeOutcome>

/** A file the call names, as describeResults found it. */
export type InputFile = { id: string; name: string | null; mediaType: string }

/** Where the #92 file step puts files: the provider's own data folder. */
export const PROVIDER_FILES = "/data/pcp"

/**
 * Where a service's file step puts them: this folder in the service's
 * files folder (put_file takes a path relative to it, and answers the full
 * path its tools take).
 */
export const SERVICE_FILES = "pcp"

// ---- Schemas ---------------------------------------------------------------

/** A kept result's handle, as PCP writes one into an answer. */
export const RESULT_HANDLE = z.object({
  $result: z.string().min(1).max(64).describe("The kept result's id."),
  type: z.string().optional().describe("Its media type, as PCP kept it."),
  size: z.number().optional().describe("A file's size in bytes."),
  length: z.number().optional().describe("A text's length in characters."),
  name: z.string().optional().describe("Its file name."),
  preview: z.string().optional().describe("The start of a text."),
  readableUntil: z.string().optional().describe("Until when PCP keeps it."),
})

const TEXT_OR_HANDLE = z.union([z.string(), RESULT_HANDLE]).nullable()

export const READINGS = z.object({
  kind: z.literal("readings"),
  /** Each provider's reading, in the order they ran. */
  readings: z.array(
    z.object({
      provider: z.string(),
      text: TEXT_OR_HANDLE,
      confidence: z.number().nullable(),
    }),
  ),
  /** Whether the readings agree; null with fewer than two to compare. */
  agree: z.boolean().nullable(),
  /** Disagreements and low confidence, each in words. */
  flags: z.array(z.string()),
  failed: z.array(z.object({ provider: z.string(), error: z.string() })),
  skipped: z.array(z.object({ provider: z.string(), reason: z.string() })),
  /** What to check against the picture, said every time. */
  check: z.string(),
})

export const CONVERTED = z.object({
  kind: z.literal("document"),
  provider: z.string(),
  format: z.enum(["markdown", "text"]),
  text: TEXT_OR_HANDLE,
  /** Files the provider wrote, as handles. */
  files: z.array(RESULT_HANDLE),
  failed: z.array(z.object({ provider: z.string(), error: z.string() })),
})

export const EDITED = z.object({
  kind: z.literal("pdf"),
  operation: z.string(),
  provider: z.string(),
  /** The PDF it made, as a handle (none for form_fields). */
  files: z.array(RESULT_HANDLE),
  /** What the provider answered: form_fields' fields, or its summary. */
  answer: z.unknown().optional(),
  failed: z.array(z.object({ provider: z.string(), error: z.string() })),
})

export const READ_IMAGE_OUTPUT = z.discriminatedUnion("kind", [
  NEEDS_OWNER,
  READINGS,
])
/** A page of a PDF made into a picture (convert_document's to "png"). */
export const PAGE_IMAGE = z.object({
  kind: z.literal("page_image"),
  provider: z.string(),
  /** The page, counted from 1. */
  page: z.number(),
  /** The picture, as a handle for view_image. */
  file: RESULT_HANDLE,
  failed: z.array(z.object({ provider: z.string(), error: z.string() })),
})

export const CONVERT_OUTPUT = z.discriminatedUnion("kind", [
  NEEDS_OWNER,
  CONVERTED,
  PAGE_IMAGE,
])
export const EDIT_OUTPUT = z.discriminatedUnion("kind", [NEEDS_OWNER, EDITED])

// ---- Setup -----------------------------------------------------------------

function itemNames(items: CommonItem[]): string {
  const titles = items.map((item) => item.title)

  return titles.length <= 1
    ? (titles[0] ?? "")
    : `${titles.slice(0, -1).join(", ")} or ${titles.at(-1)}`
}

/**
 * No provider: the owner's link to the capability's page, which offers the
 * common items that provide it in one click. Waiting for the owner, so the
 * call's line in the request log says it asked.
 */
export function setupOutcome(
  cap: Capability,
  publicUrl: string,
  why: string,
  /** The common items that would do it, when not all of the capability's. */
  { items = cap.items }: { items?: CommonItem[] } = {},
): Outcome {
  const url = capabilityPage(publicUrl, cap.id)

  noteOwnerAsked()
  return needsOwner(
    {
      kind: "needs_owner",
      reason: "setup",
      url,
      label: cap.label,
      capability: cap.id,
    },
    `Not done yet: ${why} ${
      items.length > 0
        ? `PCP's page at the link below offers ${itemNames(items)} for the owner to launch on one of their SSH servers, in a few clicks. Once it runs, call ${cap.tool} again with the same arguments: it uses what they launched, at the levels they give this token.`
        : `PCP's page at the link below says what the owner can add for it. Once they have, call ${cap.tool} again with the same arguments: it uses what they added, at the levels they give this token.`
    } ${nextMessageCheck(`${cap.tool} again`, "nothing is set up yet")}\n\n${linkLastText(url, cap.label)}`,
  )
}

// ---- One provider ------------------------------------------------------------

type ProviderRun =
  | { ok: true; value: unknown; files: Handle[] }
  | { ok: false; error: string }
  | { owner: CallToolResult }
  | { skipped: string }

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/tiff": "tiff",
  "text/html": "html",
  "text/plain": "txt",
  "text/markdown": "md",
}

/** A file name the provider's folder takes: plain characters, a type's extension. */
export function folderName(file: InputFile, index: number): string {
  const plain = (file.name ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(-80)
  const extension = EXTENSIONS[file.mediaType.toLowerCase()]
  const base = plain || `file-${index + 1}`

  return extension && !base.toLowerCase().endsWith(`.${extension}`)
    ? `${base}.${extension}`
    : base
}

/**
 * A folder of its own for one call's files, the same for the same files
 * and operation: a call the owner allowed once and that is made again
 * names the same paths, so it is the call they allowed.
 */
function folderFor(
  operation: OperationId,
  files: InputFile[],
  base: string,
): string {
  const key = createHash("sha256")
    .update([operation, ...files.map((file) => file.id)].join("\n"))
    .digest("hex")
    .slice(0, 16)

  return `${base}/${key}`
}

/** The path a service's put_file answered, where its tools take the file. */
function placedPath(value: unknown): string | null {
  const path =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).path
      : null

  return typeof path === "string" && path.startsWith("/") ? path : null
}

function handleOf(id: string): Handle {
  return { $result: id }
}

/** The first handle a value holds: itself, or one among its parts. */
function firstHandle(value: unknown, depth = 0): Handle | null {
  if (isHandle(value)) {
    return value
  }

  if (depth > 3 || value === null || typeof value !== "object") {
    return null
  }

  for (const part of Object.values(value as Record<string, unknown>)) {
    const found = firstHandle(part, depth + 1)

    if (found) {
      return found
    }
  }

  return null
}

function errorOf(value: unknown): string | null {
  const said =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).error
      : null

  return typeof said === "string" && said.trim() ? said.trim() : null
}

/**
 * One provider on the files: their handles where it takes handles, or the
 * file step (put_file, the tool on the paths, get_file of what it wrote):
 * on its own server, the file as base64 at a path PCP names in its data
 * folder; on the service that registered it, the file's handle at a path
 * relative to the service's files folder, its tools given the full path
 * put_file answered.
 */
export async function runProvider(
  provider: Provider,
  files: { main: InputFile[]; image?: InputFile },
  options: Record<string, unknown>,
  bridge: Bridge,
): Promise<ProviderRun> {
  if (
    provider.pdfOnly &&
    files.main.some(
      (file) => file.mediaType.toLowerCase() !== "application/pdf",
    )
  ) {
    return { skipped: "it takes PDFs only" }
  }

  const server = provider.tool.server
  const all = [...files.main, ...(files.image ? [files.image] : [])]
  const viaService = provider.step?.kind === "service"
  const folder = folderFor(
    provider.operation,
    all,
    viaService ? SERVICE_FILES : PROVIDER_FILES,
  )
  const args: Record<string, unknown> = {}
  /** Where the provider's tools see `folder`: a service's put_file says. */
  let seenFolder = viaService ? null : folder

  const place = async (
    slot: FileSlot,
    placed: InputFile[],
    offset: number,
  ): Promise<ProviderRun | null> => {
    if (slot.kind !== "path") {
      const handles = placed.map((file) => handleOf(file.id))
      setAt(
        args,
        slot.path,
        slot.kind === "handle" && slot.many ? handles : handles[0],
      )
      return null
    }

    const step = provider.step!
    const paths: string[] = []

    for (const [index, file] of placed.entries()) {
      const name = folderName(file, offset + index)
      const path = `${folder}/${name}`
      const put = await bridge({
        server: step.server,
        tool: step.put,
        args:
          step.kind === "service"
            ? { file: handleOf(file.id), path, overwrite: true }
            : {
                file_path: path,
                content_base64: handleOf(file.id),
                ...(step.overwrite ? { overwrite: true } : {}),
              },
      })

      if ("owner" in put) {
        return put
      }

      if (!put.ok) {
        return { ok: false, error: `${step.server}/${step.put}: ${put.error}` }
      }

      const refused = errorOf(put.value)

      if (refused) {
        return { ok: false, error: `${step.server}/${step.put}: ${refused}` }
      }

      if (step.kind === "service") {
        const answered = placedPath(put.value)

        if (!answered || !answered.endsWith(`/${path}`)) {
          return {
            ok: false,
            error: `${step.server}/${step.put} did not answer where it put the file.`,
          }
        }

        seenFolder ??= answered.slice(0, -(name.length + 1))
        paths.push(answered)
      } else {
        paths.push(path)
      }
    }

    setAt(args, slot.path, slot.many ? paths : paths[0])
    return null
  }

  const stopped =
    (await place(provider.input, files.main, 0)) ??
    (provider.image && files.image
      ? await place(provider.image, [files.image], files.main.length)
      : null)

  if (stopped) {
    return stopped
  }

  const op = OPERATIONS[provider.operation]
  // An output goes with the files the step put (an output is only asked of
  // a provider on paths), in the folder as its tools see it.
  const output =
    provider.output && seenFolder
      ? `${seenFolder}/${provider.operation}.${op.extension ?? (op.output === "file" ? "pdf" : "md")}`
      : null

  if (provider.output && output) {
    setAt(args, provider.output, output)
  }

  for (const [key, option] of Object.entries(op.options)) {
    const value = options[key]
    const path = value === undefined ? null : optionPath(provider, option)

    if (path) {
      setAt(
        args,
        path,
        typeof value === "number" && countsFromZero(provider, option, path)
          ? value - 1
          : value,
      )
    }
  }

  const answer = await bridge({
    server,
    tool: provider.tool.tool,
    args,
    ...(op.output === "value" && provider.operation !== "form_fields"
      ? { fields: READ_FIELDS }
      : {}),
  })

  if ("owner" in answer) {
    return answer
  }

  if (!answer.ok) {
    return { ok: false, error: answer.error }
  }

  const refused = errorOf(answer.value)

  if (refused) {
    return { ok: false, error: refused }
  }

  if (!output) {
    return { ok: true, value: answer.value, files: [] }
  }

  const step = provider.step!
  const got = await bridge({
    server: step.server,
    tool: step.get,
    args: step.kind === "service" ? { path: output } : { file_path: output },
  })

  if ("owner" in got) {
    return got
  }

  if (!got.ok) {
    return { ok: false, error: `${step.server}/${step.get}: ${got.error}` }
  }

  const file = firstHandle(got.value)

  return file
    ? { ok: true, value: answer.value, files: [file] }
    : {
        ok: false,
        error: `${step.server}/${step.get} did not answer with the file it wrote.`,
      }
}

/**
 * A provider asked the owner: its link, passed on, with what to do once
 * they answered. The link stays last.
 */
function ownerFirst(
  cap: Capability,
  provider: Provider,
  owner: CallToolResult,
  done: string[],
): Outcome {
  return withLead(
    [
      `${cap.tool} uses ${providerName(provider)}, which needs the owner first.`,
      ...(done.length > 0 ? [`Done before it: ${done.join("; ")}.`] : []),
      `Once they answered, call ${cap.tool} again with the same arguments: a call they allowed once is not asked again.`,
    ].join(" "),
    passOn(owner),
  )
}

// ---- The capabilities ----------------------------------------------------

/**
 * read_image: every provider the token can call, on one file, each reading
 * kept with its confidence; then whether they agree, and flags for where
 * they do not or a reading was unsure.
 */
export async function readImage(
  cap: Capability,
  providers: Provider[],
  file: InputFile,
  bridge: Bridge,
  publicUrl: string,
): Promise<Outcome> {
  const readings: Reading[] = []
  const failed: Array<{ provider: string; error: string }> = []
  const skipped: Array<{ provider: string; reason: string }> = []

  for (const provider of providers.slice(0, MAX_READ_PROVIDERS)) {
    const name = providerName(provider)
    const run = await runProvider(
      provider,
      { main: [file] },
      {
        force_ocr: true,
        do_ocr: true,
        include_confidence: true,
        image_export_mode: "placeholder",
      },
      bridge,
    )

    if ("owner" in run) {
      return ownerFirst(
        cap,
        provider,
        run.owner,
        readings.map((reading) => `${reading.provider} read it`),
      )
    }

    if ("skipped" in run) {
      skipped.push({ provider: name, reason: run.skipped })
      continue
    }

    if (!run.ok) {
      failed.push({ provider: name, error: run.error })
      continue
    }

    const read = readText(run.value)

    if (read.error) {
      failed.push({ provider: name, error: read.error })
      continue
    }

    readings.push({
      provider: name,
      text: read.text ?? run.files[0] ?? "",
      confidence: read.confidence,
    })
  }

  if (readings.length === 0) {
    if (failed.length === 0) {
      return setupOutcome(
        cap,
        publicUrl,
        `no tool this token can use reads a ${file.mediaType} file (${skipped.map((entry) => `${entry.provider}: ${entry.reason}`).join("; ")}).`,
      )
    }

    return toolError(
      `No provider could read the file: ${failed.map((entry) => `${entry.provider}: ${entry.error}`).join(" | ")}`,
      { code: "upstream" },
    )
  }

  const verdict = compareReadings(readings)

  return ok({
    kind: "readings",
    readings,
    agree: verdict.agree,
    flags: [
      ...verdict.flags,
      ...(readings.length === 1
        ? [
            "Only one provider read it, so there was no second reading to compare with.",
          ]
        : []),
    ],
    failed,
    skipped,
    check: CHECK_NUMBERS,
  })
}

/** Tries providers best first until one does the work. */
async function firstThatWorks(
  cap: Capability,
  providers: Provider[],
  files: { main: InputFile[]; image?: InputFile },
  options: Record<string, unknown>,
  bridge: Bridge,
  publicUrl: string,
  done: (
    provider: Provider,
    value: unknown,
    files: Handle[],
    failed: Array<{ provider: string; error: string }>,
  ) => Outcome | null | Promise<Outcome | null>,
): Promise<Outcome> {
  const failed: Array<{ provider: string; error: string }> = []
  const skipped: string[] = []

  for (const provider of providers.slice(0, MAX_TRIED_PROVIDERS)) {
    const run = await runProvider(provider, files, options, bridge)

    if ("owner" in run) {
      return ownerFirst(cap, provider, run.owner, [])
    }

    if ("skipped" in run) {
      skipped.push(`${providerName(provider)}: ${run.skipped}`)
      continue
    }

    if (!run.ok) {
      failed.push({ provider: providerName(provider), error: run.error })
      continue
    }

    const answer = await done(provider, run.value, run.files, failed)

    if (answer) {
      return answer
    }
  }

  if (failed.length === 0) {
    return setupOutcome(
      cap,
      publicUrl,
      `no tool this token can use takes this file (${skipped.join("; ")}).`,
    )
  }

  return toolError(
    `No provider did it: ${failed.map((entry) => `${entry.provider}: ${entry.error}`).join(" | ")}`,
    { code: "upstream" },
  )
}

/** convert_document: the best provider that turns the file into text. */
export function convertDocument(
  cap: Capability,
  providers: Provider[],
  file: InputFile,
  bridge: Bridge,
  publicUrl: string,
): Promise<Outcome> {
  return firstThatWorks(
    cap,
    providers,
    { main: [file] },
    { to_formats: ["md"], image_export_mode: "placeholder" },
    bridge,
    publicUrl,
    (provider, value, files, failed) => {
      const read = readText(value)

      if (read.error) {
        failed.push({ provider: providerName(provider), error: read.error })
        return null
      }

      if (read.text === null && files.length === 0) {
        failed.push({
          provider: providerName(provider),
          error: "It answered with no text.",
        })
        return null
      }

      return ok({
        kind: "document",
        provider: providerName(provider),
        format: read.format,
        text: read.text,
        files,
        failed,
      })
    },
  )
}

/** The pictures a page may come back as, by their first bytes. */
const PAGE_PICTURES = new Set(["image/png", "image/jpeg", "image/webp"])

/**
 * convert_document's to "png": the best provider that turns a PDF's page
 * into a picture, which comes back as a handle (from the path it wrote, or
 * an image in its answer) for view_image to show. What it made counts only
 * when its first bytes are a PNG, JPEG or WebP (`pictureType` sniffs the
 * token's kept result); anything else is that provider failing.
 */
export function pdfPageImage(
  cap: Capability,
  providers: Provider[],
  file: InputFile,
  page: number,
  bridge: Bridge,
  publicUrl: string,
  pictureType: (handle: Handle) => Promise<string | null>,
): Promise<Outcome> {
  return firstThatWorks(
    cap,
    providers,
    { main: [file] },
    { page, dpi: PAGE_DPI, format: "png" },
    bridge,
    publicUrl,
    async (provider, value, files, failed) => {
      const made = files[0] ?? firstHandle(value)
      const type = made ? await pictureType(made) : null

      if (!made || !type || !PAGE_PICTURES.has(type)) {
        failed.push({
          provider: providerName(provider),
          error: `the renderer answered with no picture${made ? ` (${type ?? "a file PCP does not know"})` : ""}.`,
        })
        return null
      }

      return ok({
        kind: "page_image",
        provider: providerName(provider),
        page,
        file: made,
        failed,
      })
    },
  )
}

export type EditOperation = Extract<
  OperationId,
  "form_fields" | "fill_form" | "flatten" | "merge" | "sign"
>

/** edit_pdf: one operation by the best provider for it. */
export function editPdf(
  cap: Capability,
  operation: EditOperation,
  providers: Provider[],
  files: { main: InputFile[]; image?: InputFile },
  options: Record<string, unknown>,
  bridge: Bridge,
  publicUrl: string,
): Promise<Outcome> {
  return firstThatWorks(
    cap,
    providers,
    files,
    options,
    bridge,
    publicUrl,
    (provider, value, made, failed) =>
      ok({
        kind: "pdf",
        operation,
        provider: providerName(provider),
        files: made,
        ...(value !== undefined && value !== null ? { answer: value } : {}),
        failed,
      }),
  )
}
