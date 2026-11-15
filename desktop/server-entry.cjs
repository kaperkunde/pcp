// The staged server's entry in the desktop app (desktop/main.mjs forks it in
// place of server.js): stamps each request with the address that connected
// (x-pcp-peer, see peer-stamp.cjs, staged beside it), then runs the
// standalone server.js. The docker image does the same in docker/start.cjs.

require("./peer-stamp.cjs").install(require("node:http"))
require("./server.js")
