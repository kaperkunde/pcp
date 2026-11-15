// Stamps the address that connected to the app's own HTTP server into a
// header (x-pcp-peer) before Next.js handles the request, so
// lib/server/client-ip.ts can tell a proxy (whose X-Forwarded-For it may read)
// from a client (whose X-Forwarded-For is just text it wrote), and the marker
// x-pcp-forwarded for a client that sent forwarded headers at all. Any of
// either that the client sent is removed first.
//
// Inlined, not imported from @kaperkunde/security, because this file runs before Next, outside the traced bundle, and the desktop wrapper
// takes nothing from the root workspace. Used by docker/start.cjs and, staged
// beside the server, by desktop/server-entry.cjs.

const HEADER = "x-pcp-peer"
// Set only when the client itself sent X-Forwarded-For or X-Real-IP. Next
// fills X-Forwarded-For from the socket when a request has none
// (base-server.js, `??=`), so the header's presence alone says nothing.
const FORWARDED = "x-pcp-forwarded"

// Mirrors stampPeer in @kaperkunde/security, with two differences: a socket
// with no address is stamped "unknown" (which resolves to one untrusted key,
// never to trusting the headers), and the marker above.
function stampPeer(req, name) {
  delete req.headers[name]
  delete req.headers[FORWARDED]
  if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]) {
    req.headers[FORWARDED] = "1"
  }
  const address = req.socket && req.socket.remoteAddress
  req.headers[name] = address || "unknown"
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

module.exports = { HEADER, FORWARDED, stampPeer, install }
