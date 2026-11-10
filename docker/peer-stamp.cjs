// Stamps the address that connected to the app's own HTTP server into a
// header (x-pcp-peer) before Next.js handles the request, so
// lib/server/client-ip.ts can tell a proxy (whose X-Forwarded-For it may read)
// from a client (whose X-Forwarded-For is just text it wrote). Any x-pcp-peer
// the client sent is removed first.
//
// `stampPeer` mirrors stampPeer in @kaperkunde/security, inlined because this
// file runs before Next, outside the traced bundle, and the desktop wrapper
// takes nothing from the root workspace. Used by docker/start.cjs and, staged
// beside the server, by desktop/server-entry.cjs.

const HEADER = "x-pcp-peer"

function stampPeer(req, name) {
  delete req.headers[name]
  const address = req.socket && req.socket.remoteAddress
  if (address) req.headers[name] = address
}

let installed = false

/**
 * Stamps every request and upgrade an `http` server in this process handles,
 * Next's included, however it creates its server. Once per process.
 */
function install(http) {
  if (installed) return
  installed = true
  const emit = http.Server.prototype.emit
  http.Server.prototype.emit = function (event, ...args) {
    if ((event === "request" || event === "upgrade") && args[0]) {
      stampPeer(args[0], HEADER)
    }
    return emit.call(this, event, ...args)
  }
}

module.exports = { HEADER, stampPeer, install }
