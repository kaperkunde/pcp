# PCP for Mac and Windows

The desktop app is the production server in a window. It runs the same
`next build --output standalone` the Docker image runs (staged into the app
by `scripts/stage.mjs`, copying exactly what the Dockerfile copies) in an
Electron utility process, opens a window on it, and keeps the data in the
system's application data folder:

| System  | Data (`PCP_DATA_DIR`)                    | Wrapper settings and log                                      |
| ------- | ---------------------------------------- | ------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/PCP/data` | `…/PCP/desktop.json`, `~/Library/Logs/PCP/server.log`         |
| Windows | `%APPDATA%\PCP\data`                     | `%APPDATA%\PCP\desktop.json`, `%APPDATA%\PCP\logs\server.log` |
| Linux   | `~/.config/PCP/data`                     | `~/.config/PCP/desktop.json`, `~/.config/PCP/logs/server.log` |

`data/` is the vault (`pcp.db` and the request log), the same files a Docker
volume holds; back it up like one. Nothing of PCP is changed or duplicated
for the app: a change to the web app reaches the desktop app through
`pnpm build`, and `main.mjs` only knows the server's port, data directory and
health check, and on a Mac keeps the Touch ID key (below) without reading
it.

## What the wrapper adds

- **Localhost by default.** The server's port (3000) listens on `127.0.0.1`
  until **Accept connections from other devices** is turned on in the PCP
  menu, then on `0.0.0.0`, for other devices on the home network. Reaching
  PCP from the internet needs neither: a tunnel (Cloudflare Tunnel, Tailscale
  Funnel, ngrok) connects out, and PCP's built-in HTTPS (Settings), once
  turned on, listens on ports 80 and 443 on every interface by itself.
  Unlike the Docker image, the app leaves `PCP_HTTP_PORT` and
  `PCP_HTTPS_PORT` at 80 and 443: macOS and Windows let an ordinary program
  use them, and a router forwards to them as they are. Settings explains
  both ways while PCP's address is a home one.
- **Keeps running.** On Windows and Linux, closing the window hides it; the
  tray icon opens or quits PCP. On macOS the Dock does the same. Assistants
  keep reaching the gateway while the window is closed. **Start PCP when
  you sign in** (macOS and Windows) registers it as a login item.
- **One instance.** A second start brings the first one's window up.
- **Port.** 3000, like everywhere else. **Change the port…** in the menu
  explains how: `{"port": 3001}` in `desktop.json`, then open PCP again. A
  `PORT` in the environment is used when the file does not set one.
- **Failures are said.** If the port is taken or the server exits, a dialog
  says so and points at the log.
- **Touch ID** (macOS, with Touch ID set up). Turned on in PCP's Settings,
  or with the box under the password on the sign-in page, which takes the
  password once. PCP then makes a key of its own for the app (not the
  password; `lib/core/device-keys.ts`). A release built with PCP's
  provisioning profile keeps it in a keychain item macOS opens only for a
  fingerprint (`native/keychain`, below); anything else keeps it in
  `…/PCP/touch-id.bin`, encrypted with `safeStorage` under a key macOS keeps
  in the login keychain for this app, and checks the fingerprint itself
  (`touch-id-store.mjs` decides). From then on the sign-in page asks for
  Touch ID as it opens, and so does the password step of a new API token,
  an export and a restore; the password stays there for when Touch ID is
  not given. A new password and a new recovery key still take the password.
  PCP's pages reach it through the window's preload (`preload.cjs`,
  `window.pcpDesktop`), on PCP's own address only; `touch-id.mjs` checks
  that again, shows the system prompt and answers. ARCHITECTURE.md ("Touch
  ID in the Mac app") has the rest.
- **Fuses.** `electron-builder.yml` flips Electron's fuses in the packaged
  app: it cannot be run as plain Node, with `NODE_OPTIONS` or under the
  inspector, which is what keeps another program from using its keychain
  item; and the window's cookies, PCP's sign-in among them, are encrypted
  under that keychain key instead of sitting in plain text next to the
  vault. Cookie encryption is one way, so the fuse stays on. A sign-in from
  before it is encrypted the next time PCP writes it: lock and unlock once
  to do that at once.
- **Updates from Settings.** See "Updating" below.
- **No Chromium inside.** The Docker image carries one for the browser; the
  app does not. It uses one on the machine (`PCP_BROWSER_EXECUTABLE`, or
  where Playwright installs it), or the one **Install Chromium** on the
  Browser page downloads into the data folder (`browsers/`).

## Building it

```bash
# At the repository root. The hoisted linker lays node_modules out flat, so
# the standalone output holds files rather than pnpm's symlinks (an
# installer cannot carry those).
pnpm install --frozen-lockfile --config.node-linker=hoisted
pnpm db:generate
pnpm build

