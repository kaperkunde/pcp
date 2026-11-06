import { z } from "zod"

import type { CatalogueTool } from "../catalogue"
import { nextMessageCheck, OWNER_LINK_RULE } from "../owner-link"
import type { ToolAnnotations } from "../tools/define"
import {
  defineInnerTool,
  type ArgumentCheck,
  type InnerTool,
} from "../tools/family"
import {
  DEFAULT_LOG_LINES,
  MAX_FILE_NAME_CHARS,
  MAX_LOG_LINES,
  MAX_LOG_SINCE_MINUTES,
  MAX_PATH_CHARS,
} from "./limits"

/**
 * The tools a service's own server offers: its status and logs,
 * starting, stopping and restarting it, at the owner's levels like any
 * tool, and proposing a newer image (`update`), which the owner answers on
 * PCP's page. Each is defined on PCP's one tool interface
 * (lib/core/tools/family.ts), its arguments checked by the one validator
 * before anything connects. None takes an engine command or a variable,
 * and `update`'s digest only proposes: what runs is the owner's. A service
 * whose definition names a files folder (`files`) also offers `put_file`
 * and `get_file`, which copy a kept file into that folder and back out
 * with the engine's own `cp` (engine.ts).
 */

export const SERVICE_TOOL_NAMES = [
  "status",
  "logs",
  "start",
  "stop",
  "restart",
  "update",
  "put_file",
  "get_file",
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

const updateArgs = () =>
  z.strictObject({
    digest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/, {
        message: "A digest is sha256: and 64 hex digits.",
      })
      .optional()
      .describe(
        "The image to update to, by its digest (sha256: and 64 hex digits) in the repository the service runs; left out, the newest of the tag it updates from, as its SSH server finds it now.",
      ),
  })

const filePath = (what: string) =>
  z
    .string()
    .min(1)
    .max(MAX_PATH_CHARS + 1 + MAX_FILE_NAME_CHARS)
    .describe(what)

const putFileArgs = () =>
  z.strictObject({
    file: z
      .strictObject({
        $result: z
          .string()
          .min(1)
          .max(64)
          .describe("A kept result's id, from its handle."),
      })
      .describe(
        'The file to put there: a kept result, as {"$result": "<id>"} (a mail attachment, a file a tool answered with, an upload).',
      ),
    path: filePath(
      'Where it goes, relative to the service\'s files folder ("in/report.pdf"), or the full path inside that folder. Letters, digits, spaces and ._@+,=()- only; folders that are not there are made.',
    ),
    overwrite: z
      .boolean()
      .optional()
      .describe(
        "Replace a file that is there already; default false, which refuses and changes nothing.",
      ),
  })

const getFileArgs = () =>
  z.strictObject({
    path: filePath(
      "The file, relative to the service's files folder (\"out/report.txt\"), or its full path in that folder as the service's own tools name it.",
    ),
  })

type Spec = {
  name: ServiceToolName
  title: string
  description: (where: Where) => string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: () => z.ZodObject<any>
  annotations: ToolAnnotations
}

type Where = {
  service: string
  host: string
  /** The service's files folder in its container, when it has one. */
  files?: string | null
}

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
  {
    name: "update",
    title: "Propose an image update",
    description: ({ service, host }) =>
      `Proposes updating the service ${service} on ${host} to a newer image: the newest of the tag it updates from, or a digest you name in its repository. Nothing changes until the owner agrees on PCP's page, which shows the image it runs and the one it would run: it answers "Not done yet" with a link. ${OWNER_LINK_RULE} ${nextMessageCheck("check_permission with the id it gave")} Not for a service built from a repository, which only the owner updates.`,
    args: updateArgs,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "put_file",
    title: "Put a file in the service",
    description: ({ service, host, files }) =>
      `Puts a kept file (a handle, {"$result": "<id>"}) into the service ${service} on ${host}, in its files folder${files ? ` ${files}` : ""}, and answers the path its own tools take it at. A file already there is replaced only with overwrite: true.`,
    args: putFileArgs,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "get_file",
    title: "Get a file from the service",
    description: ({ service, host, files }) =>
      `Gets one file the service ${service} on ${host} keeps in its files folder${files ? ` ${files}` : ""} (what its own tools wrote there) as a kept result's handle, {"$result": "<id>"}, to pass on whole to another tool. A file larger than PCP keeps is refused.`,
    args: getFileArgs,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
]

/** The tools only a service with a files folder offers. */
export const SERVICE_FILE_TOOLS: readonly string[] = ["put_file", "get_file"]

const TOOLS = new Map<string, InnerTool>(
  SPECS.map((spec) => [
    spec.name,
    defineInnerTool({
      name: spec.name,
      title: spec.title,
      description: spec.description({ service: "this", host: "its server" }),
      input: spec.args(),
      annotations: spec.annotations,
    }),
  ]),
)

/** A service's tool by its name, on PCP's tool interface. */
export function serviceTool(name: string): InnerTool | undefined {
  return TOOLS.get(name)
}

/** The service's tools, for the catalogue: put_file and get_file with a files folder only. */
export function serviceTools(where: Where): CatalogueTool[] {
  return SPECS.filter(
    (spec) => where.files || !SERVICE_FILE_TOOLS.includes(spec.name),
  ).map((spec) => ({
    ...TOOLS.get(spec.name)!.listed(spec.description(where)),
    annotations: { title: spec.title, ...spec.annotations },
  }))
}

export type ServiceCall =
  | { tool: "status" | "start" | "stop" | "restart" }
  | { tool: "logs"; lines: number; sinceMinutes?: number }
  | { tool: "update"; digest?: string }
  | { tool: "put_file"; resultId: string; path: string; overwrite: boolean }
  | { tool: "get_file"; path: string }

/**
 * A call's tool and arguments, checked: what to do, or why not (no such
 * tool, or every problem with the arguments).
 */
export function readServiceCall(
  toolName: string,
  args: unknown,
):
  | { fits: true; call: ServiceCall; notes: string[] }
  | { fits: false; unknown: true }
  | Extract<ArgumentCheck, { fits: false }> {
  const tool = TOOLS.get(toolName)

  if (!tool) {
    return { fits: false, unknown: true }
  }

  const checked = tool.check(args)

  if (!checked.fits) {
    return checked
  }

  if (toolName === "logs") {
    const data = checked.args as { lines?: number; since_minutes?: number }
    return {
      fits: true,
      notes: checked.notes,
      call: {
        tool: "logs",
        lines: data.lines ?? DEFAULT_LOG_LINES,
        ...(data.since_minutes !== undefined
          ? { sinceMinutes: data.since_minutes }
          : {}),
      },
    }
  }

  if (toolName === "update") {
    const data = checked.args as { digest?: string }
    return {
      fits: true,
      notes: checked.notes,
      call: {
        tool: "update",
        ...(data.digest !== undefined ? { digest: data.digest } : {}),
      },
    }
  }

  if (toolName === "put_file") {
    const data = checked.args as {
      file: { $result: string }
      path: string
      overwrite?: boolean
    }
    return {
      fits: true,
      notes: checked.notes,
      call: {
        tool: "put_file",
        resultId: data.file.$result,
        path: data.path,
        overwrite: data.overwrite === true,
      },
    }
  }

  if (toolName === "get_file") {
    const data = checked.args as { path: string }
    return {
      fits: true,
      notes: checked.notes,
      call: { tool: "get_file", path: data.path },
    }
  }

  return {
    fits: true,
    notes: checked.notes,
    call: { tool: toolName as "status" | "start" | "stop" | "restart" },
  }
}
