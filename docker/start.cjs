// The image's entry point: picks the address Next.js listens on, then runs
// its standalone server.js. Only the container uses it; the desktop app
// sets HOSTNAME itself (desktop/main.mjs).
//
// The Dockerfile sets HOSTNAME=::, which takes IPv6 and IPv4 at once. That
// matters under rootless Podman, whose pasta hands an IPv6 connection
// (localhost on most systems, or a .local name) to the container as IPv6;
// a server on 0.0.0.0 resets it. A kernel without IPv6 cannot listen on ::
// at all, and Next.js exits when the listen fails, so there it falls back
// to 0.0.0.0. Any other HOSTNAME is the owner's and is left alone.

const net = require("node:net")

/** The address to listen on, given HOSTNAME and whether :: can be bound. */
function listenHost(hostname, ipv6) {
  return hostname === "::" && !ipv6 ? "0.0.0.0" : hostname
}

function canListenOnIPv6() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once("error", () => resolve(false))
    probe.listen(0, "::", () => probe.close(() => resolve(true)))
  })
}

async function start() {
  if (process.env.HOSTNAME === "::") {
    process.env.HOSTNAME = listenHost("::", await canListenOnIPv6())
  }
  require("./server.js")
}

module.exports = { listenHost }

if (require.main === module) {
  start()
}
