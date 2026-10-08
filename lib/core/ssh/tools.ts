import type { CatalogueTool } from "../catalogue"
import { invalid } from "../errors"
import {
  MAX_COMMAND_CHARS,
  MAX_STDIN_BYTES,
  SSH_DEFAULT_COMMAND_TIMEOUT_MS,
  SSH_MAX_COMMAND_TIMEOUT_MS,
} from "./limits"

/**
 * The tool an SSH server offers: one command per call, run with `exec` (no
 * shell is started for it beyond the login shell's `-c`, no terminal). Its
 * arguments are checked here, before anything connects.
 */

export const RUN_COMMAND = "run_command"

export function sshTools({
  host,
  username,
}: {
  host: string
  username: string
}): CatalogueTool[] {
  return [
    {
      name: RUN_COMMAND,
      title: "Run a command",
      description: `Runs one command on ${host} as ${username} over SSH and returns its exit code, standard output and standard error. The command is run by ${username}'s login shell, without a terminal; each call is a new connection, so nothing (working directory, variables) carries over between calls. Standard input is empty unless stdin or stdin_base64 is given. For a command that writes more than 1 MB or runs past its timeout, PCP asks the server to end it (TERM; OpenSSH does this for every login but root), disconnects and returns what it wrote so far.`,
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The command line, as you would type it after ssh host.",
            maxLength: MAX_COMMAND_CHARS,
          },
          stdin: {
            type: "string",
            description:
              "Text for the command's standard input (a kept result's handle works here too).",
          },
          stdin_base64: {
            type: "string",
            description:
              'Bytes for standard input, as base64, instead of stdin: a kept file\'s handle with "as": "base64".',
          },
          timeout_seconds: {
            type: "integer",
            minimum: 1,
            maximum: SSH_MAX_COMMAND_TIMEOUT_MS / 1000,
            description: `How long the command may run; default ${SSH_DEFAULT_COMMAND_TIMEOUT_MS / 1000}.`,
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
      annotations: {
        title: "Run a command",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
  ]
}

export type RunCommandArgs = {
  command: string
  stdin: Buffer | undefined
  timeoutMs: number
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** run_command's arguments, checked; anything else is refused. */
export function parseRunCommand(args: Record<string, unknown>): RunCommandArgs {
  for (const key of Object.keys(args)) {
    if (
      !["command", "stdin", "stdin_base64", "timeout_seconds"].includes(key)
    ) {
      throw invalid(`run_command takes no argument "${key}".`)
    }
  }

  const { command, stdin, stdin_base64: stdinBase64 } = args

  if (typeof command !== "string" || command.trim() === "") {
    throw invalid("Give the command to run.")
  }

  if (command.length > MAX_COMMAND_CHARS) {
    throw invalid(
      `Keep the command under ${MAX_COMMAND_CHARS} characters; send longer input as stdin.`,
    )
  }

  // A NUL would end the command early on the server.
  if (command.includes("\0")) {
    throw invalid("The command cannot contain a NUL character.")
  }

  if (stdin !== undefined && stdinBase64 !== undefined) {
    throw invalid("Give stdin or stdin_base64, not both.")
  }

  let input: Buffer | undefined

  if (stdin !== undefined) {
    if (typeof stdin !== "string") {
      throw invalid("stdin is text.")
    }

    input = Buffer.from(stdin, "utf8")
  } else if (stdinBase64 !== undefined) {
    if (typeof stdinBase64 !== "string" || !BASE64.test(stdinBase64)) {
      throw invalid("stdin_base64 is base64.")
    }

    input = Buffer.from(stdinBase64, "base64")
  }

  if (input && input.length > MAX_STDIN_BYTES) {
    throw invalid(
      `Standard input can be at most ${MAX_STDIN_BYTES / 1024 / 1024} MB.`,
    )
  }

  let timeoutMs = SSH_DEFAULT_COMMAND_TIMEOUT_MS

  if (args.timeout_seconds !== undefined) {
    const seconds = args.timeout_seconds

    if (
      typeof seconds !== "number" ||
      !Number.isInteger(seconds) ||
      seconds < 1 ||
      seconds * 1000 > SSH_MAX_COMMAND_TIMEOUT_MS
    ) {
      throw invalid(
        `timeout_seconds is a whole number from 1 to ${SSH_MAX_COMMAND_TIMEOUT_MS / 1000}.`,
      )
    }

    timeoutMs = seconds * 1000
  }

  return { command, stdin: input, timeoutMs }
}
