import { existsSync } from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"

import yaml from "js-yaml"

import { MB, SPEC_MEMORY_FACTOR } from "../resources/limits"
import { countNodes } from "./nodes"

/**
 * Turns YAML schema text into compact JSON text, the form everything else
 * reads (JSON.parse of GitHub's whole REST description takes about 80 ms;
 * the `yaml` package took 3 seconds and 500 MB for it, js-yaml 0.35 seconds
 * and 200 MB). A schema is read with the core schema and no custom tags, so
 * nothing in the document can construct anything but strings, numbers,
 * booleans, null, arrays and objects; aliases share their value in js-yaml,
 * so a "billion laughs" document is cheap to read and is refused by counting
 * the nodes it would expand to, before it is written out.
 *
 * `convertYaml` does it in a worker thread, with a memory cap and a time
 * limit, so a large or hostile document neither holds up PCP's other
 * requests nor takes its memory. If the worker's file is not there (a build
 * that did not carry it) or it cannot start, the same conversion runs in
 * place: slower for everyone else, never wrong.
 */

export class YamlTooLarge extends Error {}
export class YamlUnreadable extends Error {}

export type YamlOptions = {
  /** Nodes the document may expand to (see MAX_SPEC_NODES). */
  maxNodes: number
  /** The schema's own size limit, which the worker's memory follows. */
  specBytes: number
}

const WORKER_FILE = "lib/core/openapi/yaml-worker.cjs"
const WORKER_TIMEOUT_MS = 60_000
const MIN_WORKER_MEMORY_MB = 256

/** Keep in step with yaml-worker.cjs. */
export function convertInline(text: string, maxNodes: number): string {
  let value: unknown

  try {
    value = yaml.load(text, { schema: yaml.CORE_SCHEMA, json: true })
  } catch (error) {
    throw new YamlUnreadable(
      error instanceof Error ? error.message : String(error),
    )
  }

  if (countNodes(value, maxNodes) > maxNodes) {
    throw new YamlTooLarge()
  }

  return JSON.stringify(value ?? null)
}

function workerFile(): string | null {
  const roots = [process.cwd()]

  if (process.argv[1]) {
    roots.push(path.dirname(process.argv[1]))
  }

  for (const root of roots) {
    const file = path.join(root, WORKER_FILE)

    if (existsSync(file)) {
      return file
    }
  }

  return null
}

/** Why the worker could not be used, once known, so later calls skip it. */
let workerBroken = false

export function convertInWorker(
  text: string,
  { maxNodes, specBytes }: YamlOptions,
): Promise<string> {
  const file = workerBroken ? null : workerFile()

  if (!file) {
    return Promise.resolve().then(() => convertInline(text, maxNodes))
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let worker: Worker | undefined

    const finish = (run: () => void) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        void worker?.terminate()
        run()
      }
    }

    const timer = setTimeout(
      () => finish(() => reject(new YamlTooLarge())),
      WORKER_TIMEOUT_MS,
    )
    timer.unref?.()

    try {
      worker = new Worker(file, {
        workerData: { text, maxNodes },
        resourceLimits: {
          maxOldGenerationSizeMb: Math.max(
            MIN_WORKER_MEMORY_MB,
            Math.ceil(specBytes / MB) * SPEC_MEMORY_FACTOR,
          ),
        },
      })
    } catch {
      workerBroken = true
      clearTimeout(timer)
      settled = true
      resolve(convertInline(text, maxNodes))
      return
    }

    worker.once(
      "message",
      (message: { json?: string; nodes?: boolean; error?: string }) =>
        finish(() => {
          if (message.json !== undefined) {
            resolve(message.json)
          } else if (message.nodes) {
            reject(new YamlTooLarge())
          } else {
            reject(new YamlUnreadable(message.error ?? "unreadable"))
          }
        }),
    )
    worker.once("error", (error: Error & { code?: string }) =>
      finish(() => {
        if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
          reject(new YamlTooLarge())
        } else if (error.code === "MODULE_NOT_FOUND") {
          // js-yaml is not beside the worker's file: read it here.
          workerBroken = true
          try {
            resolve(convertInline(text, maxNodes))
          } catch (inline) {
            reject(inline)
          }
        } else {
          reject(new YamlUnreadable(error.message))
        }
      }),
    )
  })
}
