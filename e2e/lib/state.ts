import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

// Producer projects keep small facts here for their dependents — the moral
// equivalent of storageState for non-session state. Gitignored.
const STATE_DIR = join(__dirname, "..", ".state")

export function saveState(name: string, data: unknown) {
  const file = join(STATE_DIR, `${name}.json`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2))
}

export function loadState<T>(name: string): T {
  return JSON.parse(readFileSync(join(STATE_DIR, `${name}.json`), "utf8")) as T
}

export type SetupState = {
  name: string
  recoveryKey: string
}
