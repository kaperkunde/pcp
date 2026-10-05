// PCP as a desktop app. The main process starts the same production server
// the Docker image runs (scripts/stage.mjs puts it in resources/server),
// with its data in the system's application data folder, waits until it
// answers, and shows it in a window. Nothing of PCP runs in here: the
// wrapper knows the server's address and its data directory, and on a Mac
// with Touch ID keeps the key PCP made for it (touch-id.mjs), which it hands
// to PCP's own page after Touch ID and never reads itself.
//
// The server listens on this computer only until the owner turns on
// "Accept connections from other devices" (then on every interface, for port
// forwarding from a router). Closing the window leaves the server running,
// so assistants keep reaching it; Quit stops it.
//
// Updates: PCP's Settings page offers "Install and restart" when this build
// can replace itself (updates.mjs, updaterMode). The page cannot reach the
// wrapper, so the server says in /api/health that the owner asked, and the
// wrapper, reading it every few seconds, downloads the release from GitHub
// with electron-updater and restarts into it.

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
  utilityProcess,
} from "electron"
import { createWriteStream, mkdirSync } from "node:fs"
import http from "node:http"
import { createRequire } from "node:module"
import net from "node:net"
import path from "node:path"

import { lanAddresses, readSettings, writeSettings } from "./settings.mjs"
import { serveTouchId } from "./touch-id.mjs"
import {
  isNewer,
  parseHealth,
  pendingInstall,
  updaterMode,
} from "./updates.mjs"

const APP_ID = "com.kaperkunde.pcp"
const REPOSITORY_URL = "https://github.com/kaperkunde/pcp"
const README_URL = `${REPOSITORY_URL}#readme`
const ISSUES_URL = `${REPOSITORY_URL}/issues`
const RELEASES_URL = `${REPOSITORY_URL}/releases/latest`
const THEME_COLOR = "#131720"
const STARTUP_TIMEOUT_MS = 90_000
/** How often the wrapper looks whether the owner asked for an update. */
const UPDATE_POLL_MS = 15_000

// The same folder whether packaged (PCP.app) or started from a checkout
// (`electron .`, where the name would otherwise be the package's).
app.setName("PCP")
app.setAppUserModelId(APP_ID)

const serverDir = app.isPackaged
  ? path.join(process.resourcesPath, "server")
  : path.join(import.meta.dirname, "server")
const userData = app.getPath("userData")
const dataDir = path.join(userData, "data")
const settingsFile = path.join(userData, "desktop.json")
const touchIdFile = path.join(userData, "touch-id.bin")

let settings = readSettings(settingsFile)
/** @type {import("electron").UtilityProcess | null} */
let server = null
let stoppingServer = false
/** @type {BrowserWindow | null} */
let window = null
/** @type {Tray | null} */
let tray = null
let quitting = false

// "auto" when this build can replace itself (dist.mjs writes pcpUpdater into
// the packaged package.json), "manual" otherwise.
const updater = updaterMode(
  createRequire(import.meta.url)("./package.json"),
  app.isPackaged,
)
const startedAt = Date.now()
/** Install requests already acted on, so none is acted on twice. */
const handledInstalls = new Set()
let installing = false

if (!app.requestSingleInstanceLock()) {
  // The first instance shows its window (see second-instance below).
  app.quit()
} else {
  main()
}

function main() {
  // OAuth providers refuse sign-ins from browsers they can tell are embedded
  // ("this browser may not be secure"); the window is a plain Chromium to
  // them, which is what it is.
  app.userAgentFallback = app.userAgentFallback.replace(
    /\s(PCP|pcp-desktop|Electron)\/\S+/g,
    "",
  )

  app.setAboutPanelOptions({
    applicationName: "PCP",
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    copyright: "Kaperkunde, MIT licence",
    website: REPOSITORY_URL,
  })

  app.on("second-instance", showWindow)
  app.on("activate", showWindow)
  app.on("window-all-closed", () => {
    // Keep serving: the window is a view of the server, not the server.
  })
  app.on("before-quit", () => {
    quitting = true
  })
  app.on("will-quit", () => {
    stopServer()
  })

  app.whenReady().then(start)
}

async function start() {
  app.setAppLogsPath()
  Menu.setApplicationMenu(buildMenu())
  serveTouchId({
    file: touchIdFile,
    port: () => settings.port,
    window: () => window,
  })

  try {
    await startServer()
  } catch (error) {
    await showFatal(
      "PCP could not start.",
      error instanceof Error ? error.message : String(error),
    )
    app.exit(1)
    return
  }

  if (process.platform !== "darwin") {
    createTray()
  }
  createWindow()
  watchForUpdateRequests()
}

