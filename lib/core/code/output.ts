import { MAX_OUTPUT_CHARS } from "./limits"

/**
 * What a program prints, one line per call, up to a limit: past it the rest
 * is counted, not kept, so a loop that prints forever costs nothing more.
 */
export class Output {
  private readonly parts: string[] = []
  private length = 0
  /** Characters printed past the limit. */
  dropped = 0

  constructor(private readonly max = MAX_OUTPUT_CHARS) {}

  write(line: string): void {
    const text = `${line}\n`
    const room = this.max - this.length

    if (room <= 0) {
      this.dropped += text.length
      return
    }

    const kept = text.length > room ? text.slice(0, room) : text
    this.parts.push(kept)
    this.length += kept.length
    this.dropped += text.length - kept.length
  }

  text(): string {
    return this.parts.join("")
  }
}
