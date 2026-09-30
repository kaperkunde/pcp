// Wipes the e2e database and captured state so a full run starts clean.
// The dev server must not be running against e2e/.state/data when this
// runs (Playwright starts one afterwards).
import { rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

for (const dir of [".state", ".auth"]) {
  rmSync(path.join(here, "..", dir), { recursive: true, force: true })
}

console.log("[e2e] reset e2e/.state and e2e/.auth")
