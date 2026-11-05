import { z } from "zod"

import type { CatalogueTool } from "../catalogue"
import { defineInnerTool, exactlyOne, type InnerTool } from "../tools/family"
import {
  DEFAULT_FIND_RESULTS,
  MAX_FIND_RESULTS,
  MAX_GLOB_CHARS,
  MAX_LIST_ENTRIES,
  MAX_PATH_CHARS,
  MAX_SAVE_TEXT_CHARS,
} from "./limits"

/**
 * The tools a storage root offers: list, find, read, save, make a folder,
 * move and delete, each inside the root and nowhere else (files.ts). They
 * are defined on PCP's one tool interface (lib/core/tools/family.ts), their
 * arguments checked by the one validator before anything connects. A file
 * goes out as a kept result's handle (get_file) and comes in as one
 * (save_file's file), so its bytes never pass through the assistant. A
 * read-only root offers the first three only, and refuses the rest.
 */

export const STORAGE_READ_TOOLS = [
  "list_folder",
  "find_files",
  "get_file",
] as const
export const STORAGE_WRITE_TOOLS = [
  "save_file",
  "make_folder",
  "move",
  "delete",
] as const
export type StorageToolName =
  (typeof STORAGE_READ_TOOLS)[number] | (typeof STORAGE_WRITE_TOOLS)[number]

const path = (what: string) =>
  z
    .string()
    .max(MAX_PATH_CHARS)
    .regex(/^[^\u0000]*$/, {
      message: "A path cannot contain a NUL character.",
    })
    .describe(what)

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

const listFolder = defineInnerTool({
  name: "list_folder",
  title: "List a folder",
  description: "Lists the files and folders in a folder.",
  input: z.strictObject({
    path: path(
      'The folder to list, relative to the top of this storage folder ("scans/2026"); left out or "", the top.',
    ).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIST_ENTRIES)
      .optional()
      .describe(
        `How many entries at most; default and most ${MAX_LIST_ENTRIES}.`,
      ),
  }),
  annotations: READ,
})

const findFiles = defineInnerTool({
  name: "find_files",
  title: "Find files",
  description: "Finds files by name in a folder and the folders under it.",
  input: z.strictObject({
    name: z
      .string()
      .min(1)
      .max(MAX_GLOB_CHARS)
      .describe(
        'The name to look for, with * for any characters and ? for one ("*.pdf", "invoice-2026-??.pdf"); case is ignored unless case_sensitive.',
      ),
    path: path(
      "The folder to look in, with everything under it; left out, the whole storage folder.",
    ).optional(),
    type: z
      .enum(["file", "folder"])
      .optional()
      .describe("Only files, or only folders; left out, both."),
    case_sensitive: z
      .boolean()
      .optional()
      .describe("Match upper and lower case exactly; default false."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_FIND_RESULTS)
      .optional()
      .describe(
        `How many matches at most; default ${DEFAULT_FIND_RESULTS}, at most ${MAX_FIND_RESULTS}.`,
      ),
  }),
  annotations: READ,
})

const getFile = defineInnerTool({
  name: "get_file",
  title: "Get a file",
  description: "Gets one file as a kept result's handle.",
  input: z.strictObject({
    path: path("The file, relative to the top of this storage folder."),
  }),
  annotations: READ,
})

const saveFile = defineInnerTool({
  name: "save_file",
  title: "Save a file",
  description: "Saves a file from a handle or text.",
  input: z.strictObject({
    path: path(
      'Where to save it, relative to the top of this storage folder, with the file\'s name ("scans/2026/invoice.pdf"). The folder it goes in must be there (make_folder makes one).',
    ),
    file: z
      .strictObject({
        $result: z
          .string()
          .min(1)
          .max(64)
          .describe("A kept result's id, from its handle."),
      })
      .optional()
      .describe(
        'The file to save: a kept result, as {"$result": "<id>"} (a mail attachment get_attachment read, a file a tool answered with, an upload).',
      ),
    text: z
      .string()
      .max(MAX_SAVE_TEXT_CHARS)
      .optional()
      .describe("Text to save as the file, as UTF-8, instead of file."),
    overwrite: z
      .boolean()
      .optional()
      .describe(
        "Replace a file that is there already; default false, which refuses and changes nothing.",
      ),
  }),
  rules: [exactlyOne(["file", "text"], "Give file or text, one of them.")],
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
})

