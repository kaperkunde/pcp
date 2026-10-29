import { isIP } from "node:net"

import { DOH_MAX_CNAME_HOPS } from "./limits"

/**
 * DNS messages (RFC 1035) as DNS-over-HTTPS carries them (RFC 8484): a
 * query for one name's A or AAAA records, and the answer read back. Only
 * what a lookup needs: the header, the question, and A, AAAA and CNAME
 * records in the answer section; anything else in it is skipped. Every
 * read is bounds-checked, and a name's compression pointers may only point
 * backwards, so a hostile answer cannot loop or read past its end.
 */

export const TYPE_A = 1
export const TYPE_CNAME = 5
export const TYPE_AAAA = 28
const CLASS_IN = 1

export type QueryType = typeof TYPE_A | typeof TYPE_AAAA

export class DnsWireError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DnsWireError"
  }
}

/** A host name as a lookup takes it: lower case, no trailing dot, ASCII. */
export function normalizeName(name: string): string {
  const bare = name.toLowerCase().replace(/\.$/, "")

  if (
    bare.length === 0 ||
    bare.length > 253 ||
    !/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/.test(
      bare,
    )
  ) {
    throw new DnsWireError(`${name.slice(0, 80)} is not a host name.`)
  }

  return bare
}

/** A query for `name`'s records of `type`, with id 0 as RFC 8484 asks. */
export function encodeQuery(name: string, type: QueryType): Buffer {
  const labels = normalizeName(name).split(".")
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0) // id
  header.writeUInt16BE(0x0100, 2) // a standard query, recursion desired
  header.writeUInt16BE(1, 4) // one question

  const parts: Buffer[] = [header]

  for (const label of labels) {
    parts.push(Buffer.from([label.length]), Buffer.from(label, "ascii"))
  }

  const tail = Buffer.alloc(5)
  tail.writeUInt8(0, 0)
  tail.writeUInt16BE(type, 1)
  tail.writeUInt16BE(CLASS_IN, 3)
  parts.push(tail)
  return Buffer.concat(parts)
}

export type DnsRecord = {
  /** The owner name, lower case. */
  name: string
  type: number
  ttl: number
  /** An address for A and AAAA, a name for CNAME, "" otherwise. */
  data: string
}

export type DnsMessage = {
  id: number
  /** The answer's response code: 0 is no error, 3 is no such name. */
  rcode: number
  truncated: boolean
  questions: Array<{ name: string; type: number }>
  answers: DnsRecord[]
}

function need(bytes: Buffer, at: number, length: number): void {
  if (at < 0 || at + length > bytes.length) {
    throw new DnsWireError("The DNS answer ends too early.")
  }
}

/** A name at `at`, and where the bytes after it start. */
function readName(bytes: Buffer, at: number): { name: string; next: number } {
  const labels: string[] = []
  let position = at
  let next = -1
  let total = 0

  for (;;) {
    need(bytes, position, 1)
    const length = bytes[position]!

    if (length === 0) {
      if (next === -1) next = position + 1
      break
    }

    if ((length & 0xc0) === 0xc0) {
      need(bytes, position, 2)
      const pointer = ((length & 0x3f) << 8) | bytes[position + 1]!

      // Backwards only: a pointer can never lead into a loop.
      if (pointer >= position) {
        throw new DnsWireError("The DNS answer points forward in a name.")
      }

      if (next === -1) next = position + 2
      position = pointer
      continue
    }

    if ((length & 0xc0) !== 0) {
      throw new DnsWireError("The DNS answer has a label PCP cannot read.")
    }

    need(bytes, position + 1, length)
    labels.push(bytes.toString("latin1", position + 1, position + 1 + length))
    total += length + 1

    if (total > 255) {
      throw new DnsWireError("The DNS answer has a name that is too long.")
    }

    position += 1 + length
  }

  return { name: labels.join(".").toLowerCase(), next }
}

function ipv6(bytes: Buffer, at: number): string {
  const groups: string[] = []

  for (let index = 0; index < 8; index++) {
    groups.push(bytes.readUInt16BE(at + index * 2).toString(16))
  }

  // The longest run of zero groups, written as "::".
  let best = { start: -1, length: 0 }
  let run = { start: -1, length: 0 }

  groups.forEach((group, index) => {
    if (group === "0") {
      run =
        run.start === -1
          ? { start: index, length: 1 }
          : { ...run, length: run.length + 1 }
      if (run.length > best.length) best = run
    } else {
      run = { start: -1, length: 0 }
    }
  })

  if (best.length < 2) {
    return groups.join(":")
  }

  const head = groups.slice(0, best.start).join(":")
  const tail = groups.slice(best.start + best.length).join(":")
  return `${head}::${tail}`
}

