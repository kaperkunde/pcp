import https from "node:https"
import type net from "node:net"

import { selfSignedCertificate } from "../network/test-certificate"
import { decodeQuery, TYPE_A, TYPE_AAAA, TYPE_CNAME } from "./dns-wire"

/**
 * A DNS-over-HTTPS resolver for tests: an HTTPS server with a certificate
 * of its own for the resolver's name, answering GET /dns-query from a
 * table of records. Never used outside tests.
 */

export type FakeRecords = Record<
  string,
  { a?: string[]; aaaa?: string[]; cname?: string; ttl?: number }
>

export type FakeDoh = {
  port: number
  /** The certificate to trust for `servername`. */
  ca: string
  servername: string
  /** Questions asked, as "A name" or "AAAA name". */
  asked: string[]
  close: () => Promise<void>
}

function name(value: string): Buffer {
  const parts: Buffer[] = []

  for (const label of value.split(".")) {
    parts.push(Buffer.from([label.length]), Buffer.from(label, "ascii"))
  }

  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

function record(
  owner: string,
  type: number,
  ttl: number,
  data: Buffer,
): Buffer {
  const head = Buffer.alloc(10)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(1, 2)
  head.writeUInt32BE(ttl, 4)
  head.writeUInt16BE(data.length, 8)
  return Buffer.concat([name(owner), head, data])
}

function v6(address: string): Buffer {
  const [head, tail] = address.split("::") as [string, string | undefined]
  const front = head ? head.split(":") : []
  const back = tail ? tail.split(":") : []
  const groups = [
    ...front,
    ...Array<string>(8 - front.length - back.length).fill("0"),
    ...back,
  ]
  const bytes = Buffer.alloc(16)
  groups.forEach((group, index) =>
    bytes.writeUInt16BE(parseInt(group, 16), index * 2),
  )
  return bytes
}

/** An answer for `question`, following CNAMEs in the table. */
export function answerFor(
  records: FakeRecords,
  question: { name: string; type: number },
  id = 0,
): Buffer {
  const answers: Buffer[] = []
  let current = question.name
  let rcode = records[current] ? 0 : 3

  for (let hop = 0; hop < 10 && records[current]; hop++) {
    const entry = records[current]!
    const ttl = entry.ttl ?? 300

    if (entry.cname) {
      answers.push(record(current, TYPE_CNAME, ttl, name(entry.cname)))
      current = entry.cname
      continue
    }

    for (const address of question.type === TYPE_A
      ? (entry.a ?? [])
      : (entry.aaaa ?? [])) {
      answers.push(
        record(
          current,
          question.type,
          ttl,
          question.type === TYPE_A
            ? Buffer.from(address.split(".").map(Number))
            : v6(address),
        ),
      )
    }
    break
  }

  if (answers.length > 0) rcode = 0

  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0x8180 | rcode, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(answers.length, 6)
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(question.type, 0)
  tail.writeUInt16BE(1, 2)
  return Buffer.concat([header, name(question.name), tail, ...answers])
}

export async function startFakeDoh(
  records: FakeRecords,
  { servername = "cloudflare-dns.com" }: { servername?: string } = {},
): Promise<FakeDoh> {
  const { key, cert } = selfSignedCertificate(servername)
  const asked: string[] = []
  const sockets = new Set<net.Socket>()
  const server = https.createServer({ key, cert }, (req, res) => {
    const url = new URL(req.url ?? "/", "https://x")
    const query = url.searchParams.get("dns")

    if (url.pathname !== "/dns-query" || !query) {
      res.writeHead(400).end()
      return
    }

    const question = decodeQuery(Buffer.from(query, "base64url"))
    asked.push(`${question.type === TYPE_AAAA ? "AAAA" : "A"} ${question.name}`)
    res.writeHead(200, { "content-type": "application/dns-message" })
    res.end(answerFor(records, question))
  })
  server.on("secureConnection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as net.AddressInfo).port

  return {
    port,
    ca: cert,
    servername,
    asked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
