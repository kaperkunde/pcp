import { z } from "zod"

import { MAX_INPUT_EVENTS } from "./limits"

/**
 * The owner's input as the live view sends it, the same whatever carries
 * it (a POST today, perhaps a WebSocket later). Every event has `t`, the
 * time it happened on the owner's screen in milliseconds
 * (performance.now() there), so it is replayed with the cadence it was
 * made with: CAPTCHAs read the timing of mouse movement, and a relay that
 * flattened it would read as a robot. Coordinates are CSS pixels in the
 * tab's viewport.
 *
 * Client components import only the types (`import type`).
 */

const t = z.number().finite().min(0)
const coordinate = z.number().finite().min(-10_000).max(10_000)
const modifiers = z.number().int().min(0).max(15).default(0)
const buttons = z.number().int().min(0).max(31).default(0)
const button = z.enum(["left", "middle", "right", "none"])

export const InputEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("move"),
    t,
    x: coordinate,
    y: coordinate,
    buttons,
    modifiers,
  }),
  z.strictObject({
    type: z.enum(["down", "up"]),
    t,
    x: coordinate,
    y: coordinate,
    button,
    buttons,
    clickCount: z.number().int().min(1).max(3).default(1),
    modifiers,
  }),
  z.strictObject({
    type: z.literal("wheel"),
    t,
    x: coordinate,
    y: coordinate,
    dx: z.number().finite().min(-10_000).max(10_000),
    dy: z.number().finite().min(-10_000).max(10_000),
    modifiers,
  }),
  z.strictObject({
    type: z.enum(["keydown", "keyup"]),
    t,
    key: z.string().min(1).max(40),
    code: z.string().max(40).default(""),
    keyCode: z.number().int().min(0).max(255).default(0),
    modifiers,
    repeat: z.boolean().default(false),
  }),
  z.strictObject({
    type: z.literal("text"),
    t,
    text: z.string().min(1).max(10_000),
  }),
])

export const InputBatchSchema = z.strictObject({
  /** Counts up per viewer, so a batch that arrives twice is noticed. */
  seq: z.number().int().min(0),
  events: z.array(InputEventSchema).min(1).max(MAX_INPUT_EVENTS),
})

export type InputEvent = z.input<typeof InputEventSchema>
export type InputBatch = z.input<typeof InputBatchSchema>
export type ParsedInputEvent = z.output<typeof InputEventSchema>
export type ParsedInputBatch = z.output<typeof InputBatchSchema>

/** Bits of `modifiers`, as CDP numbers them. */
export const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const
