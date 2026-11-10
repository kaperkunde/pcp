# Installing and running PCP

The [README](../README.md#quick-start) has the quick start. This page covers the rest.

## On your own computer

Download the app and open it. It runs PCP on your computer, keeps the vault in
your user folder, and opens a window on it. An assistant on the same computer
reaches it at `http://localhost:3000/mcp`; if another program uses port
3000, **Change the port…** in the app's menu says how to pick another.

- **Mac**:
  [Apple silicon](https://github.com/kaperkunde/pcp/releases/latest/download/PCP-mac-arm64.dmg) ·
  [Intel](https://github.com/kaperkunde/pcp/releases/latest/download/PCP-mac-x64.dmg)
- **Windows**:
  [Installer](https://github.com/kaperkunde/pcp/releases/latest/download/PCP-windows-x64.exe)

The Mac apps are signed and notarized, so they open like any other app. The
Windows app is not signed yet, so its first start needs a nod: SmartScreen →
**More info** → **Run anyway**.

The app answers this computer only until you turn on **Accept connections
from other devices** in its menu. It keeps running when you close its window
(quit from the menu, or the tray icon on Windows) and can start when you sign
in. Its data is in `~/Library/Application Support/PCP` on a Mac and
`%APPDATA%\PCP` on Windows; back that folder up like a Docker volume. When a
new version is out, PCP says so in its header, and **Install … and restart**
under **Settings → Updates** downloads it and restarts the app. A Mac app that
is not signed with a developer certificate cannot replace itself, so there the
page links to the download instead; open it, and your vault stays where it is.

On a Mac with Touch ID, **Settings → Touch ID** (or the box on the sign-in
page) lets you unlock PCP with your fingerprint, and confirm a new API token,
an export, a restore or deleting the vault with it instead of your password.
A new password or recovery key still takes the password, and recovering with
the recovery key, signing out everywhere, a restore or deleting the vault
turns Touch ID off.

**From outside your home.** An assistant that runs elsewhere (Claude on the
web, a phone) needs an address that reaches your computer from the internet,
which a home router does not give it on its own. While PCP is at a home
address, its **Settings** page explains the two ways:

- **A tunnel** (Cloudflare Tunnel, Tailscale Funnel, ngrok) runs on your
  computer, needs no router changes, works on shared (CGNAT) connections and
  comes with `https`. The easier way.
- **PCP's own Dynamic DNS and HTTPS**, with ports 80 and 443 forwarded on your
  router to this computer, as in
  [the self-hosting guide](self-hosting.md#4-reach-pcp-from-outside-your-home-optional).
  The app opens those ports itself once HTTPS is on; Windows asks to let it
  through the firewall.

## On a Linux server, with Docker or Podman

New to self-hosting? **[The self-hosting guide](self-hosting.md)** walks
through it step by step, from installing Docker to reaching PCP from your phone
over HTTPS.

```bash
curl -fsSL https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh | sh
```

The installer finds Docker or Podman on the computer (Bazzite and other
Fedora Atomic systems come with Podman), pulls the published image
(`ghcr.io/kaperkunde/pcp`), checks its signature, and keeps PCP running on
port 3000 across reboots:
as a container Docker restarts, or as a systemd unit under Podman. It never
runs `sudo` or installs Docker for you; when neither is usable, it prints what
to run. Run the same line again to update PCP, or choose **Install and
restart** under **Settings → Updates** when PCP says a new version is out.
Run it once with `PCP_AUTO_UPDATE=1` (`… | PCP_AUTO_UPDATE=1 sh`) to have it
update PCP by itself once a day. The top of [`install.sh`](../install.sh) lists its settings
(`PCP_PORT`, `PCP_HTTPS`, `PCP_AUTO_UPDATE`, `PCP_UPDATE_BUTTON` and a few
more); it remembers
them in `~/.config/pcp/install.conf` (`/etc/pcp/install.conf` as root), so a
later run keeps them. The installer also passes the host's `TZ` and `LANG`
into the container, which the browser takes as its time zone and locale, and
the graphics card's render node (`/dev/dri`) where the host has one, so the
browser draws with an AMD or Intel card rather than in software
([self-hosting guide](self-hosting.md#the-browser-and-the-graphics-card)).
`… | sh -s -- uninstall` removes PCP and keeps your data.

From a checkout, `docker compose` does the same with the file in it:

```bash
git clone https://github.com/kaperkunde/pcp.git
cd pcp
docker compose up -d
```

Open http://localhost:3000 (the installer also prints the address other
devices on your network use, unless it was run with `PCP_HTTPS=1`, which
keeps port 3000 on that computer only). The first visit shows the setup page, and the
first person to open it becomes the owner: pick your name and a password.
You will be shown a **recovery key** once — store it in a password manager.
There is no password reset without it, because there is nothing on the
server that could reset it.

For anything beyond your own machine, PCP needs HTTPS: most OAuth servers
require an `https` redirect URL, and the session cookie is only marked
`Secure` over TLS. Either way works:

- **PCP's own HTTPS.** In the step after setup, or later under Settings, turn
  on **Dynamic DNS** (DuckDNS, No-IP, Dynu, Cloudflare or any update URL) to
  keep a name pointed at a home connection, and **HTTPS** to get and renew a
  Let's Encrypt certificate. Start PCP with the ports it needs and forward 80
  and 443 on your router:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh | PCP_HTTPS=1 sh
  # or, from a checkout:
  docker compose -f docker-compose.yaml -f docker-compose.https.yaml up -d
  ```

  With HTTPS on, port 3000 (plain HTTP) is published on `127.0.0.1` only,
  so the host's firewall cannot be bypassed by it; set PCP up from that
  computer, or through an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 you@server`
  and http://localhost:3000). Without HTTPS it stays on every interface,
  for your home network.

- **Your own proxy** (Caddy, Traefik, nginx, Coolify) in front of port 3000,
  passing `X-Forwarded-Proto`. Leave both settings off; they are off until
  turned on, and nothing extra listens or runs.

The data lives in the `pcp-data` volume (`/data` in the container): the
SQLite database, the request log and, with HTTPS on, the certificate. Back
that up; nothing else holds state.

## Without Docker

```bash
pnpm install
pnpm db:generate
pnpm build
pnpm start          # http://localhost:3000, data in ./data
```

`PCP_DATA_DIR` moves the data directory; `PORT` changes the port. Neither is
required. To update, `git pull` and run the first three commands again, then
start it.

## Knowing when to update

PCP asks GitHub once a day which release is the latest, and says so in its
header when a newer one is out. **Settings → Updates** shows what it found,
with the release notes, and says how to update the PCP you are looking at:
the app, the container or a checkout. The Mac and Windows app and the Linux
installer can install it from there (**Install and restart**). GitHub sees this
PCP's address and version, nothing else. Turn the daily check off there (or in
the step after setup) and PCP asks only when you choose **Check now**. In a
container or a checkout PCP never pulls, builds or restarts itself; only the
installer does that for a container, when you press **Install and restart**
or with its daily update (`PCP_AUTO_UPDATE=1`, above), and the page says
which.

## Cleanup

PCP removes what it keeps only for a while (ended sign-ins, apps' expired
sign-in tokens, results kept for a day, old permission requests, days of the log older than you keep) when it
starts and then every hour. **Settings → Cleanup** changes when it runs (a
preset, or five cron fields of your own, at least once a day), how many days
of the log it keeps (90 unless you choose), shows what the last run removed,
and cleans up at once with **Clean up now**. After each run PCP gives the
disk back what was freed: once enough of the database is empty space (32 MB,
or a quarter of it), it rewrites the file without it.

## Resources

How much of the machine PCP may use for what assistants hand it follows the
machine: its memory (a container's limit, where it has one), its processors
and the free disk where PCP keeps its data. **Settings → Resources** shows
what PCP picked and lets you set each yourself: a `run_code` program's memory
(a sixteenth of the machine's, 128 MB to 1 GB), how many programs run at once
(no more than the processors, and half the memory together), the largest file
PCP keeps for an assistant and so what a program reads of one (an eighth of a
program's memory, 10 to 256 MB), and what one token's kept results may hold
together (a twentieth of the free disk, 50 MB to 4 GB). It also sets how long
the browser stays open with nothing happening (an hour, 5 minutes to 8 hours):
an open browser holds memory. PCP refuses settings
that would let programs together hold more than three quarters of the
machine's memory, or kept results more than the disk.

## Starting over or uninstalling

**Settings → Delete vault** deletes everything PCP holds (servers, API
endpoints, mail and calendar accounts, secrets, API tokens, memories, the browser's
sign-ins, the request log, your password and recovery key) once you tick the
box and confirm with your password or Touch ID. PCP is then back at its setup
page. This machine's settings (pcp.gg, Dynamic DNS, HTTPS, updates, cleanup,
resources) stay; turn them off first if you want them gone. Export first if
you may want anything back: there is no undo. Until you set PCP up again, the
first person to open it becomes its owner.

To remove PCP itself:

- **Mac**: if you use Touch ID, turn it off under **Settings → Touch ID**
  first, so the app forgets its key. In the PCP menu, turn off starting at
  sign-in, then quit PCP from the menu (closing the window leaves it
  running), and drag PCP from Applications to the Trash. Your vault stays in
  `~/Library/Application Support/PCP`; delete that folder and
  `~/Library/Logs/PCP` to remove it too, and the **PCP Safe Storage** item in
  your login keychain (Keychain Access) if you want nothing left.
- **Windows**: turn off starting at sign-in in the PCP menu and quit PCP from
  the tray icon, then uninstall it under **Settings → Apps → Installed apps**.
  The uninstaller keeps your vault in `%APPDATA%\PCP`; delete that folder to
  remove it too.
- **Linux, from the installer**: run it with `uninstall`. It removes the
  container, the systemd unit under Podman, its update timers and its
  settings file, and keeps the `pcp-data` volume, your vault:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh | sh -s -- uninstall
  docker volume rm pcp-data              # the vault too (podman volume rm pcp-data)
  docker image rm ghcr.io/kaperkunde/pcp # the image (podman image rm …)
  ```

  If the installer gave you crontab lines to update PCP (on a machine
  without a systemd session), remove them with `crontab -e`.

- **From a checkout with `docker compose`**: `docker compose down` stops and
  removes PCP and keeps the vault; `docker compose down -v` deletes the
  `pcp_pcp-data` volume with it. Then delete the checkout.
- **Without Docker**: stop `pnpm start` and delete the checkout. The vault is
  in `./data`, or wherever `PCP_DATA_DIR` points.
