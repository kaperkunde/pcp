/**
 * The SSH binary encoding (RFC 4251, section 5): what every packet, key,
 * certificate and signature is made of. A reader never reads past its
 * buffer: anything short or malformed is an SshFormatError, because every
 * byte here may come from a server PCP does not trust yet.
 */

export class SshFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SshFormatError"
  }
}

/** The longest string a reader takes: nothing PCP reads comes near it. */
const MAX_STRING = 1024 * 1024

export class SshReader {
  private offset = 0

  constructor(private readonly buffer: Buffer) {}

  get remaining(): number {
    return this.buffer.length - this.offset
  }

  /** Everything read so far, for a signature over a prefix. */
  consumed(): Buffer {
    return this.buffer.subarray(0, this.offset)
  }

  private take(length: number): Buffer {
    if (length < 0 || length > this.remaining) {
      throw new SshFormatError("The message ended early.")
    }

    const part = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return part
  }

  byte(): number {
    return this.take(1)[0]!
  }

  boolean(): boolean {
    return this.byte() !== 0
  }

  uint32(): number {
    return this.take(4).readUInt32BE(0)
  }

  uint64(): bigint {
    return this.take(8).readBigUInt64BE(0)
  }

  string(): Buffer {
    const length = this.uint32()

    if (length > MAX_STRING) {
      throw new SshFormatError("A field in the message is too long.")
    }

    return this.take(length)
  }

  /** A string that must be UTF-8 text. */
  text(): string {
    const bytes = this.string()
    const text = bytes.toString("utf8")

    if (!Buffer.from(text, "utf8").equals(bytes)) {
      throw new SshFormatError("A text field is not UTF-8.")
    }

    return text
  }

  nameList(): string[] {
    const text = this.string().toString("latin1")
    return text === "" ? [] : text.split(",")
  }

  /** An mpint, as the unsigned big-endian bytes of its value. */
  mpint(): Buffer {
    const bytes = this.string()

    if (bytes.length > 0 && bytes[0]! & 0x80) {
      throw new SshFormatError("A number in the message is negative.")
    }

    let start = 0
    while (start < bytes.length && bytes[start] === 0) {
      start += 1
    }

    return bytes.subarray(start)
  }

  /** Fails unless every byte was read. */
  end(): void {
    if (this.remaining !== 0) {
      throw new SshFormatError("The message has bytes left over.")
    }
  }
}

export class SshWriter {
  private readonly parts: Buffer[] = []

  byte(value: number): this {
    this.parts.push(Buffer.from([value & 0xff]))
    return this
  }

  boolean(value: boolean): this {
    return this.byte(value ? 1 : 0)
  }

  uint32(value: number): this {
    const bytes = Buffer.alloc(4)
    bytes.writeUInt32BE(value >>> 0, 0)
    this.parts.push(bytes)
    return this
  }

  uint64(value: bigint): this {
    const bytes = Buffer.alloc(8)
    bytes.writeBigUInt64BE(BigInt.asUintN(64, value), 0)
    this.parts.push(bytes)
    return this
  }

  string(value: Buffer | string): this {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value
    this.uint32(bytes.length)
    this.parts.push(bytes)
    return this
  }

  nameList(names: readonly string[]): this {
    return this.string(Buffer.from(names.join(","), "latin1"))
  }

  /** An mpint from the unsigned big-endian bytes of its value. */
  mpint(unsigned: Buffer): this {
    let start = 0
    while (start < unsigned.length && unsigned[start] === 0) {
      start += 1
    }

    const value = unsigned.subarray(start)
    return this.string(
      value.length > 0 && value[0]! & 0x80
        ? Buffer.concat([Buffer.from([0]), value])
        : value,
    )
  }

  raw(bytes: Buffer): this {
    this.parts.push(bytes)
    return this
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.parts)
  }
}
