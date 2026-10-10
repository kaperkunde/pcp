"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState, useTransition } from "react"

import { FormError } from "@/components/form-status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input, Textarea } from "@/components/ui/input"
import {
  backTabAction,
  closeTabAction,
  handBackTabAction,
  navigateTabAction,
  reloadTabAction,
  takeOverTabAction,
} from "@/lib/actions/browser"
import {
  boxEdit,
  editEvents,
  isNamedKey,
  keyPress,
  KEYBOARD_BOX_MAX,
} from "@/lib/browser-keyboard"
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
 *
 * A canvas cannot take a phone's on-screen keyboard, nor a long press to
 * paste. So the view also keeps a hidden text box: the Keyboard button
 * focuses it, and what the keyboard does to it goes to the page (see
 * `lib/browser-keyboard.ts`). Paste reads the clipboard, or, where the
 * browser will not give it, takes the text in a box you can paste into.
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
}: {
  tabId: string
  initial: TabView
  /** handover: the owner has the tab until they answer the request below. */
  mode?: "tab" | "handover"
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

  const queue = useRef<InputEvent[]>([])
  const sending = useRef(false)
  const seq = useRef(0)
  const lastDown = useRef({ t: -1e9, x: 0, y: 0, count: 0 })
  const metaRef = useRef<FrameMetadata | null>(null)
  // The hidden text box a phone's keyboard types into: what it held after
  // the last edit, whether a word is being composed, and the named keys
  // whose keydown went to the page (so their keyup does too).
  const box = useRef<HTMLTextAreaElement>(null)
  const boxText = useRef("")
  const composing = useRef(false)
  const held = useRef(new Set<string>())
  // The keyboard was up when a finger came down on the picture: it stays.
  const typing = useRef(false)
  const [pasteBox, setPasteBox] = useState<string | null>(null)
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

  // Everything made so far is sent, and answered, before the tab changes
  // hands: what the page refuses once it is not yours would be lost.
  const drain = useCallback(async () => {
    for (
      let turns = 0;
      turns < 50 && (queue.current.length > 0 || sending.current);
      turns += 1
    ) {
      if (sending.current) await new Promise((r) => setTimeout(r, 20))
      else await flush()
    }
  }, [flush])

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

  const pushAll = (events: InputEvent[]) => {
    for (const event of events) push(event)
  }

  const emptyBox = () => {
    if (box.current) box.current.value = ""
    boxText.current = ""
    composing.current = false
  }

  // Up comes the keyboard, and again if it was put away with the back
  // button, which leaves the box focused.
  function openKeyboard() {
    const target = box.current
    if (!target) return
    emptyBox()
    target.blur()
    target.focus()
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        push({
          type: "text",
          t: performance.now(),
          text: text.slice(0, 10_000),
        })
        setError(null)
      } else {
        setError("The clipboard holds no text.")
      }
    } catch {
      // No clipboard on a page that is not secure, or you said no.
      setPasteBox((current) => current ?? "")
    }
  }

  function sendPasted() {
    const text = (pasteBox ?? "").slice(0, 10_000)
    if (text) push({ type: "text", t: performance.now(), text })
    setPasteBox(null)
  }

  // What the keyboard does to the box that a text edit does not carry: a
  // line break, and a delete with nothing left in the box to delete.
  useEffect(() => {
    const target = box.current
    if (!target || !holding) return

    const onBeforeInput = (event: globalThis.InputEvent) => {
      if (event.isComposing) return

      if (
        event.inputType === "insertLineBreak" ||
        event.inputType === "insertParagraph"
      ) {
        event.preventDefault()
        pushAll(keyPress(event.timeStamp, "Enter"))
      } else if (
        event.inputType === "deleteContentBackward" &&
        boxText.current === ""
      ) {
        event.preventDefault()
        pushAll(keyPress(event.timeStamp, "Backspace"))
      }
    }

    target.addEventListener("beforeinput", onBeforeInput)
    return () => target.removeEventListener("beforeinput", onBeforeInput)
    // pushAll reads refs and `holding`, which is a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holding])

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
    const choose = (chosen: TabView["control"]) => {
      pinned.current = { control: chosen, until: Date.now() + 3_000 }
      setView((current) => ({ ...current, control: chosen }))
    }

    if (control === "owner") choose(control)

    startTransition(async () => {
      if (control === "assistant") {
        await drain()
        choose(control)
      }

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
      <div className="flex flex-wrap items-center gap-2">
        {holding ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => act(() => backTabAction(tabId))}
            >
              Back
            </Button>
            <Button
              type="button"
              variant="outline"
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
            className="min-w-0 grow truncate rounded-md border border-border px-2 py-1 text-xs"
            data-testid="browser-address"
          >
            {view.url}
          </code>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {holding ? (
            <Badge>You have this tab</Badge>
          ) : (
            <Badge variant="secondary">Assistants have this tab</Badge>
          )}
          <span className="text-muted-foreground">
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
                        : "What you do here goes to the page. Assistants wait until you hand it back."
                      : "You are watching. Take it over to click and type."}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {holding ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="hidden pointer-coarse:inline-flex"
                data-testid="browser-keyboard-button"
                onClick={openKeyboard}
              >
                Keyboard
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="hidden pointer-coarse:inline-flex"
                data-testid="browser-paste-button"
                onClick={() => void paste()}
              >
                Paste
              </Button>
            </>
          ) : null}
          {holding ? (
            handover ? null : (
              <Button
                type="button"
                size="sm"
                disabled={pending}
                onClick={() => act(() => handBackTabAction(tabId), "assistant")}
              >
                Hand back
              </Button>
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
              variant="outline"
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

      {holding && pasteBox !== null ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            sendPasted()
          }}
        >
          <label htmlFor="browser-paste-text" className="text-sm">
            This browser will not hand over the clipboard. Paste the text here
            and send it to the page.
          </label>
          <Textarea
            id="browser-paste-text"
            value={pasteBox}
            maxLength={10_000}
            autoFocus
            onChange={(event) => setPasteBox(event.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pasteBox === ""}>
              Send to the page
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPasteBox(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      <div className="relative w-full max-w-[1280px] overflow-hidden rounded-md border border-border bg-muted">
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
          onMouseDown={(event) => {
            // A tap on the picture must not take the focus from the keyboard.
            if (holding && document.activeElement === box.current) {
              event.preventDefault()
            }
          }}
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
            typing.current = document.activeElement === box.current

            if (typing.current) {
              // What the box holds is about the field before this tap.
              emptyBox()
            } else {
              event.currentTarget.focus()
            }

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
            if (typing.current) box.current?.focus()
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
        {holding ? (
          <textarea
            ref={box}
            rows={1}
            aria-label="Keyboard for the page"
            data-testid="browser-keyboard"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            // 16px keeps iOS from zooming in when the box is focused.
            style={{ fontSize: 16 }}
            className="pointer-events-none absolute bottom-0 left-0 h-px w-px resize-none overflow-hidden border-0 p-0 opacity-0 outline-none"
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={() => {
              composing.current = false
            }}
            onInput={(event) => {
              const target = event.currentTarget
              pushAll(
                editEvents(
                  event.timeStamp,
                  boxEdit(boxText.current, target.value),
                ),
              )
              boxText.current = target.value

              // Between words, a box that has grown is emptied.
              if (
                !composing.current &&
                [...target.value].length > KEYBOARD_BOX_MAX
              ) {
                emptyBox()
              }
            }}
            onKeyDown={(event) => {
              const native = event.nativeEvent
              const shortcut = event.ctrlKey || event.metaKey
              // Left to the browser, which then fires a paste event.
              if (shortcut && event.key.toLowerCase() === "v") return

              // Backspace with something in the box to take back is an edit
              // of the box like any other, and keeps the box in step.
              if (
                event.key === "Backspace" &&
                !shortcut &&
                boxText.current !== ""
              )
                return

              // Keys by name, and shortcuts, go as the keys they are; the
              // letters a keyboard types arrive as edits of the box.
              if (
                !shortcut &&
                !isNamedKey({
                  key: event.key,
                  keyCode: event.keyCode,
                  isComposing: native.isComposing,
                })
              )
                return

              event.preventDefault()
              held.current.add(event.key)
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
              if (!held.current.delete(event.key)) return
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
        ) : null}
        {frames === 0 && status !== "closed" ? (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Waiting for the first picture…
          </p>
        ) : null}
      </div>
    </div>
  )
}
