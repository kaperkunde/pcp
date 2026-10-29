import { z } from "zod"

import type { CatalogueTool } from "../catalogue"
import { invalid } from "../errors"
import {
  DEFAULT_LOG_LINES,
  MAX_LOG_LINES,
  MAX_LOG_SINCE_MINUTES,
} from "./limits"

/**
 * The tools a service's own server offers: its status and logs, and
 * starting, stopping and restarting it, at the owner's levels like any
 * tool. Their arguments are checked here, before anything connects. None
 * takes an engine command, an image or a variable: what runs is the
 * owner's, on the service's page.
 */

export const SERVICE_TOOL_NAMES = [
  "status",
  "logs",
  "start",
  "stop",
  "restart",
] as const
export type ServiceToolName = (typeof SERVICE_TOOL_NAMES)[number]

const noArgs = () => z.strictObject({})

const logsArgs = () =>
  z.strictObject({
    lines: z
      .number()
      .int()
      .min(1)
      .max(MAX_LOG_LINES)
      .optional()
      .describe(
        `How many of the last lines to read, standard output and error together; default ${DEFAULT_LOG_LINES}, at most ${MAX_LOG_LINES}.`,
      ),
    since_minutes: z
      .number()
      .int()
      .min(1)
      .max(MAX_LOG_SINCE_MINUTES)
      .optional()
      .describe(
        "Only lines from the last this many minutes; left out, however old they are.",
      ),
  })

type Spec = {
  name: ServiceToolName
  title: string
  description: (where: Where) => string
  args: () => z.ZodType
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
}

type Where = { service: string; host: string }

const SPECS: Spec[] = [
  {
    name: "status",
    title: "Service status",
    description: ({ service, host }) =>
      `Whether the service ${service} is running on ${host}: its state, health, the image it runs and since when, and the server it serves (the API endpoint or MCP server to call for its own tools).`,
    args: noArgs,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "logs",
    title: "Service logs",
    description: ({ service, host }) =>
      `The last lines the service ${service} wrote on ${host}, with their times. Secrets it was given are shown as [redacted].`,
    args: logsArgs,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "start",
    title: "Start the service",
    description: ({ service, host }) =>
      `Starts the service ${service} on ${host} when it is stopped, and waits for it to be healthy. Nothing changes when it is running.`,
    args: noArgs,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "stop",
    title: "Stop the service",
    description: ({ service, host }) =>
      `Stops the service ${service} on ${host}. Its data stays; the tools it serves answer that it is stopped until it is started again.`,
    args: noArgs,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "restart",
    title: "Restart the service",
    description: ({ service, host }) =>
      `Restarts the service ${service} on ${host}, and waits for it to be healthy: for one that stopped answering. Its data stays.`,
    args: noArgs,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
]

const BY_NAME = new Map(SPECS.map((spec) => [spec.name, spec]))

function jsonSchema(schema: z.ZodType): unknown {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>
  delete generated.$schema
  return generated
}

/** The service's tools, for the catalogue. */
export function serviceTools(where: Where): CatalogueTool[] {
  return SPECS.map((spec) => ({
    name: spec.name,
    title: spec.title,
    description: spec.description(where),
    inputSchema: jsonSchema(spec.args()),
    annotations: { title: spec.title, ...spec.annotations },
  }))
}

export type ServiceCall =
  | { tool: "status" | "start" | "stop" | "restart" }
  | { tool: "logs"; lines: number; sinceMinutes?: number }

/** A call's tool and arguments, checked; a readable refusal otherwise. */
export function parseServiceCall(toolName: string, args: unknown): ServiceCall {
  const spec = BY_NAME.get(toolName as ServiceToolName)

  if (!spec) {
    throw invalid(
      `A service has no tool called ${toolName}; it has ${SERVICE_TOOL_NAMES.join(", ")}.`,
    )
  }

  const parsed = spec.args().safeParse(args ?? {})

  if (!parsed.success) {
    throw invalid(
      `${spec.name}: ${z
        .prettifyError(parsed.error)
        .replace(/\s*\n\s*/g, " ")
        .slice(0, 500)}`,
    )
  }

  if (spec.name === "logs") {
    const data = parsed.data as { lines?: number; since_minutes?: number }
    return {
      tool: "logs",
      lines: data.lines ?? DEFAULT_LOG_LINES,
      ...(data.since_minutes !== undefined
        ? { sinceMinutes: data.since_minutes }
        : {}),
    }
  }

  return { tool: spec.name as "status" | "start" | "stop" | "restart" }
}
