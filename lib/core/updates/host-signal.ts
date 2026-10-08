import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { dataDir } from "../data-dir"

/**
 * The owner's "Install and restart" for a PCP the Linux installer runs: a
 * file in the data folder that the installer's watcher on the host reads
 * through `docker exec` / `podman exec` (install.sh, `watch`), and answers by
 * running its own `update`. PCP never addresses the host; the file is the
 * request's id and when it was made (seconds since 1970), one line, so a
 * POSIX shell can check it. Nothing of the vault is in it.
 */
export function installSignalFile(): string {
  return path.join(dataDir(), "install-request")
}

export async function writeInstallSignal(request: {
  id: string
  at: string
}): Promise<void> {
  const file = installSignalFile()
  const seconds = Math.floor(Date.parse(request.at) / 1000)
  // Written whole and renamed, so the watcher never reads half a line.
  const partial = `${file}.${randomUUID()}.tmp`

  await writeFile(partial, `${request.id} ${seconds}\n`, { mode: 0o644 })
  await rename(partial, file)
}

export async function removeInstallSignal(): Promise<void> {
  await rm(installSignalFile(), { force: true })
}