export function decodeMessage(bytes: Buffer): DnsMessage {
  need(bytes, 0, 12)
  const id = bytes.readUInt16BE(0)
  const flags = bytes.readUInt16BE(2)
  const questionCount = bytes.readUInt16BE(4)
  const answerCount = bytes.readUInt16BE(6)

  if ((flags & 0x8000) === 0) {
    throw new DnsWireError("The DNS message is a query, not an answer.")
  }

  let at = 12
  const questions: DnsMessage["questions"] = []

  for (let index = 0; index < questionCount; index++) {
    const { name, next } = readName(bytes, at)
    need(bytes, next, 4)
    questions.push({ name, type: bytes.readUInt16BE(next) })
    at = next + 4
  }

  const answers: DnsRecord[] = []

  for (let index = 0; index < answerCount; index++) {
    const { name, next } = readName(bytes, at)
    need(bytes, next, 10)
    const type = bytes.readUInt16BE(next)
    const klass = bytes.readUInt16BE(next + 2)
    const ttl = bytes.readUInt32BE(next + 4)
    const length = bytes.readUInt16BE(next + 8)
    const start = next + 10
    need(bytes, start, length)
    at = start + length

    if (klass !== CLASS_IN) {
      continue
    }

    if (type === TYPE_A && length === 4) {
      answers.push({
        name,
        type,
        ttl,
        data: [...bytes.subarray(start, start + 4)].join("."),
      })
    } else if (type === TYPE_AAAA && length === 16) {
      answers.push({ name, type, ttl, data: ipv6(bytes, start) })
    } else if (type === TYPE_CNAME) {
      const target = readName(bytes, start)

      if (target.next > start + length) {
        throw new DnsWireError("The DNS answer's CNAME runs past its record.")
      }

      answers.push({ name, type, ttl, data: target.name })
    }
  }

  return {
    id,
    rcode: flags & 0x000f,
    truncated: (flags & 0x0200) !== 0,
    questions,
    answers,
  }
}

/** The question of a query (what a resolver reads; for the test resolver). */
export function decodeQuery(bytes: Buffer): { name: string; type: number } {
  need(bytes, 0, 12)

  if ((bytes.readUInt16BE(2) & 0x8000) !== 0 || bytes.readUInt16BE(4) !== 1) {
    throw new DnsWireError("The DNS message is not a query for one name.")
  }

  const { name, next } = readName(bytes, 12)
  need(bytes, next, 4)
  return { name, type: bytes.readUInt16BE(next) }
}

export type ChainResult = {
  /** The addresses at the end of the chain; empty when it ends in a name. */
  addresses: string[]
  /** The name the chain ended at: the one to ask about next when no address. */
  name: string
  /** The shortest TTL along the chain, in seconds. */
  ttl: number
}

/**
 * Follows `name`'s CNAMEs within one answer to the records of `type` at
 * the end. Records for other names than the chain's are ignored: an answer
 * cannot slip in an address for a name nobody asked about.
 */
export function followChain(
  answers: DnsRecord[],
  name: string,
  type: QueryType,
): ChainResult {
  let current = normalizeName(name)
  let ttl = Number.POSITIVE_INFINITY
  const seen = new Set<string>([current])

  for (let hop = 0; hop <= DOH_MAX_CNAME_HOPS; hop++) {
    const addresses = answers.filter(
      (record) => record.name === current && record.type === type,
    )

    if (addresses.length > 0) {
      const family = type === TYPE_A ? 4 : 6

      return {
        addresses: addresses
          .map((record) => record.data)
          .filter((address) => isIP(address) === family),
        name: current,
        ttl: Math.min(ttl, ...addresses.map((record) => record.ttl)),
      }
    }

    const alias = answers.find(
      (record) => record.name === current && record.type === TYPE_CNAME,
    )

    if (!alias) {
      return {
        addresses: [],
        name: current,
        ttl: Number.isFinite(ttl) ? ttl : 0,
      }
    }

    if (seen.has(alias.data)) {
      throw new DnsWireError(`${name} has CNAMEs that go round in a loop.`)
    }

    seen.add(alias.data)
    ttl = Math.min(ttl, alias.ttl)
    current = alias.data
  }

  throw new DnsWireError(`${name} has more than ${DOH_MAX_CNAME_HOPS} CNAMEs.`)
}
