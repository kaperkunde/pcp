import { z } from "zod"

import type { CatalogueTool } from "../catalogue"
import {
  defineInnerTool,
  notTogether,
  type ArgumentCheck,
} from "../tools/family"
import {
  MAX_COMMAND_CHARS,
  MAX_STDIN_BYTES,
  SSH_DEFAULT_COMMAND_TIMEOUT_MS,
  SSH_MAX_COMMAND_TIMEOUT_MS,
} from "./limits"

/**
 * The tool an SSH server offers: one command per call, run with `exec` (no
 * shell is started for it beyond the login shell's `-c`, no terminal). It
 * is defined on PCP's one tool interface (lib/core/tools/family.ts), its
 * arguments checked by the one validator before anything connects.
 */

export const RUN_COMMAND = "run_command"

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const runCommand = defineInnerTool({
  name: RUN_COMMAND,
  title: "Run a command",
  // The server's own words replace this in the catalogue (sshTools).
  description: "Runs one command over SSH.",
  input: z.strictObject({
    command: z
      .string()
      .min(1)
      .max(MAX_COMMAND_CHARS)
      // A NUL would end the command early on the server.
      .regex(/^[^\u0000]*$/, {
        message: "The command cannot contain a NUL character.",
      })
      .refine((value) => value.trim() !== "", {
        message: "Give the command to run.",
      })
      .describe(
        "The command line, as you would type it after ssh host, without a NUL character.",
      ),
    stdin: z
      .string()
      .optional()
      .describe(
        "Text for the command's standard input (a kept result's handle works here too).",
      ),
    stdin_base64: z
      .string()
      .regex(BASE64)
      .optional()
      .describe(
        'Bytes for standard input, as base64, instead of stdin: a kept file\'s handle with "as": "base64".',
      ),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(SSH_MAX_COMMAND_TIMEOUT_MS / 1000)
      .optional()
      .describe(
        `How long the command may run, in seconds; default ${SSH_DEFAULT_COMMAND_TIMEOUT_MS / 1000}.`,
      ),
  }),
  rules: [
    notTogether(
      ["stdin", "stdin_base64"],
      "Give stdin or stdin_base64, not both.",
    ),
  ],
  output: z.object({
    exit_code: z
      .number()
      .int()
      .nullable()
      .describe("How the command exited; null when it was ended by a signal."),
    signal: z.string().optional().describe("The signal that ended it."),
    stdout: z.string().describe("What it wrote to standard output."),
    stderr: z.string().describe("What it wrote to standard error."),
    truncated: z
      .string()
      .optional()
      .describe("Set when it wrote more than PCP keeps, and says so."),
    timed_out: z
      .string()
      .optional()
      .describe("Set when it ran past its timeout, and says so."),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
})

/** run_command on PCP's tool interface. */
export function runCommandTool() {
  return runCommand
}

export function sshTools({
  host,
  username,
}: {
  host: string
  username: string
}): CatalogueTool[] {
  return [
    runCommand.listed(
      `Runs one command on ${host} as ${username} over SSH and returns its exit code, standard output and standard error. The command is run by ${username}'s login shell, without a terminal; each call is a new connection, so nothing (working directory, variables) carries over between calls. Standard input is empty unless stdin or stdin_base64 is given. For a command that writes more than 1 MB or runs past its timeout, PCP asks the server to end it (TERM; OpenSSH does this for every login but root), disconnects and returns what it wrote so far.`,
    ),
  ]
}

export type RunCommandArgs = {
  command: string
  stdin: Buffer | undefined
  timeoutMs: number
}

/**
 * run_command's arguments, checked: what to run, or every problem. The
 * schema first, then what it cannot say (how large standard input is).
 */
export function readRunCommand(
  args: Record<string, unknown>,
):
  | { fits: true; call: RunCommandArgs; notes: string[] }
  | Extract<ArgumentCheck, { fits: false }> {
  const checked = runCommand.check(args)

  if (!checked.fits) {
    return checked
  }

  const { command, stdin, stdin_base64: stdinBase64 } = checked.args
  const input =
    stdin !== undefined
      ? Buffer.from(stdin, "utf8")
      : stdinBase64 !== undefined
        ? Buffer.from(stdinBase64, "base64")
        : undefined

  if (input && input.length > MAX_STDIN_BYTES) {
    return {
      fits: false,
      problems: [
        `Standard input can be at most ${MAX_STDIN_BYTES / 1024 / 1024} MB.`,
      ],
      notes: checked.notes,
      renames: checked.renames,
    }
  }

  return {
    fits: true,
    call: {
      command,
      stdin: input,
      timeoutMs:
        checked.args.timeout_seconds !== undefined
          ? checked.args.timeout_seconds * 1000
          : SSH_DEFAULT_COMMAND_TIMEOUT_MS,
    },
    notes: checked.notes,
  }
}

/**
 * stdin_base64 as text, for the owner to read before the command runs: only
 * when it is base64 of valid UTF-8. A kept result's handle stays a handle,
 * described by what it is, never by its content.
 */
export function stdinAsText(args: Record<string, unknown>): string | null {
  const value = args.stdin_base64

  if (typeof value !== "string" || value === "" || !BASE64.test(value)) {
    return null
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(value, "base64"),
    )
  } catch {
    return null
  }
}
