/* eslint-disable @typescript-eslint/no-require-imports -- a plain worker file */
// Reads a YAML schema off PCP's main thread (lib/core/openapi/yaml-json.ts
// starts it): a worker thread, not a process, so it also runs in the desktop
// app. It is plain CommonJS that requires nothing but js-yaml, because the
// standalone build carries it as a file, not as part of a bundle
// (next.config.ts outputFileTracingIncludes). It answers with compact JSON
// text, which the caller reads with JSON.parse; a parsed tree would cost the
// main thread as much to copy as the parse did. Keep the options in step
// with yaml-json.ts `convertInline`.
"use strict"

const { parentPort, workerData } = require("node:worker_threads")
const yaml = require("js-yaml")

/** Nodes of a value with every alias counted as the copy it will be. */
function countNodes(value, limit) {
  const stack = [value]
  let seen = 0

  while (stack.length > 0) {
    const current = stack.pop()
    seen += 1

    if (seen > limit) {
      return seen
    }

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item)
    } else if (typeof current === "object" && current !== null) {
      for (const item of Object.values(current)) stack.push(item)
    }
  }

  return seen
}

try {
  const value = yaml.load(workerData.text, {
    schema: yaml.CORE_SCHEMA,
    json: true,
  })

  if (countNodes(value, workerData.maxNodes) > workerData.maxNodes) {
    parentPort.postMessage({ nodes: true })
  } else {
    parentPort.postMessage({ json: JSON.stringify(value ?? null) })
  }
} catch (error) {
  parentPort.postMessage({
    error: String(error && error.message ? error.message : error),
  })
}