cd desktop
pnpm install                 # Electron and electron-builder, this folder only
pnpm start                   # stage the server and open the app from here
pnpm dist                    # an installer for this machine (dist/)
pnpm dist --arch x64         # another arch of this OS
pnpm dist --dir              # an unpacked app, for a quick look
```

`scripts/stage.mjs` writes `./server` and swaps better-sqlite3's native
binary for one built against Electron's Node (better-sqlite3 publishes one
per Electron version; it compiles one when there is none). Electron is
pinned to the newest major those binaries exist for; raising it means
checking that first (`scripts/stage.mjs` compiles from source when it has
to, which needs Python and a C++ toolchain).

This folder is its own pnpm project (`pnpm-workspace.yaml` here makes it
one) so that `pnpm install` at the root, in the Dockerfile and in CI, never
downloads Electron.

## Releases

`.github/workflows/release.yml` builds the app for macOS (Apple silicon and
Intel) and Windows on every release and attaches the installers to the
GitHub Release under stable names, so `releases/latest/download/…` always
points at the current one:

- `PCP-mac-arm64.dmg`, `PCP-mac-x64.dmg`
- `PCP-windows-x64.exe`

and beside them the files the app's updater reads (below):
`PCP-mac-arm64.zip`, `PCP-mac-x64.zip`, `latest-arm64-mac.yml`,
`latest-x64-mac.yml` and `latest-x64.yml`.

## Updating

PCP checks once a day whether a newer release is out (the app's server does
it, as any PCP does) and says so in its header and under **Settings →
Updates**. In the app that page offers **Install and restart**; the menu's
**Check for updates…** opens it.

The update does not go through the window's bridge (`preload.cjs`, which is
for Touch ID alone): the button only records the owner's request, and the
server repeats it in `/api/health` (only in the app, and only for a quarter
of an hour). `main.mjs` reads that every 15 seconds; a
request made after the app started, for a version later than its own, has
electron-updater download the release and restart into it
(`updates.mjs` holds the parts that decide, with their tests). A request is
acted on once, and one from before the app started never is, so an update
that fails cannot loop: the app says why and offers the download page.

Where it downloads from is `publish` in `electron-builder.yml`: the latest
GitHub Release, under the stable names the workflow uploads. The two Mac
builds would both write `latest-mac.yml`, so `dist.mjs` gives each
architecture a channel of its own (`latest-arm64`, `latest-x64`), and the
app asks for its own. The files keep their names from one release to the
next, so updates download whole rather than as a difference.

macOS lets an update replace an app only when both carry the same real
signature. A build without a Developer ID certificate is signed ad hoc and
cannot, so `dist.mjs` writes `pcpUpdater: "manual"` into it and the page
links to the download instead of offering the button. Windows installs an
unsigned update. A checkout (`pnpm start`) never updates itself.

### Signing

Releases are signed on macOS: the repository holds the macOS secrets below,
so both Mac apps carry PCP's Developer ID signature, are notarized, and open
without a warning. The Windows secrets are not set, so the installer is
unsigned and SmartScreen needs **More info → Run anyway**. The README says so
where the links are.

Without certificates (a fork, or `pnpm dist` in a checkout) a build is not
signed by anyone, deliberately (`CSC_IDENTITY_AUTO_DISCOVERY=false`). On
macOS it is signed ad hoc instead: Apple silicon will not run an app without
a valid signature, and calls a download with a broken one "damaged", with no
way past it. An ad-hoc signature gets the ordinary warning; open the app
once, then System Settings → Privacy & Security → **Open Anyway**.

The workflow signs with whatever of these repository secrets exist:

| Secret                                                     | Used for                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                             | The macOS Developer ID Application certificate, as a base64 `.p12` and its password   |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                     | The Windows code signing certificate, as a base64 `.pfx` and its password             |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization on macOS; `scripts/dist.mjs` turns it on when all three are set          |
| `MAC_PROVISIONING_PROFILE`                                 | The Developer ID provisioning profile for Touch ID's keychain item, as base64 (below) |

The Developer ID signature also lets an update keep using the keychain item
that holds the Touch ID key and the cookies' key: macOS recognises each
release as the same app. An ad-hoc signed build is a stranger to it after
every rebuild: macOS asks once for the Mac's password (**Always Allow**), and
if that is denied the app is signed out and forgets its Touch ID key.

Each platform signs only with its own certificate: `scripts/dist.mjs` keeps
`CSC_LINK` away from the Windows build, where electron-builder would otherwise
fall back to it and sign the installer with an Apple certificate Windows does
not trust.

### Touch ID's keychain item

`native/keychain` is a small Node-API module in Objective-C that keeps the
Touch ID key in the data-protection keychain, as an item made with
`kSecAccessControlBiometryCurrentSet`: macOS opens it only for a
fingerprint, to any process. `scripts/keychain.mjs` builds it for one Mac
architecture into `native-staged/` (empty elsewhere), `dist.mjs` and
`pnpm start` run it, and CI builds both architectures and loads one
(`ci.yml`, "Touch ID keychain module").

The data-protection keychain needs the `keychain-access-groups`
entitlement, and a Developer ID app may carry it only with a provisioning
profile that grants it. Making one, once, in the Apple Developer account
that holds the Developer ID certificate:

1. **Certificates, IDs & Profiles → Identifiers**: an App ID for macOS,
   explicit, `com.kaperkunde.pcp` (no capabilities to tick).
2. **Profiles → +** → Distribution → **Developer ID** → that App ID → the
   Developer ID Application certificate `CSC_LINK` holds → a name such as
   "PCP Developer ID" → download the `.provisionprofile`.
3. `base64 -i PCP_Developer_ID.provisionprofile | pbcopy`, and save it as
   the repository secret `MAC_PROVISIONING_PROFILE`.

The next release then logs "Touch ID: a keychain item macOS opens only for
a fingerprint". `dist.mjs` checks the profile first and stops the release
over one that is not Developer ID, not for this app or `APPLE_TEAM_ID`, does
not grant the keychain group, or has less than a year left (they are made
for 18): macOS will not start an app whose profile does not cover its
entitlements. Only the app is signed with the keychain group; its helpers
keep `build/entitlements.mac.plist`, for the same reason. Without the
secret, releases build as before and Touch ID uses the file.