// --- The server -----------------------------------------------------------

function logFile() {
  return path.join(app.getPath("logs"), "server.log")
}

async function startServer() {
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(path.dirname(logFile()), { recursive: true })

  const host = settings.acceptConnectionsFromNetwork ? "0.0.0.0" : "127.0.0.1"
  const inUse = await portInUse(settings.port, host)
  if (inUse) {
    const pcp = await isHealthy(settings.port)
    throw new Error(
      `${pcp ? "Another PCP" : "Another program"} is already answering on port ${settings.port}.\n\n` +
        `Quit it, or give this PCP a different port: put {"port": 3001} in ${settingsFile} and open PCP again.`,
    )
  }

  const log = createWriteStream(logFile(), { flags: "a" })
  log.write(
    `\n[${new Date().toISOString()}] starting PCP ${app.getVersion()} on ${host}:${settings.port}, data in ${dataDir}\n`,
  )

  const child = utilityProcess.fork(path.join(serverDir, "server.js"), [], {
    cwd: serverDir,
    serviceName: "PCP server",
    stdio: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(settings.port),
      HOSTNAME: host,
      PCP_DATA_DIR: dataDir,
      // Lets PCP's own pages say how this app is reached and configured,
      // and whether it can install an update itself.
      PCP_DESKTOP: "1",
      PCP_DESKTOP_UPDATER: updater,
    },
  })
  child.stdout?.on("data", (chunk) => log.write(chunk))
  child.stderr?.on("data", (chunk) => log.write(chunk))

  let exited = false
  child.on("exit", (code) => {
    exited = true
    log.write(`[${new Date().toISOString()}] server exited with code ${code}\n`)
    log.end()
    if (server === child) server = null
    if (!stoppingServer && !quitting) {
      serverDied(code)
    }
  })
  server = child

  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (!(await isHealthy(settings.port))) {
    if (exited) {
      throw new Error(
        `The server stopped while starting. Its log is at ${logFile()}.`,
      )
    }
    if (Date.now() > deadline) {
      stopServer()
      throw new Error(
        `The server did not answer within ${STARTUP_TIMEOUT_MS / 1000} seconds. Its log is at ${logFile()}.`,
      )
    }
    await sleep(250)
  }
}

function stopServer() {
  if (!server) return
  stoppingServer = true
  server.kill()
  server = null
}

async function restartServer() {
  const previous = server
  if (previous) {
    const exited = new Promise((resolve) => previous.once("exit", resolve))
    stopServer()
    await exited
  }
  stoppingServer = false
  await startServer()
  window?.reload()
}

async function serverDied(code) {
  const choice = await dialog.showMessageBox({
    type: "error",
    message: "PCP's server stopped unexpectedly.",
    detail: `It exited with code ${code}. The log may say why.\n\n${logFile()}`,
    buttons: ["Show the log", "Quit"],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice.response === 0) {
    shell.showItemInFolder(logFile())
  }
  app.exit(1)
}

/** @param {number} port @param {string} host */
function portInUse(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.unref()
    probe.once("error", () => resolve(true))
    probe.listen(port, host, () => probe.close(() => resolve(false)))
  })
}

/** @param {number} port */
function isHealthy(port) {
  return new Promise((resolve) => {
    const request = http.get(
      `http://127.0.0.1:${port}/api/health`,
      { timeout: 2_000 },
      (response) => {
        response.resume()
        resolve(response.statusCode === 200)
      },
    )
    request.on("timeout", () => request.destroy())
    request.on("error", () => resolve(false))
  })
}

/**
 * What the server says in /api/health, or null.
 *
 * @param {number} port
 */
