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
