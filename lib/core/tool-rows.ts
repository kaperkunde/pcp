import type { McpTool, Prisma } from "@/lib/generated/prisma/client"

import type { VaultContext } from "./context"
import { db } from "./db"
import {
  groupSelect,
  type Opened,
  openRow,
  type PlainKey,
  readFields,
  sealFields,
  type SealedGroup,
} from "./sealed-fields"

/**
 * A tool's words and shapes, sealed (#96): what it is called for people
 * and what it is for (`about`, which search and the catalogue read on
 * every request), its schemas, call plan and the outline of its answer
 * (`schema`, read when it is described or called), and the owner's own
 * wording (`override`), each JSON under the vault's key as
 * "mcp_tool:<id>:<column>". The tool's name and its annotations stay plain.
 *
 * A row from before holds them in its plain columns (plainTitle,
 * plainInputSchema, …) and nothing sealed, until the vault's rows are
 * converted (lib/core/sealing/convert.ts); every reader opens a row with
 * openTool, which takes either form.
 */

export type ToolAbout = { title: string | null; description: string }

export type ToolSchema = {
  inputSchema: string
  outputSchema: string | null
  operation: string | null
  output: string | null
}

export type ToolOverride = { descriptionOverride: string | null }

export const TOOL_ABOUT: SealedGroup<ToolAbout, "about"> = {
  column: "about",
  idKey: "id",
  aad: (id) => `mcp_tool:${id}:about`,
  blank: { title: null, description: "" },
}

export const TOOL_SCHEMA: SealedGroup<ToolSchema, "schema"> = {
  column: "schema",
  idKey: "id",
  aad: (id) => `mcp_tool:${id}:schema`,
  blank: { inputSchema: "", outputSchema: null, operation: null, output: null },
}

export const TOOL_OVERRIDE: SealedGroup<ToolOverride, "override"> = {
  column: "override",
  idKey: "id",
  aad: (id) => `mcp_tool:${id}:override`,
  blank: { descriptionOverride: null },
}

/** The columns a reader selects for a tool's title and description. */
export const TOOL_ABOUT_SELECT = groupSelect(TOOL_ABOUT)
/** … for its schemas, call plan and outline. */
export const TOOL_SCHEMA_SELECT = groupSelect(TOOL_SCHEMA)
/** … for the owner's wording. */
export const TOOL_OVERRIDE_SELECT = groupSelect(TOOL_OVERRIDE)

type Sealed = "about" | "schema" | "override"

type ToolValues = ToolAbout & ToolSchema & ToolOverride

/** A row (whole or selected) with whichever of its values it selected opened. */
export type OpenedTool<T> = Opened<
  Opened<Opened<T, ToolAbout, "about">, ToolSchema, "schema">,
  ToolOverride,
  "override"
>

/** A whole tool row, its values opened under their own names. */
export type OpenTool = OpenedTool<McpTool>

export function openTool<T extends { id: string }>(
  ctx: VaultContext,
  row: T,
): OpenedTool<T> {
  return openRow(
    ctx.dek,
    TOOL_OVERRIDE,
    openRow(ctx.dek, TOOL_SCHEMA, openRow(ctx.dek, TOOL_ABOUT, row)),
  )
}

export function openTools<T extends { id: string }>(
  ctx: VaultContext,
  rows: T[],
): Array<OpenedTool<T>> {
  return rows.map((row) => openTool(ctx, row))
}

/** What a tool row stores for its title, description and schemas. */
export function sealedToolContent(
  ctx: VaultContext,
  id: string,
  values: ToolAbout & ToolSchema,
): Pick<
  Prisma.McpToolUncheckedCreateInput,
  "about" | "schema" | PlainKey<keyof ToolAbout | keyof ToolSchema>
> {
  return {
    ...(sealFields(ctx.dek, TOOL_ABOUT, id, {
      title: values.title,
      description: values.description,
    }) as object),
    ...(sealFields(ctx.dek, TOOL_SCHEMA, id, {
      inputSchema: values.inputSchema,
      outputSchema: values.outputSchema,
      operation: values.operation,
      output: values.output,
    }) as object),
  } as Pick<
    Prisma.McpToolUncheckedCreateInput,
    "about" | "schema" | PlainKey<keyof ToolAbout | keyof ToolSchema>
  >
}

/** What a tool row stores for the owner's wording. */
export function sealedToolOverride(
  ctx: VaultContext,
  id: string,
  descriptionOverride: string | null,
): { override: Uint8Array<ArrayBuffer>; plainDescriptionOverride: null } {
  return sealFields(ctx.dek, TOOL_OVERRIDE, id, {
    descriptionOverride,
  }) as { override: Uint8Array<ArrayBuffer>; plainDescriptionOverride: null }
}

/** The owner's wording, from a row that selected TOOL_OVERRIDE_SELECT. */
export function toolOverride(
  ctx: VaultContext,
  row: Parameters<typeof readFields<ToolOverride, "override", "id">>[2],
): string | null {
  return readFields(ctx.dek, TOOL_OVERRIDE, row).descriptionOverride
}

/** A row from before's plain values, as the conversion reads them. */
export function plainToolValues(
  row: Pick<
    McpTool,
    | "plainTitle"
    | "plainDescription"
    | "plainDescriptionOverride"
    | "plainInputSchema"
    | "plainOperation"
    | "plainOutput"
    | "plainOutputSchema"
  >,
): ToolValues {
  return {
    title: row.plainTitle,
    description: row.plainDescription,
    descriptionOverride: row.plainDescriptionOverride,
    inputSchema: row.plainInputSchema,
    outputSchema: row.plainOutputSchema,
    operation: row.plainOperation,
    output: row.plainOutput,
  }
}

export type { Sealed as SealedToolColumn }

/**
 * The tools that carry the owner's wording, among those `where` finds, by
 * name: what definitions and linked repositories share. Sealed, so read
 * and kept here rather than filtered by the query.
 */
export async function toolOverrides(
  ctx: VaultContext,
  where: Prisma.McpToolWhereInput,
): Promise<
  Array<{ serverId: string; name: string; descriptionOverride: string }>
> {
  const rows = await db().mcpTool.findMany({
    where: {
      ...where,
      OR: [
        { override: { not: null } },
        { plainDescriptionOverride: { not: null } },
      ],
    },
    select: { ...TOOL_OVERRIDE_SELECT, serverId: true, name: true },
    orderBy: { name: "asc" },
  })

  return rows.flatMap((row) => {
    const descriptionOverride = toolOverride(ctx, row)
    return descriptionOverride === null
      ? []
      : [{ serverId: row.serverId, name: row.name, descriptionOverride }]
  })
}

/** Writes the owner's wording onto the tools `where` finds, each under its id. */
export async function writeToolOverride(
  ctx: VaultContext,
  where: Prisma.McpToolWhereInput,
  descriptionOverride: string | null,
): Promise<void> {
  const rows = await db().mcpTool.findMany({ where, select: { id: true } })

  for (const { id } of rows) {
    await db().mcpTool.update({
      where: { id },
      data: sealedToolOverride(ctx, id, descriptionOverride),
    })
  }
}

/** Each tool's input schema (JSON text), by tool id. */
export async function inputSchemasOf(
  ctx: VaultContext,
  ids: string[],
): Promise<Map<string, string>> {
  const rows = await db().mcpTool.findMany({
    where: { id: { in: ids } },
    select: TOOL_SCHEMA_SELECT,
  })

  return new Map(
    rows.map((row) => [
      row.id,
      readFields(ctx.dek, TOOL_SCHEMA, row).inputSchema,
    ]),
  )
}
