"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState, useTransition } from "react"

import { FormError } from "@/components/form-status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/input"
import {
  backTabAction,
  closeTabAction,
  handBackTabAction,
  navigateTabAction,
  reloadTabAction,
  takeOverTabAction,
} from "@/lib/actions/browser"
import { BROWSER_INPUT_EVERY_MS, BROWSER_VIEWPORT } from "@/lib/core/constants"
import type { InputEvent } from "@/lib/core/browser/input-protocol"
import type { FrameMetadata } from "@/lib/core/browser/screencast"
import type { TabView } from "@/lib/core/browser/types"
import type { ActionState } from "@/lib/server/action-state"

/**
 * A browser tab on PCP's machine, live: Chromium's pictures of it drawn on
 * a canvas as they come (server-sent events), and, while the owner has
 * taken it over, their mouse and keyboard sent back in batches with each
 * event's own time, so the page sees them at the pace they were made. Used
 * on a tab's page and on an assistant's hand-over request.
 */

type Status = "connecting" | "live" | "lost" | "closed" | "full"

const MODIFIERS = (event: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}) =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0)

const BUTTONS = ["left", "middle", "right"] as const

export function BrowserTabView({
  tabId,
  initial,
  mode = "tab",
  tokens = [],
}: {
  tabId: string
  initial: TabView
  /** handover: the owner has the tab until they answer the request below. */
  mode?: "tab" | "handover"
  /** The tokens Hand back can give the tab to (those that reach the browser). */
  tokens?: Array<{ id: string; name: string }>
}) {
  const router = useRouter()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [view, setView] = useState(initial)
  const [status, setStatus] = useState<Status>("connecting")
  const [frames, setFrames] = useState(0)
  const [meta, setMeta] = useState<FrameMetadata | null>(null)
  const [address, setAddress] = useState(initial.url)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  // Hand back offers the token whose tab it was; a tab you opened that no
  // token had yet waits for you to choose one.
  const [handTo, setHandTo] = useState(
    initial.tokenId && tokens.some((token) => token.id === initial.tokenId)
      ? initial.tokenId
      : "",
  )

  const queue = useRef<InputEvent[]>([])
  const sending = useRef(false)
  const seq = useRef(0)
  const lastDown = useRef({ t: -1e9, x: 0, y: 0, count: 0 })
  const metaRef = useRef<FrameMetadata | null>(null)
  // Right after you take a tab over or hand it back, the stream may still
  // send its state from before: what you chose holds for a moment.
  const pinned = useRef<{ control: TabView["control"]; until: number } | null>(
    null,
  )
  const holding = view.control === "owner"

  // The pictures: one EventSource, drawn newest-first, reconnecting after
  // a dropped connection unless the tab is gone.
  useEffect(() => {
    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    let latest: { data: string; metadata: FrameMetadata } | null = null
    let drawing = false
    let stopped = false

    const draw = () => {
      if (drawing || !latest) return
      const frame = latest
      latest = null
      drawing = true
      const image = new Image()
      image.onload = () => {
        const target = canvas.current

        if (target) {
          if (target.width !== image.naturalWidth)
            target.width = image.naturalWidth
          if (target.height !== image.naturalHeight)
            target.height = image.naturalHeight
          target.getContext("2d")?.drawImage(image, 0, 0)
        }

        drawing = false
        draw()
      }
      image.onerror = () => {
        drawing = false
        draw()
      }
      image.src = `data:image/jpeg;base64,${frame.data}`
    }

    const connect = () => {
      source = new EventSource(
        `/api/browser/tabs/${encodeURIComponent(tabId)}/stream`,
      )
      source.addEventListener("open", () => {
        attempts = 0
        setStatus("live")
      })
      source.addEventListener("tab", (event) => {
        const next = JSON.parse((event as MessageEvent).data) as TabView
        const pin = pinned.current
        setView(
          pin && Date.now() < pin.until
            ? { ...next, control: pin.control }
            : next,
        )
      })
      source.addEventListener("frame", (event) => {
        latest = JSON.parse((event as MessageEvent).data)
        metaRef.current = latest!.metadata
        setMeta(latest!.metadata)
        setFrames((count) => count + 1)
        draw()
      })
      source.addEventListener("closed", () => {
        stopped = true
        setStatus("closed")
        source?.close()
      })
      source.addEventListener("full", () => {
        stopped = true
        setStatus("full")
        source?.close()
      })
      source.addEventListener("error", () => {
        source?.close()
        if (stopped) return
        attempts += 1
        setStatus(attempts > 5 ? "closed" : "lost")
        if (attempts <= 5) retry = setTimeout(connect, 1000 * attempts)
      })
    }

    connect()

    return () => {
      stopped = true
      if (retry) clearTimeout(retry)
      source?.close()
    }
  }, [tabId])

  useEffect(() => {
    if (!editing) setAddress(view.url)
  }, [view.url, editing])

  // The owner's input, sent in order, a batch at a time.
  const flush = useCallback(async () => {
    if (sending.current || queue.current.length === 0) return
    sending.current = true
    const events = queue.current.splice(0, 400)

    try {
      const response = await fetch(
        `/api/browser/tabs/${encodeURIComponent(tabId)}/input`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ seq: seq.current++, events }),
        },
      )

      if (response.status === 409) {
        queue.current = []
        setView((current) => ({ ...current, control: "assistant" }))
      }
    } catch {
      // A lost batch is lost; the next one goes on.
    } finally {
      sending.current = false
    }
  }, [tabId])

  useEffect(() => {
    if (!holding) return
    const timer = setInterval(() => void flush(), BROWSER_INPUT_EVERY_MS)
    return () => clearInterval(timer)
  }, [holding, flush])

  const point = (event: { clientX: number; clientY: number }) => {
    const target = canvas.current!
    const rect = target.getBoundingClientRect()
    const frame = metaRef.current
    const width = frame?.deviceWidth ?? BROWSER_VIEWPORT.width
    const height = frame?.deviceHeight ?? BROWSER_VIEWPORT.height

    return {
      x: ((event.clientX - rect.left) * width) / rect.width,
      y:
        ((event.clientY - rect.top) * height) / rect.height -
        (frame?.offsetTop ?? 0),
    }
  }

  const push = (event: InputEvent) => {
    if (holding) queue.current.push(event)
  }

  // A wheel listener that may prevent the page behind from scrolling.
  useEffect(() => {
    const target = canvas.current
    if (!target || !holding) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1
      push({
        type: "wheel",
        t: event.timeStamp,
        ...point(event),
        dx: event.deltaX * scale,
        dy: event.deltaY * scale,
        modifiers: MODIFIERS(event),
      })
    }

    target.addEventListener("wheel", onWheel, { passive: false })
    return () => target.removeEventListener("wheel", onWheel)
    // push and point read refs and `holding`, which is a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holding])

  function act(run: () => Promise<ActionState>, control?: TabView["control"]) {
    if (control) {
      pinned.current = { control, until: Date.now() + 3_000 }
      setView((current) => ({ ...current, control }))
    }

    startTransition(async () => {
      const result = await run()
      setError(result.status === "error" ? result.error : null)

      if (result.status === "error" && control) {
        pinned.current = null
        setView((current) => ({
          ...current,
          control: control === "owner" ? "assistant" : "owner",
        }))
      } else if (control) {
        pinned.current = { control, until: Date.now() + 3_000 }
      }

      router.refresh()
    })
  }

  const handover = mode === "handover" || view.handover

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-card p-2">
        {holding ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => act(() => backTabAction(tabId))}
            >
              Back
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => act(() => reloadTabAction(tabId))}
            >
              Reload
            </Button>
            <form
              className="flex min-w-0 grow gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                setEditing(false)
                act(() => navigateTabAction(tabId, address))
              }}
            >
              <Input
                aria-label="Address"
                value={address}
                onFocus={() => setEditing(true)}
                onBlur={() => setEditing(false)}
                onChange={(event) => setAddress(event.target.value)}
                className="h-8 min-w-0 grow font-mono text-xs"
              />
              <Button type="submit" size="sm" disabled={pending}>
                Go
              </Button>
            </form>
          </>
        ) : (
          <code
            className="min-w-0 grow truncate rounded-lg bg-field px-3 py-2 text-xs text-muted-foreground"
            data-testid="browser-address"
          >
            {view.url}
          </code>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {holding ? (
            <Badge>You have this tab</Badge>
          ) : (
            <Badge variant="secondary">Assistants have this tab</Badge>
          )}
          <span className="text-[13px] leading-relaxed text-muted-foreground">
            {status === "connecting"
              ? "Connecting…"
              : status === "lost"
                ? "Connection lost; trying again…"
                : status === "closed"
                  ? "This tab is closed."
                  : status === "full"
                    ? "Too many people are watching this tab."
                    : holding
                      ? handover
                        ? "What you do here goes to the page. The assistant waits until you answer below."
                        : view.tokenId === null
                          ? "What you do here goes to the page. No assistant sees this tab until you hand it to one."
                          : "What you do here goes to the page. The assistant whose tab it is waits until you hand it back."
                      : "You are watching. Take it over to click and type."}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {holding ? (
            handover ? null : tokens.length === 0 ? (
              <span className="text-[13px] text-muted-foreground">
                No token can use the browser yet, so there is no one to hand it
                to.
              </span>
            ) : (
              <>
                <Select
                  aria-label="Hand back to"
                  className="h-8 w-auto"
                  value={handTo}
                  disabled={pending}
                  onChange={(event) => setHandTo(event.target.value)}
                >
                  {handTo === "" ? (
                    <option value="" disabled>
                      Choose a token…
                    </option>
                  ) : null}
                  {tokens.map((token) => (
                    <option key={token.id} value={token.id}>
                      {token.name}
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  size="sm"
                  disabled={pending || handTo === ""}
                  onClick={() =>
                    act(() => handBackTabAction(tabId, handTo), "assistant")
                  }
                >
                  Hand back
                </Button>
              </>
            )
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={pending || status === "closed"}
              onClick={() => act(() => takeOverTabAction(tabId), "owner")}
            >
              Take over
            </Button>
          )}
          {mode === "tab" ? (
            <Button
              type="button"
              variant="plain"
              size="sm"
              disabled={pending || status === "closed"}
              onClick={() => {
                if (window.confirm("Close this tab?")) {
                  act(() => closeTabAction(tabId))
                }
              }}
            >
              Close tab
            </Button>
          ) : null}
        </div>
      </div>

      <FormError error={error} />

      <div className="relative w-full max-w-[1280px] overflow-hidden rounded-xl bg-card ring-1 ring-separator">
        <canvas
          ref={canvas}
          width={meta?.deviceWidth ?? BROWSER_VIEWPORT.width}
          height={meta?.deviceHeight ?? BROWSER_VIEWPORT.height}
          tabIndex={holding ? 0 : -1}
          aria-label={`The page in tab ${view.id}: ${view.title || view.url}`}
          data-testid="browser-frame"
          data-frames={frames}
          className={`block h-auto w-full outline-none ${holding ? "cursor-default focus-visible:ring-2 focus-visible:ring-primary" : "cursor-not-allowed"}`}
          style={{
            aspectRatio: `${meta?.deviceWidth ?? BROWSER_VIEWPORT.width} / ${meta?.deviceHeight ?? BROWSER_VIEWPORT.height}`,
          }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerMove={(event) => {
            if (!holding) return
            const native = event.nativeEvent
            const samples = native.getCoalescedEvents?.() ?? []

            for (const sample of samples.length > 0 ? samples : [native]) {
              push({
                type: "move",
                t: sample.timeStamp,
                ...point(sample),
                buttons: sample.buttons,
                modifiers: MODIFIERS(sample),
              })
            }
          }}
          onPointerDown={(event) => {
            if (!holding) return
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            const at = point(event)
            const last = lastDown.current
            const again =
              event.timeStamp - last.t < 500 &&
              Math.abs(at.x - last.x) < 5 &&
              Math.abs(at.y - last.y) < 5
            const count = again ? Math.min(last.count + 1, 3) : 1
            lastDown.current = { t: event.timeStamp, ...at, count }
            push({
              type: "down",
              t: event.timeStamp,
              ...at,
              button: BUTTONS[event.button] ?? "left",
              buttons: event.buttons,
              clickCount: count,
              modifiers: MODIFIERS(event),
            })
          }}
          onPointerUp={(event) => {
            if (!holding) return
            push({
              type: "up",
              t: event.timeStamp,
              ...point(event),
              button: BUTTONS[event.button] ?? "left",
              buttons: event.buttons,
              clickCount: lastDown.current.count,
              modifiers: MODIFIERS(event),
            })
          }}
          onKeyDown={(event) => {
            if (!holding) return
            // Leave paste to the browser, which then fires a paste event.
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === "v"
            )
              return
            event.preventDefault()
            push({
              type: "keydown",
              t: event.timeStamp,
              key: event.key,
              code: event.code,
              keyCode: event.keyCode,
              modifiers: MODIFIERS(event),
              repeat: event.repeat,
            })
          }}
          onKeyUp={(event) => {
            if (!holding) return
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === "v"
            )
              return
            event.preventDefault()
            push({
              type: "keyup",
              t: event.timeStamp,
              key: event.key,
              code: event.code,
              keyCode: event.keyCode,
              modifiers: MODIFIERS(event),
            })
          }}
          onPaste={(event) => {
            if (!holding) return
            event.preventDefault()
            const text = event.clipboardData.getData("text")
            if (text)
              push({
                type: "text",
                t: event.timeStamp,
                text: text.slice(0, 10_000),
              })
          }}
        />
        {frames === 0 && status !== "closed" ? (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Waiting for the first picture…
          </p>
        ) : null}
      </div>
    </div>
  )
}