function readHealth(port) {
  return new Promise((resolve) => {
    const request = http.get(
      `http://127.0.0.1:${port}/api/health`,
      { timeout: 2_000 },
      (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => {
          if (body.length < 16_384) body += chunk
        })
        response.on("end", () => resolve(parseHealth(body)))
        response.on("error", () => resolve(null))
      },
    )
    request.on("timeout", () => request.destroy())
    request.on("error", () => resolve(null))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- The window -----------------------------------------------------------

function localUrl() {
  return `http://localhost:${settings.port}/`
}

function createWindow() {
  window = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: THEME_COLOR,
    title: "PCP",
    // Packaged builds carry the icon in the executable; this is for a
    // checkout, and the taskbar on Linux.
    icon: path.join(serverDir, "public", "icons", "icon-512.png"),
    webPreferences: {
      // window.pcpDesktop, for Touch ID; PCP's own pages only.
      preload: path.join(import.meta.dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // target=_blank links (the footer, documentation) open in the browser.
  // Top-level navigation is left alone: an OAuth sign-in leaves for the
  // provider and comes back to the callback.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  // While the server restarts (network access toggled) a load fails; try
  // again rather than show Chromium's error page.
  window.webContents.on("did-fail-load", (_event, code, _description, url) => {
    if (code !== -3 && url.startsWith(localUrl())) {
      setTimeout(() => window?.loadURL(localUrl()), 500)
    }
  })

  window.once("ready-to-show", () => window?.show())
  window.on("close", (event) => {
    if (quitting || process.platform === "darwin") return
    // Windows and Linux: close hides, the tray icon stays. On macOS the
    // Dock icon already says the app is running.
    event.preventDefault()
    window?.hide()
    hintAboutTray()
  })
  window.on("closed", () => {
    window = null
  })

  window.loadURL(localUrl())
}

function showWindow() {
  if (!window) {
    if (server) createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function hintAboutTray() {
  if (settings.toldAboutTray || !Notification.isSupported()) return
  settings = { ...settings, toldAboutTray: true }
  writeSettings(settingsFile, settings)
  new Notification({
    title: "PCP is still running",
    body: "Your assistants can still reach it. Open or quit PCP from its icon in the system tray.",
  }).show()
}

function createTray() {
  try {
    const mark = nativeImage.createFromPath(
      path.join(serverDir, "public", "icons", "mark.png"),
    )
    const icon = nativeImage.createEmpty()
    icon.addRepresentation({
      scaleFactor: 1,
      buffer: mark.resize({ width: 16, height: 16 }).toPNG(),
    })
    icon.addRepresentation({
      scaleFactor: 2,
      buffer: mark.resize({ width: 32, height: 32 }).toPNG(),
    })
    tray = new Tray(icon)
    tray.setToolTip("PCP")
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open PCP", click: showWindow },
        { type: "separator" },
        ...pcpMenuItems(),
        { type: "separator" },
        { label: "Quit PCP", click: () => app.quit() },
      ]),
    )
    tray.on("click", showWindow)
  } catch (error) {
    // A desktop without a tray (some Linux sessions): the window's menu has
    // the same items.
    console.error("No tray icon:", error)
  }
}

// --- Updates --------------------------------------------------------------

function watchForUpdateRequests() {
  if (updater !== "auto") return

  setInterval(async () => {
    if (installing || !server) return
    const request = pendingInstall(await readHealth(settings.port), {
      startedAt,
      handled: handledInstalls,
      current: app.getVersion(),
    })
    if (request) void installUpdate(request)
  }, UPDATE_POLL_MS)
}

/**
 * Downloads the release the owner asked for and restarts into it. The files
 * come from the GitHub Release (the publish settings in electron-builder.yml),
 * checked against the sizes and hashes in its update file.
 *
 * @param {{ id: string, version: string }} request
 */
async function installUpdate(request) {
  installing = true
  handledInstalls.add(request.id)

  try {
    const updaterModule = await import("electron-updater")
    const autoUpdater =
      updaterModule.autoUpdater ?? updaterModule.default.autoUpdater
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    // The release's files keep the same names from one version to the next,
    // so there is no earlier file to download only the difference against.
    autoUpdater.disableDifferentialDownload = true
    // One update file per architecture (dist.mjs): the two Mac builds would
    // otherwise both write latest-mac.yml. Setting a channel allows a
    // downgrade, which an update never is.
    autoUpdater.channel = `latest-${process.arch}`
    autoUpdater.allowDowngrade = false

    const result = await autoUpdater.checkForUpdates()
    const found = result?.updateInfo?.version

    if (!found || !isNewer(found, app.getVersion())) {
      await dialog.showMessageBox(window ?? undefined, {
        type: "info",
        message: "There is no newer version of the app to install yet.",
        detail: `The release may still be on its way. Try again in a few minutes, or download it from ${RELEASES_URL}.`,
      })
      return
    }

    if (Notification.isSupported()) {
      new Notification({
        title: `Updating PCP to v${found}`,
        body: "PCP restarts by itself when the download is done.",
      }).show()
    }

    const onProgress = (progress) =>
      window?.setProgressBar(Math.min(1, Math.max(0, progress.percent / 100)))
    autoUpdater.on("download-progress", onProgress)
    try {
      await autoUpdater.downloadUpdate()
    } finally {
      autoUpdater.removeListener("download-progress", onProgress)
      window?.setProgressBar(-1)
    }

    // will-quit stops the server, as for any quit.
    quitting = true
    autoUpdater.quitAndInstall(true, true)
  } catch (error) {
    quitting = false
    window?.setProgressBar(-1)
    const choice = await dialog.showMessageBox(window ?? undefined, {
      type: "error",
      message: "PCP could not install the update.",
      detail: `${error instanceof Error ? error.message : String(error)}\n\nDownload the new version and open it instead; your vault stays where it is.`,
      buttons: ["Open the download page", "OK"],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice.response === 0) shell.openExternal(RELEASES_URL)
  } finally {
    installing = false
  }
}

/** Settings → Updates in the window: the version, what is new, how to update. */
function openUpdates() {
  showWindow()
  window?.loadURL(`${localUrl()}settings#updates`)
}

// --- Menus ----------------------------------------------------------------

function pcpMenuItems() {
  return [
    {
      label: "Accept connections from other devices",
      type: "checkbox",
      checked: settings.acceptConnectionsFromNetwork,
      click: (item) => setNetworkAccess(item.checked),
    },
    ...(process.platform === "linux"
      ? []
      : [
          {
            label: "Start PCP when you sign in",
            type: "checkbox",
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item) =>
              app.setLoginItemSettings({ openAtLogin: item.checked }),
          },
        ]),
    { type: "separator" },
    { label: "Check for updates…", click: openUpdates },
    { label: "Change the port…", click: changePort },
    { label: "Show the data folder", click: () => shell.openPath(dataDir) },
    {
      label: "Show the server log",
      click: () => shell.showItemInFolder(logFile()),
    },
  ]
}

function buildMenu() {
  const isMac = process.platform === "darwin"
  /** @type {import("electron").MenuItemConstructorOptions[]} */
  const template = [
    isMac
      ? {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            ...pcpMenuItems(),
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }
      : {
          label: "PCP",
          submenu: [
            { label: "Open PCP", click: showWindow },
            { type: "separator" },
            ...pcpMenuItems(),
            { type: "separator" },
            {
              label: "Quit PCP",
              accelerator: "CmdOrCtrl+Q",
              click: () => app.quit(),
            },
          ],
        },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" }, { role: "front" }]
          : [{ role: "close" }]),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "PCP documentation",
          click: () => shell.openExternal(README_URL),
        },
        {
          label: "Report a problem",
          click: () => shell.openExternal(ISSUES_URL),
        },
        ...(isMac
          ? []
          : [
              { type: "separator" },
              { label: "About PCP", click: () => app.showAboutPanel() },
            ]),
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

function refreshMenus() {
  Menu.setApplicationMenu(buildMenu())
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open PCP", click: showWindow },
      { type: "separator" },
      ...pcpMenuItems(),
      { type: "separator" },
      { label: "Quit PCP", click: () => app.quit() },
    ]),
  )
}

