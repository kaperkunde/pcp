import { useCallback, useEffect, useState } from "react"

/**
 * Touch ID in the Mac app, as its preload (desktop/preload.cjs) offers it on
 * PCP's own pages: `window.pcpDesktop.touchId`. Anywhere else (a browser, the
 * app on Windows or Linux, a Mac without Touch ID) there is none, and every
 * function here says so rather than failing.
 *
 * What `unlock` hands over is the vault's Touch ID key
 * (lib/core/device-keys.ts). The app gives it only after Touch ID, and the
 * page passes it straight to PCP in a form field; nothing here keeps it.
 */

export type TouchIdStatus = {
  /** This is the Mac app, on a Mac with Touch ID set up. */
  available: boolean
  /** The app holds a Touch ID key for this PCP. */
  saved: boolean
}

type TouchIdBridge = {
  status(): Promise<TouchIdStatus>
  unlock(purpose: "unlock" | "confirm"): Promise<string | null>
  save(key: string): Promise<boolean>
  forget(): Promise<void>
}

declare global {
  interface Window {
    pcpDesktop?: { touchId?: TouchIdBridge }
  }
}

const NONE: TouchIdStatus = { available: false, saved: false }

function bridge(): TouchIdBridge | null {
  return typeof window === "undefined"
    ? null
    : (window.pcpDesktop?.touchId ?? null)
}

export async function touchIdStatus(): Promise<TouchIdStatus> {
  try {
    return (await bridge()?.status()) ?? NONE
  } catch {
    return NONE
  }
}

/** Asks for Touch ID; the key once it is given, null when it is not. */
export async function touchIdUnlock(
  purpose: "unlock" | "confirm",
): Promise<string | null> {
  try {
    return (await bridge()?.unlock(purpose)) ?? null
  } catch {
    return null
  }
}

/** Has the app keep a new key, after Touch ID; whether it did. */
export async function touchIdSave(key: string): Promise<boolean> {
  try {
    return (await bridge()?.save(key)) ?? false
  } catch {
    return false
  }
}

export async function touchIdForget(): Promise<void> {
  try {
    await bridge()?.forget()
  } catch {
    // Nothing to forget, or no app to forget it.
  }
}

/** Touch ID's state on this page: null until the app has answered. */
export function useTouchId(): {
  status: TouchIdStatus | null
  refresh: () => void
} {
  const [status, setStatus] = useState<TouchIdStatus | null>(null)
  const [asked, setAsked] = useState(0)

  useEffect(() => {
    let live = true

    void touchIdStatus().then((answer) => {
      if (live) setStatus(answer)
    })

    return () => {
      live = false
    }
  }, [asked])

  const refresh = useCallback(() => setAsked((count) => count + 1), [])

  return { status, refresh }
}

/**
 * Runs `ask` once the window has focus: at once if it has, else when the
 * owner comes back to it. Touch ID's prompt is the system's, and should not
 * appear over whatever else they are doing. Returns the cleanup.
 */
export function whenFocused(ask: () => void): () => void {
  if (document.hasFocus()) {
    ask()
    return () => {}
  }

  window.addEventListener("focus", ask, { once: true })

  return () => window.removeEventListener("focus", ask)
}