const makeFolder = defineInnerTool({
  name: "make_folder",
  title: "Make a folder",
  description: "Makes a folder, and its parents if asked.",
  input: z.strictObject({
    path: path("The new folder, relative to the top of this storage folder."),
    parents: z
      .boolean()
      .optional()
      .describe(
        "Also make the folders above it that are not there yet; default false.",
      ),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
})

const move = defineInnerTool({
  name: "move",
  title: "Move or rename",
  description: "Moves or renames a file or folder.",
  input: z.strictObject({
    from: path("What to move, relative to the top of this storage folder."),
    to: path(
      "Its new path in full, with its name, relative to the top of this storage folder. The folder it goes in must be there.",
    ),
    overwrite: z
      .boolean()
      .optional()
      .describe(
        "Replace a file that is at to already; default false. A folder is never replaced.",
      ),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
})

const remove = defineInnerTool({
  name: "delete",
  title: "Delete",
  description: "Deletes a file or folder for good.",
  input: z.strictObject({
    path: path("What to delete, relative to the top of this storage folder."),
    recursive: z
      .boolean()
      .optional()
      .describe(
        "Delete a folder with everything in it; default false, which deletes only an empty folder.",
      ),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
})

const TOOLS: Record<StorageToolName, InnerTool> = {
  list_folder: listFolder,
  find_files: findFiles,
  get_file: getFile,
  save_file: saveFile,
  make_folder: makeFolder,
  move,
  delete: remove,
}

/** A storage root's tool by name; undefined for any other name. */
export function storageTool(name: string): InnerTool | undefined {
  return Object.hasOwn(TOOLS, name) ? TOOLS[name as StorageToolName] : undefined
}

export function isStorageWrite(name: string): boolean {
  return (STORAGE_WRITE_TOOLS as readonly string[]).includes(name)
}

/** The catalogue's tools for one root, in words that name it. */
export function storageTools({
  folder,
  host,
  readOnly,
}: {
  /** The root's path on the server. */
  folder: string
  /** The SSH server's name. */
  host: string
  readOnly: boolean
}): CatalogueTool[] {
  const where = `the folder ${folder} on ${host}`
  const words: Record<StorageToolName, string> = {
    list_folder: `Lists the files and folders in ${where}, or a folder inside it: each one's name, path, type, size and when it changed, folders first. Paths are relative to the top of the folder; nothing outside it is reached.`,
    find_files: `Finds files and folders by name in ${where} (or a folder inside it) and every folder under it, with * and ? in the name. Answers with each match's path, size and when it changed. Symbolic links are not followed.`,
    get_file: `Gets one file from ${where} as a kept result's handle, {"$result": "<id>"}, to pass on whole to another tool (send_email's attachments, save_file on another folder, an API's file field) without reading it yourself; a text file's start comes back as text too. A file larger than PCP keeps is refused.`,
    save_file: `Saves a file in ${where}: a kept result's handle (file, {"$result": "<id>"}: a mail attachment, a scan, a converted document) or text. It is written under a temporary name and renamed into place when whole, with the folder's permissions. A file already there is replaced only with overwrite: true.`,
    make_folder: `Makes a folder in ${where}, with parents: true also the folders above it. A folder already there is left as it is.`,
    move: `Moves or renames a file or folder within ${where}: from and to are both full paths inside it. A file at to is replaced only with overwrite: true; a folder never.`,
    delete: `Deletes a file or folder in ${where} for good: there is no Trash. A folder must be empty unless recursive: true. A symbolic link is deleted itself, never what it points to.`,
  }

  return (Object.keys(TOOLS) as StorageToolName[])
    .filter((name) => !readOnly || !isStorageWrite(name))
    .map((name) => TOOLS[name].listed(words[name]))
}
