import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A throwaway HTTP API on 127.0.0.1 for tests, recording every request it
 * gets. The handler decides the answer; the default is an empty 200.
 */

export type Recorded = {
  method: string
  url: string
  headers: IncomingMessage["headers"]
  body: string
  /** The body as it came, for bytes that are not UTF-8 text. */
  bytes: Buffer
}

export type TestApi = {
  origin: string
  requests: Recorded[]
  close: () => Promise<void>
}

export async function startTestApi(
  handler: (request: Recorded, res: ServerResponse) => void = (_, res) =>
    res.end(),
): Promise<TestApi> {
  const requests: Recorded[] = []
  const sockets = new Set<import("node:net").Socket>()

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const recorded: Recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        bytes: Buffer.concat(chunks),
      }
      requests.push(recorded)
      handler(recorded, res)
    })
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

export function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

/** The cookie the fake check below sets once a browser has run its script. */
export const WALL_COOKIE = "cf_clearance"

/**
 * A page behind a fake Cloudflare check, for tests: without the clearance
 * cookie, a 403 marked `cf-mitigated: challenge` whose script (when the
 * check `clears`) sets the cookie after a moment and reloads, as a check
 * that passes on its own does; with it, the page. web_fetch runs no script,
 * so it only ever sees the check; a browser gets through.
 */
export function answerWalled(
  request: Recorded,
  res: ServerResponse,
  { clears = true }: { clears?: boolean } = {},
): void {
  res.setHeader("content-type", "text/html; charset=utf-8")

  if ((request.headers.cookie ?? "").includes(`${WALL_COOKIE}=`)) {
    res.end(
      "<!doctype html><title>Walled</title><h1>Behind the wall</h1><p>The page itself.</p>",
    )
    return
  }

  res.statusCode = 403
  res.setHeader("cf-mitigated", "challenge")
  res.end(`<!doctype html><title>Just a moment...</title>
<h1>Checking your browser</h1>
<noscript>Enable JavaScript and cookies to continue</noscript>
${
  clears
    ? `<script>setTimeout(() => { document.cookie = "${WALL_COOKIE}=passed; max-age=600; path=/"; location.reload() }, 300)</script>`
    : ""
}`)
}