/** @param {boolean} enabled */
async function setNetworkAccess(enabled) {
  settings = { ...settings, acceptConnectionsFromNetwork: enabled }
  writeSettings(settingsFile, settings)

  try {
    await restartServer()
  } catch (error) {
    await showFatal(
      "PCP could not restart its server.",
      error instanceof Error ? error.message : String(error),
    )
    app.exit(1)
    return
  }
  refreshMenus()

  if (enabled) {
    const addresses = lanAddresses()
    await dialog.showMessageBox(window ?? undefined, {
      type: "info",
      message: "PCP now accepts connections from other devices.",
      detail:
        (addresses.length > 0
          ? `On your network it answers at:\n${addresses.map((address) => `http://${address}:${settings.port}`).join("\n")}\n\n`
          : "") +
        "The internet needs neither this nor port forwarding to this port: use a tunnel, or PCP's own HTTPS on ports 80 and 443. PCP's Settings page explains both. " +
        (process.platform === "win32"
          ? "If Windows asks whether to allow PCP through the firewall, allow it on private networks."
          : ""),
    })
  }
}

async function changePort() {
  const choice = await dialog.showMessageBox(window ?? undefined, {
    type: "info",
    message: `PCP listens on port ${settings.port}.`,
    detail: `To change it, put the port in the settings file and open PCP again:\n\n${settingsFile}\n\n{"port": 3001}\n\nAssistants connected to the old address need the new one.`,
    buttons: ["Show the settings file", "OK"],
    defaultId: 1,
    cancelId: 1,
  })
  if (choice.response === 0) {
    writeSettings(settingsFile, settings)
    shell.showItemInFolder(settingsFile)
  }
}

async function showFatal(message, detail) {
  await dialog.showMessageBox({
    type: "error",
    message,
    detail,
    buttons: ["Quit"],
  })
}
