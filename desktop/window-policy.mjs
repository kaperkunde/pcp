// What the window lets a page do beyond showing itself, apart from Electron
// so it can be tested (window-policy.test.mjs); main.mjs wires it to the
// window and its session.
//
// The window shows PCP's own pages, and during a sign-in an OAuth provider's
// (top-level navigation leaves PCP for the provider and comes back to the
// callback). Electron's defaults would hand any address a page opens to the
// system (smb:, file:, search-ms: and the like reach whatever program
// claims them, a way to run code from a remote share) and grant every
// permission a page asks for. Here the window goes to web addresses only,
// the system's browser is given web addresses only, and a permission is
// granted only to PCP's own pages, only those they use.

import { isPcpPage } from "./touch-id-store.mjs"

const WEB_PROTOCOLS = new Set(["http:", "https:"])

/**
 * What PCP's own pages use: navigator.clipboard.writeText, for the copy
 * buttons (components/copyable-value.tsx). Nothing else, openExternal
 * included: PCP links nothing that is not a web address.
 */
export const PCP_PERMISSIONS = new Set(["clipboard-sanitized-write"])

/**
 * The address, written out whole, when it is a web address (http or https);
 * null for every other scheme and for what is not an address. The window
 * navigates only to these, and only these go to the system's browser.
 *
 * @param {unknown} url
 * @returns {string | null}
 */
export function webUrl(url) {
  if (typeof url !== "string") {
    return null
  }

  try {
    const parsed = new URL(url)
    return WEB_PROTOCOLS.has(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}

/**
 * Whether a page in the window gets a permission it asks for, or that
 * Chromium checks for it: only PCP's own page (the address the window
 * loads, not a frame of another site inside it), and only what it uses.
 *
 * @param {{ permission: string, url: unknown, isMainFrame?: boolean }} request
 *   url is the asking page's address or origin.
 * @param {number} port PCP's port on 127.0.0.1.
 */
export function permissionAllowed({ permission, url, isMainFrame }, port) {
  return (
    PCP_PERMISSIONS.has(permission) &&
    isMainFrame !== false &&
    typeof url === "string" &&
    isPcpPage(url, port)
  )
}
