# PCP for Mac and Windows

The desktop app is the production server in a window. It runs the same
`next build --output standalone` the Docker image runs (staged into the app
by `scripts/stage.mjs`, copying exactly what the Dockerfile copies), opens a
window on it, and keeps the data in the system's application data folder:

| System  | Data (`PCP_DATA_DIR`)                    | Wrapper settings and log                                      |
| ------- | ---------------------------------------- | ------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/PCP/data` | `…/PCP/desktop.json`, `~/Library/Logs/PCP/server.log`         |
| Windows | `%APPDATA%\PCP\data`                     | `%APPDATA%\PCP\desktop.json`, `%APPDATA%\PCP\logs\server.log` |
| Linux   | `~/.config/PCP/data`                     | `~/.config/PCP/desktop.json`, `~/.config/PCP/logs/server.log` |

`data/` is the vault (`pcp.db` and the request log), the same files a Docker
volume holds; back it up like one. Nothing of PCP is changed or duplicated
for the app: a change to the web app reaches the desktop app through
`pnpm build`, and `main.mjs` only knows the server's port, data directory and
health check.

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
  you sign in** registers it as a login item.
- **One instance.** A second start brings the first one's window up.
- **Port.** 3000, like everywhere else. **Change the port…** in the menu
  explains how: `{"port": 3001}` in `desktop.json`, then open PCP again. A
  `PORT` in the environment is used when the file does not set one.
- **Failures are said.** If the port is taken or the server exits, a dialog
  says so and points at the log.

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

### Signing

Without certificates the builds are not signed by anyone, deliberately
(`CSC_IDENTITY_AUTO_DISCOVERY=false`). On macOS they are signed ad hoc
instead: Apple silicon will not run an app without a valid signature, and
calls a download with a broken one "damaged", with no way past it. An ad-hoc
signature gets the ordinary warning; the owner opens the app once, then
System Settings → Privacy & Security → **Open Anyway**. Windows SmartScreen
needs **More info → Run anyway**. The README says so where the links are.

To sign, add repository secrets and the workflow picks them up:

| Secret                                                     | Used for                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                             | The macOS Developer ID Application certificate, as a base64 `.p12` and its password |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                     | The Windows code signing certificate, as a base64 `.pfx` and its password           |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization on macOS; `scripts/dist.mjs` turns it on when all three are set        |

Each platform signs only with its own certificate: `scripts/dist.mjs` keeps
`CSC_LINK` away from the Windows build, where electron-builder would otherwise
fall back to it and sign the installer with an Apple certificate Windows does
not trust.
