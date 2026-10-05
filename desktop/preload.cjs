// The window's preload: the one way PCP's pages reach the app, as
// window.pcpDesktop (components/desktop-bridge.ts). Sandboxed, so it holds
// nothing but these calls; touch-id.mjs answers them, and checks again that
// the page asking is PCP's own.
//
// Every page the window shows runs this, an OAuth provider's sign-in
// included. Only PCP's own pages (plain http on localhost) get the bridge.

const { contextBridge, ipcRenderer } = require("electron")

if (location.protocol === "http:" && location.hostname === "localhost") {
  contextBridge.exposeInMainWorld("pcpDesktop", {
    touchId: {
      status: () => ipcRenderer.invoke("touch-id:status"),
      unlock: (purpose) =>
        ipcRenderer.invoke("touch-id:unlock", String(purpose)),
      save: (key) => ipcRenderer.invoke("touch-id:save", String(key)),
      forget: () => ipcRenderer.invoke("touch-id:forget"),
    },
  })
}
