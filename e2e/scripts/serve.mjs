// Runs the production build for the e2e suite the way the image runs it:
// Next's standalone server through docker/start.cjs, with the static files,
// the public folder and the migrations beside it where the Dockerfile copies
// them. `pnpm test:e2e` builds first (PCP_TEST_BUILD=1, so the build may be
// pointed at the fake GitHub); this only serves what is there.
import { cpSync, existsSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..")
const standalone = path.join(root, ".next", "standalone")
const require = createRequire(import.meta.url)

if (!existsSync(path.join(standalone, "server.js"))) {
  console.error(
    "[e2e] no production build in .next/standalone: run `PCP_TEST_BUILD=1 pnpm build` first",
  )
  process.exit(1)
}

for (const [from, to] of [
  [".next/static", ".next/static"],
  ["public", "public"],
  ["prisma/migrations", "prisma/migrations"],
  ["docker/start.cjs", "start.cjs"],
]) {
  const target = path.join(standalone, to)
  rmSync(target, { recursive: true, force: true })
  cpSync(path.join(root, from), target, { recursive: true })
}

// The image listens on :: (IPv4 and IPv6 at once), falling back to 0.0.0.0
// without IPv6. HOSTNAME is the machine's name in most shells, which Next
// would listen on instead.
const { listenHost } = require(path.join(standalone, "start.cjs"))
const ipv6 = await new Promise((resolve) => {
  const probe = net.createServer()
  probe.once("error", () => resolve(false))
  probe.listen(0, "::", () => probe.close(() => resolve(true)))
})
process.env.HOSTNAME = listenHost("::", ipv6)
process.env.PORT ??= "3000"

require(path.join(standalone, "server.js"))
