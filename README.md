<p align="center">
  <img src="public/icons/icon-512.png" alt="The PCP logo: a lightning-blue letter P with coloured data streams flowing into it" width="200" height="200">
</p>

<h1 align="center">PCP - Primary Control Provider</h1>

<p align="center">
  <strong>One endpoint for every MCP server you use.</strong><br>
  Self-hosted, with your secrets kept encrypted on your side.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-5ed3c3?style=flat-square&labelColor=131720"></a>
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-docker%20compose-5ed3c3?style=flat-square&labelColor=131720">
  <img alt="Single user" src="https://img.shields.io/badge/vault-single%20user-5ed3c3?style=flat-square&labelColor=131720">
</p>

<p align="center">
  <a href="#run-it">Run it</a> ·
  <a href="docs/self-hosting.md">Self-hosting guide</a> ·
  <a href="#use-it">Use it</a> ·
  <a href="ARCHITECTURE.md">Architecture</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SECURITY.md">Security</a>
</p>

---

A self-hosted gateway between your AI assistant and the MCP servers you use.
PCP keeps the credentials those servers need in an encrypted store, signs in
to the ones that use OAuth, and exposes a single MCP endpoint built around
three tools — `search`, `describe` and `call_tool` — so an
assistant can reach dozens of servers without carrying every tool definition
in its context. You decide, per token and per tool, what an assistant may run
on its own, what it has to ask you about first, and what it cannot touch.

- **One endpoint for every server.** Add servers in the web UI; an assistant
  connects once, with an API token, and finds tools by describing what it
  needs.
- **Skills to follow.** Write down how you want a kind of task done (or
  import a `SKILL.md`) and every assistant finds it and follows it; an
  assistant's change to one waits for you to read it.
- **APIs without an MCP server.** Give PCP an OpenAPI schema, as a URL or a
  file, and each operation becomes a tool. PCP makes the HTTP calls itself,
  with your secret or OAuth sign-in, and hands the assistant the answer.
- **Web pages, on your terms.** A token can be given a `web_fetch` tool that
  reads public web pages as Markdown. You decide per method and per site, and
  every site an assistant tried is listed for you to allow or block.
- **Large answers that never reach the assistant.** A token can be given a
  `run_code` tool: a short JavaScript program, run inside PCP, that calls
  the token's tools and filters, counts or passes on what they answer. Every
  call follows the token's levels, and the program reaches nothing else.
- **A browser that keeps your sign-ins.** Add PCP's browser and an assistant
  can open pages, read them, click, type and fill in forms in a Chromium
  on the machine PCP runs on, signed in where you signed it in. You
  decide which sites each token opens, watch any tab live in PCP, and take it
  over for a sign-in or a CAPTCHA; an assistant can hand you a tab and wait.
  It can have PCP type one of your passwords or one-time codes into a page
  without ever seeing it, at the sites you allow.
- **Mail without an MCP server.** Add a mail account over JMAP (Stalwart,
  Fastmail, Cyrus) or IMAP with SMTP, or let an assistant propose one for you
  to agree to, and an assistant can search, read, file, draft and send its
  mail, with the same tools whichever protocol it speaks.
- **Calendars and reminders, iCloud's included.** Add a calendar account over
  CalDAV (iCloud with an app-specific password, Fastmail, Nextcloud) and an
  assistant can see what is on when, find free time, schedule, move and
  change events (one occurrence of a repeating one, or the series), and keep
  reminders, with the same tools for every account.
- **Commands over SSH, with a key.** Add an SSH server, put the key PCP makes
  for it in the login's `authorized_keys`, and an assistant can run commands
  there, each one shown to you first unless you allow it. No passwords; PCP
  pins the server's host key the first time it connects and refuses any
  other.
- **Secrets stay on your side.** API keys and OAuth tokens are encrypted at
  rest with a key the server does not hold. They are added to upstream calls
  by PCP; the assistant never sees them.
- **Nothing to configure.** Open the Mac or Windows app, or run one line on
  a Linux server and open the site; choose a password. No environment
  variables. Dynamic DNS and HTTPS with Let's Encrypt are built in for a home
  server, and off for anyone with a proxy.
- **Take it with you.** Export everything to one encrypted file and restore it
  on another PCP; your password, recovery key and API tokens keep working, so
  assistants carry on.
- **Single user, by design.** PCP is yours: one owner, one encrypted vault.

## Run it

### Quick start

1. **Start PCP**, whichever way suits you:
   - **On a Mac or a Windows PC**, download the app and open it:
     [Mac, Apple silicon](https://github.com/kaperkunde/pcp/releases/latest/download/PCP-mac-arm64.dmg) ·
     [Mac, Intel](https://github.com/kaperkunde/pcp/releases/latest/download/PCP-mac-x64.dmg) ·
     [Windows](https://github.com/kaperkunde/pcp/releases/latest/download/PCP-windows-x64.exe)
   - **On a Linux server** with Docker or Podman, run
     `curl -fsSL https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh | sh`
   - **From a checkout**, run
     `git clone https://github.com/kaperkunde/pcp.git && cd pcp && docker compose up -d`
2. **Open http://localhost:3000** (the app opens its own window, at 127.0.0.1; on a
   server, use the address the installer prints). Pick your name and a
   password, and store the **recovery key** you are shown in a password
   manager: it is shown once, and nothing else resets a password.
3. **Create a token** under **API tokens**. Copy it when it is shown; the
   page also gives you the command for Claude Code.
4. **Connect your assistant** to PCP's `/mcp` address with the token
   (`http://localhost:3000/mcp` on the same computer):

   ```bash
   claude mcp add --transport http pcp http://localhost:3000/mcp \
     --header "Authorization: Bearer pcp_…"
   ```

Then add the servers, APIs, mail and calendar accounts you use under **Servers**, or
ask the assistant to find one and propose it to you. The sections below have
the details, and how to reach PCP from outside your home.

### On your own computer

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
  [the self-hosting guide](docs/self-hosting.md#4-reach-pcp-from-outside-your-home-optional).
  The app opens those ports itself once HTTPS is on; Windows asks to let it
  through the firewall.

### On a Linux server, with Docker or Podman

New to self-hosting? **[The self-hosting guide](docs/self-hosting.md)** walks
through it step by step, from installing Docker to reaching PCP from your phone
over HTTPS.

```bash
curl -fsSL https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh | sh
```

The installer finds Docker or Podman on the computer (Bazzite and other
Fedora Atomic systems come with Podman), pulls the published image
(`ghcr.io/kaperkunde/pcp`) and keeps PCP running on port 3000 across reboots:
as a container Docker restarts, or as a systemd unit under Podman. It never
runs `sudo` or installs Docker for you; when neither is usable, it prints what
to run. Run the same line again to update PCP, or choose **Install and
restart** under **Settings → Updates** when PCP says a new version is out.
Run it once with `PCP_AUTO_UPDATE=1` (`… | PCP_AUTO_UPDATE=1 sh`) to have it
update PCP by itself once a day. The top of [`install.sh`](install.sh) lists its settings
(`PCP_PORT`, `PCP_HTTPS`, `PCP_AUTO_UPDATE`, `PCP_UPDATE_BUTTON` and a few
more); it remembers
them in `~/.config/pcp/install.conf` (`/etc/pcp/install.conf` as root), so a
later run keeps them. The installer also passes the host's `TZ` and `LANG`
into the container, which the browser takes as its time zone and locale.
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

### Without Docker

```bash
pnpm install
pnpm db:generate
pnpm build
pnpm start          # http://localhost:3000, data in ./data
```

`PCP_DATA_DIR` moves the data directory; `PORT` changes the port. Neither is
required. To update, `git pull` and run the first three commands again, then
start it.

### Knowing when to update

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

### Cleanup

PCP removes what it keeps only for a while (ended sign-ins, apps' expired
sign-in tokens, results kept for a day, old permission requests, days of the log older than you keep) when it
starts and then every hour. **Settings → Cleanup** changes when it runs (a
preset, or five cron fields of your own, at least once a day), how many days
of the log it keeps (90 unless you choose), shows what the last run removed,
and cleans up at once with **Clean up now**. After each run PCP gives the
disk back what was freed: once enough of the database is empty space (32 MB,
or a quarter of it), it rewrites the file without it.

### Resources

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

### Starting over or uninstalling

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

## Use it

1. **Secrets.** Add the API keys and personal access tokens your servers
   need. Each is stored encrypted and can be revealed, rotated or deleted.
2. **Servers.** Add an MCP server by URL, describe what it is for in a
   sentence, and choose how PCP authenticates to it: nothing, a secret in a
   header (`Authorization: Bearer {{secret}}` by default, with further
   headers when the credential has several parts), or OAuth. For
   OAuth, choose **Connect** on the server page: PCP discovers the
   authorization server, registers itself if it can, sends you to sign in
   and keeps the tokens as a managed secret. Many large providers (Google,
   Slack, GitHub and others) let no app register itself: PCP then says so,
   and you create an OAuth client in the provider's developer settings with
   the redirect URI the server form shows, and enter its client ID and
   secret. Some providers only keep you signed in when the sign-in asks for
   it: PCP adds what it knows (Google's `access_type=offline`) itself, and
   **Extra sign-in parameters** takes anything else. A server that refuses
   PCP shows why on its page. PCP reads each server's tool list; you can
   rewrite any tool's description so an assistant picks it correctly.
3. **API endpoints.** Add an API by giving PCP its OpenAPI 3 schema, as a URL or
   an uploaded JSON or YAML file. PCP turns each operation into a tool, with the
   arguments the schema describes, and tells you what it left out (cookies, for
   one). An operation that takes a file upload takes a file PCP kept for the
   assistant, such as an email attachment, by its handle. Choose a secret to
   send in a header (more than one, each in its own header, for an API that
   wants a key and a secret key), a user name and password (HTTP Basic
   authentication, which PCP encodes), or, for an API whose schema declares an
   OAuth sign-in (Google's, Microsoft Graph, Stalwart), **Connect**: PCP
   registers itself with the provider when it lets apps do that, and otherwise
   asks for your own OAuth client. **Read-only** offers only GET operations.
   Requests go to the base URL saved on the endpoint, which PCP never changes on
   its own when the schema does. A secret is only sent to an address you typed,
   or to the origin the schema was downloaded from, so with an uploaded file you
   enter the base URL yourself. **Edits** (a JSON Patch) fix or narrow a schema
   you do not control, and are kept when it is read again.

   One API on two hosts (Coolify on two machines, say) is one definition
   with two servers: **Clone** on a server's or endpoint's page makes
   another with its own address, secret and note, the same description,
   schema, edits and tool descriptions, and the first one's levels. A change
   to what they share reaches both, after PCP says which servers it changes;
   **Detach** gives one its own again. PCP offers to merge endpoints that
   already have the same schema. **Your note**, under About on any server or
   skill, is a private line about that one (which host, what it is for):
   assistants read it as your note beside the description, and it is never
   synced or shared.

4. **Mail accounts.** Add one over **JMAP** with its session URL (usually
   `https://<mail server>/.well-known/jmap`), signing in with a user name and an
   app password, a bearer token, or OAuth: choose **Connect** on its page, as
   for an OAuth server (PCP asks for `offline_access` itself when the server
   offers it, so it stays signed in). Or add one over **IMAP**, with an SMTP
   server to send through if it should send; PCP files a copy of what it
   sends in Sent only when the mail server did not file one itself, as Gmail
   and Outlook do (**Save a copy in Sent** in its settings: Automatic, Always
   or Never). Passwords and tokens are secrets
   you pick, and mail only travels encrypted (TLS, or STARTTLS on `imap://` and
   `smtp://`; a JMAP session URL is `https://`, or `http://` for a server on
   your own network only). Every account offers the same tools: list mailboxes, search one
   mailbox or all of them, read an email or an attachment (a text one as text,
   any other as a handle), move, flag, label (keywords) and delete into the
   Trash (never for good), many emails in one call, write a draft and send,
   create, rename and move folders and delete an empty one, plus conversations,
   identities and the automatic reply (out of office) on JMAP. A draft (`create_draft`) goes into
   the account's Drafts and is sent by nobody but you, so you can allow
   drafting and keep sending on **Ask you first**; it needs no SMTP server.
   The automatic reply counts as sending (the server sends the text to whoever
   writes in), so an account that cannot send has no tool to set it.
   **Read-only** offers only the tools that read. An
   assistant can propose an account too, with `register_server`: you see the
   server, the user name and how PCP signs in, type the app password on that
   page (it never passes through the assistant) or connect it with OAuth, and
   nothing exists until you agree.
5. **Calendar accounts.** Add one under **Servers → Add → Calendar account**:
   **iCloud** (`https://caldav.icloud.com`, your Apple ID and an
   [app-specific password](https://support.apple.com/102654), never your Apple
   ID password), **Fastmail**, or any other CalDAV server (Nextcloud,
   Radicale, Baïkal) by its address, signing in with a user name and password,
   a bearer token or OAuth. The password can be typed into the form, where it
   is saved under Secrets. PCP finds the calendars itself and sends your
   sign-in only to that host and, over `https://`, others of its domain (iCloud
   keeps each account's calendars on `p<n>-caldav.icloud.com`). Every account
   offers the same tools: list calendars and reminder lists, list events
   between two times (each occurrence of a repeating event on its own, in its
   own time zone across summer time), read one, find free time within working
   hours, create, change, move to another calendar and delete events (one
   occurrence, or the whole series), list, create, change and complete
   reminders (a repeating one moves on to its next due date), and make a new
   calendar or reminder list. Changes are written only over the copy PCP read
   (ETags), so nothing made in between is overwritten, and no tool invites
   anyone. **Read-only** offers only the tools that read. iCloud serves over
   CalDAV only the reminder lists it keeps as tasks: lists upgraded in Apple's
   Reminders app stay there. An assistant can propose an account with
   `register_server` (kind `caldav`), as for a mail account.
6. **SSH servers.** Add one with its host, port and the login PCP uses. PCP
   makes a key of its own for the server and shows it on the server's page:
   put it in that login's `~/.ssh/authorized_keys` and choose **Check
   sign-in**. PCP never uses a password. It pins the server's host key the
   first time it connects, shows its fingerprint for you to compare, and
   refuses any other key until you choose **Forget host key**. Its one tool,
   `run_command`, runs a command and returns the exit code, standard output
   and standard error; leave it on **Ask you first** and you see each command
   before it runs. Only you add SSH servers; an assistant cannot propose one.
7. **API tokens.** Create a token per assistant or machine; PCP asks for your
   password (or Touch ID in the Mac app) to make one. A token can reach every
   server and endpoint or only the ones you pick, and can expire. Revoking it
   destroys its copy of the vault key. A token's page sets each tool to
   **Allowed**, **Ask you first** (the default) or **Blocked**, a whole server
   at once, or copies all of it from another token. Tick **All tokens** beside a
   level to make it the one every token follows; a token's own level still wins
   over it.
8. **Connect an assistant** to `https://<your-pcp>/mcp`, in one of two ways.

   **With a token.** Give it the token as a bearer token. For Claude Code:

   ```bash
   claude mcp add --transport http pcp https://<your-pcp>/mcp \
     --header "Authorization: Bearer pcp_…"
   ```

   Any client that speaks MCP over Streamable HTTP with a static bearer token
   works the same way.

   **By signing in.** Apps that take only a URL, such as custom connectors in
   claude.ai (on the web, the desktop and the phone) and ChatGPT's developer
   mode, sign in with OAuth at PCP itself: add `https://<your-pcp>/mcp` as a
   connector, and the app sends you to PCP's own page. There you unlock PCP
   if it is locked, see which app asks and where PCP sends you back to,
   choose what its token may reach as for a new token, and confirm with your
   password (or Touch ID). The app gets a token of its own, listed under API
   tokens as signed in from that app, with its own levels, memories and
   request log, and revoking it there signs the app out. If the app signs in
   again later, you can give it the token it had. The app must reach PCP at a
   public https address (a pcp.gg name, or your own with HTTPS), and that
   address is PCP's public address under Settings; claude.ai identifies
   itself with its own metadata document, other apps register themselves.

The assistant then sees a short description of the servers behind the token
and these tools:

| Tool                  | What it does                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`              | Finds tools across servers, your skills, and the memories the token reads, from a few words ("create a github issue"), each with a ref for `describe`.                                        |
| `list_tools`          | Lists every tool on one server, with whether it runs at once or asks you first, a page of 200 at a time.                                                                                      |
| `describe`            | For a tool, its full description, JSON Schema, whether it asks you first, for an API what it answers, and the `call_handle` that calls it; for a skill or a memory, its text.                 |
| `call_tool`           | Runs the tool a `call_handle` stands for, after checking the arguments against its schema, with PCP adding the credentials; `fields`, `decode` and `keep` shape a long JSON answer.           |
| `call_read_only_tool` | `call_tool` for a tool its server marks read-only (an API's GET, a mail search, an MCP tool with `readOnlyHint`); anything else is refused.                                                   |
| `check_permission`    | Says how a request went once you have answered it; waits a little if you are still on it. Without an id, lists the token's own requests still waiting for you.                                |
| `withdraw_request`    | Takes back one of the token's own requests while it still waits for you: it leaves your list, and nothing runs.                                                                               |
| `check_server`        | Says whether a server is connected; waits a little if you are still signing in.                                                                                                               |
| `read_result`         | Reads a long answer or a kept value, a slice at a time from any offset or from where a text appears; a file is described, not shown.                                                          |
| `register_server`     | Proposes a new MCP server, an API from an OpenAPI 3 schema, a mail account (JMAP or IMAP) or a calendar account (CalDAV), with no auth, a secret by name, a user name and password, or OAuth. |
| `propose_tool_access` | Proposes which tools its token may run, many at once and across servers, and hears which tools would change; you review and save it in PCP.                                                   |

Options on a token's page, each off until you tick it, add more tools,
described further down:

| Tool              | Option (**Let an assistant with this token …**)     | What it does                                                                                                                               |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_endpoint`    | **read and change API endpoints**                   | Reads an endpoint's settings and tools, its edits, one part of its schema at a time, and likely mistakes in it with fixes to make.         |
| `update_endpoint` | **read and change API endpoints**                   | Changes an endpoint's name, description, schema or edits, base URL, read-only setting or tool descriptions, or reads its schema URL again. |
| `list_secrets`    | **read and change API endpoints**                   | Lists your secrets by name, with what uses each, so an assistant can name one when it proposes an endpoint; never a value.                 |
| `memory`          | **keep memories**                                   | Keeps notes under `/memories` that last between conversations and follow you from one assistant to the next.                               |
| `read_memory`     | **keep memories**                                   | Reads those notes (`every`, `view`, `search`) and nothing else.                                                                            |
| `web_fetch`       | **fetch web pages**                                 | Fetches an address and returns the page as Markdown, a part at a time; with a method, headers and a body, other requests too.              |
| `run_code`        | **run code that calls its tools**                   | Runs a program that calls the token's tools and works on their answers inside PCP.                                                         |
| `share_result`    | **move files to and from its own computer by link** | A link the assistant's own computer downloads a file PCP keeps for it from with curl (a browser download, a mail attachment).              |
| `receive_file`    | **move files to and from its own computer by link** | A link its own computer sends one file to with curl, and the handle the file is then kept under.                                           |

The **Log** page lists what assistants did with their tokens: every call,
by token, tool and server, how long it took and whether it was done, failed
or asked you (with how you answered). Never what they sent or what came back.
Filter it by token, outcome or name; each token's page links to its own.

A shortened answer (a JSON preview, a long text cut off, a long email) ends
with a result id. PCP keeps the whole of it, encrypted, for a day, for the
token that asked, and `read_result` reads it from any offset or from the
first place a text appears.

Files and long values move between tools without passing through the
assistant. A file in an answer (an attachment, an image, base64 that decodes
to a PDF) and any part named in `keep` come back as a handle,
`{"$result": "<id>", …}`, with its type and size. Put that handle in any later
call's arguments and PCP puts the value there: a text as text, a file as
base64. `get_attachment` reads any attachment that way, and `send_email` and
`create_draft` take handles as attachments, so an attachment from one mail
account can be sent from another, or handed to an API. The permission page
shows what each handle is, never its content. A `call_tool` answer also links
its handles as MCP resources (`pcp://results/<id>`), so a client that reads
resources can open a kept file itself.

A tool you have not decided about answers "Not done yet" and asks you: the
assistant ends its reply with a link to the request in PCP. Answer there,
tell it you have, and it carries on. The bell at the top of every page in
PCP shows how many requests are waiting and lists them, oldest first, so you
can answer one without the link; once you answer one, PCP opens the next one
waiting, with what came of your answer above it, until nothing is left.
**Allow once** runs that one call, **Always allow** and
**Block** also decide the calls after it, **Allow for** (15 minutes, an hour or
eight hours) lets the calls after it run without asking until that time is up,
and **Not now** runs nothing. What you allowed for a while is listed on the
token's page under **Allowed for now**, where **End now** takes it back; it
changes none of the token's settings and never lifts a block. A
server, API, mail or calendar account an assistant proposes is only added once you
agree; an OAuth one is then connected from a link to its page in PCP, where
PCP registers itself with the provider if the provider lets apps do that.

An assistant can also help with a large set of tools: `propose_tool_access`
takes levels for many tools at once, by name or by pattern (`list_*`), and
hands you a link to a page in PCP with its levels filled in and each change
marked. Nothing changes until you save there, and you can change any level
first, so an assistant can suggest but never raise its own access.

An assistant can write an OpenAPI schema from an API's documentation and hand
it to `register_server` as text, or name a schema's URL. You see what it asked
for before anything is added: the address, how many tools and which
operations, whether it can change things, and the secret it would send. A
secret PCP does not hold yet, an API key or the password for a user name, is
typed in by you on that page, so its value never passes through the
assistant. An API added that way reaches public addresses only until you
allow private ones on the endpoint's page.

With **read and change API endpoints**, `get_endpoint` and `update_endpoint`
let an assistant fix an endpoint's schema, but what it can do there is
narrower than what you can. It can change an endpoint it registered only
while nothing of yours is attached to it (no secret or OAuth sign-in, public
addresses only), and a change disables the endpoint until you enable it
again, because the words it writes reach every other assistant. It can send
a whole new schema only to an endpoint it registered as text, and never
sees a secret's value or chooses or changes a secret afterwards.
`list_secrets` shows it your secrets' names and what uses each, so it can
name one you already have when it proposes an endpoint; you are shown what
already uses it. Once an endpoint sends your secret or OAuth token, or you allow private addresses, it is yours: an assistant can
read it and turn read-only on, and it can ask you to fix the schema with
edits, rename it, reword its tools or read its schema URL again. You are shown
every edit and description in full and what it does to the tools, and nothing
changes unless you agree. Its address and secret stay yours alone. Leave the
option off for a token that does not need it.

A token made with **Let an assistant with this token keep memories** gets a
`memory` tool: notes that last between conversations and stay with you rather
than with one app. It works like Claude's own memory tool (files under
`/memories`: view, create, str_replace, insert, delete, rename, plus search
and every), with `read_memory` for the reading commands alone, and PCP's instructions, modelled on the protocol Claude's own
memory tool uses, tell the assistant to look there before anything else and to
save what you would not want to say twice as it goes. Before its first reply
it calls `every` through `read_memory`, which returns the memories you chose to have read in every
conversation and lists the rest.

- `/memories/…` is the assistant's own: only the token that wrote a memory
  reads it, and writing one needs no answer from you.
- `/memories/shared/…` is read by every assistant whose token keeps memories.
  An assistant that wants to share a memory, or change, rename or delete a
  shared one, has to ask, the same way a tool asks: you see the whole text (a
  shared memory is at most 2,000 characters) with a warning about what to look
  for, and choose **Share it**, **Keep it for this assistant only** or
  **Discard it**. Nothing is written before you answer.

Text with characters that do not show on screen is refused, so what you read
is all there is. The **Memories** tab lists every memory with the token that
wrote it; you can add shared ones yourself, and edit, move or delete any of
them. Tick **Read in every conversation** on one (up to 2,000 characters) and
its text comes with PCP's instructions, so an assistant has it before it does
anything rather than when it thinks to look; a shared one reaches every
assistant, one an assistant keeps reaches only that one. If an assistant
changes one it keeps, it is no longer read in every conversation until you
tick it again. To change many at once, tick them (each has a box, each list
and the top of the page have a **Select all**) and choose who reads them: **All
tokens** shares them, **Only** a token keeps them for that token alone (it must
be one that keeps memories), and **Delete selected** deletes them. Nothing is
changed if a path would be taken where they go. A memory that changes hands
loses its mark to be read in every conversation, since you chose that for its
old readers. Memories are encrypted like everything else.

PCP's instructions also tell an assistant that keeps memories that you keep
your memories and skills in PCP, so it saves new ones there rather than in
its app's own memory. To bring over what an app already keeps, each such
token has **Memory migration**, which starts on. While it is on, the assistant looks for what its app keeps
about you (its memory or saved preferences, your own instruction files such
as a personal `CLAUDE.md`, skills of your own; never a project's), tells you
what it found and asks before moving anything. It moves each into PCP
keeping its structure (a skill as a skill change you agree to), reads each
back, and asks you again before deleting the originals: it deletes them
itself where its app lets it, and otherwise tells you exactly what to remove.
Then it turns **Memory migration** off with the `memory` tool's
`migration_done`, as it does at once when it sees nothing to move or you say
no. An assistant can only turn it off; the switch under **Keep memories** on
the assistant's page turns it on again, to have it look once more.

**Skills** are procedures you approve: how you want a kind of task done,
step by step, written as a `SKILL.md` the way Claude's Agent Skills are (a
name, a line on when to use it, the `server/tool` names it uses, and
Markdown steps, with a few reference files beside it; nothing in one is ever
run). A memory is a note an assistant weighs; a skill is one it follows when
the task matches. Write one under **Skills**, or paste a `SKILL.md` to import
it, and every assistant sees its name and description in PCP's
instructions, finds it with `search` and reads it whole with `describe`,
which also hands it the `call_handle` of each tool the skill names. On an
assistant's page you choose whether it sees every skill or only some. An
assistant that keeps memories can propose a new skill or a change through
the `memory` tool, under `/skills/<name>/SKILL.md`; you see what changes line
by line and the whole skill as it would be, and nothing is written until you
agree, and then only if nobody changed the skill in the meantime. Each change
is a new version.

A token made with **Let an assistant with this token fetch web pages** gets a
`web_fetch` tool, like the web fetch Claude has: it takes an address and
returns the page, HTML as Markdown (or as it is, if asked), JSON
pretty-printed and text as it is, 20,000 characters at a time unless it asks
for up to 50,000. With a method, headers and a body it can send other
requests too. What it may do is on the token's page:

- **Methods.** GET, POST, PUT, PATCH, DELETE and Other methods, each
  **Allowed**, **Ask you first** (the default) or **Blocked**. They decide
  for every site that has no level of its own.
- **Sites.** Every site an assistant with the token tried to reach is listed
  the first time it tries, set to **Use the method settings**, and asks you
  then unless that method is allowed. Give a site a level of its own and it
  decides every request there, whatever the method. You can add a site before
  any assistant asks for it, and remove one.

A request that asks you offers **Allow once**, **Allow this site for** a
while, **Always allow this site**, **Block this site** and **Not now**. A site is its host: `example.com` and
`www.example.com` are two sites, and a redirect from one to the other is
reported to the assistant rather than followed, so you decide the second one
too. Every line, method or site, has an **All tokens** box like the tools do.

`web_fetch` reaches public addresses only, unless you set **Private
addresses** to **Allowed** on the token's page (a device at home, a service
on your network; an assistant cannot ask for it), and never PCP's own
address. It sends none of your secrets or cookies; it never sends an
Authorization or Cookie header at all. The sites a token reached are on its
page, not in the request log.

A token made with **Let an assistant with this token run code that calls its
tools** gets a `run_code` tool. The assistant sends a JavaScript program, the
body of an async function, which PCP runs in a sandbox of its own: QuickJS,
compiled to WebAssembly, with nothing of the machine it runs on. The program
calls the token's tools with `await pcp.call(server, tool, args)` and gets
each answer whole, as a value, so it can pick the ten rows the assistant needs
out of ten thousand, join two tools' answers, or hand a file from one tool to
another, and only what it prints and returns goes back to the assistant.
Files move as handles, as they do between calls (above); `pcp.keep` keeps a
text it made (a CSV, a report), or bytes, as a handle to pass on, and
`pcp.read(handle, { as: "base64" })` reads a file's bytes when the program
has to build something from them (a MIME message with an attachment). With
`keep`, a value one tool makes, such as a password a server generates, goes
into another tool's arguments as a handle, never read by the program or the
assistant. `pcp.tools()` lists the token's servers and tools, as `list_tools`
does. The program also has `atob`, `btoa`, `TextEncoder`, `TextDecoder` and
`crypto.getRandomValues`, so it can make a strong secret itself.

A large picture costs an assistant far more to look at than a small one, so
`pcp.image.compress(handle, { maxWidth, maxHeight, crop, grayscale, format,
quality })` makes a smaller copy of a kept PNG, JPEG, WebP or GIF (a
screenshot, an attachment) and hands back its handle with its size; the
original stays as it was, for a tool that needs it whole. PCP decodes the
image itself, as WebAssembly, the same in the container, a checkout and the
desktop app, one image at a time and up to 50 million pixels; the copy
carries no metadata (no camera details or place). The `run_code` description
tells the assistant when to crop, when grey is enough, and when to send the
original instead. `pcp.video.frames(handle, { at, every, count })` takes
frames from a kept video as JPEGs, with ffmpeg in the sandbox (below); without
the sandbox it says so.

Each call is decided as if the assistant had made it with `call_tool`: an
allowed tool runs, a blocked one is an error the program sees, and one that
asks you first stops the program at that call (the calls before it have run),
with the usual request for you to answer; for the program to make that call
itself next time, choose **Always allow**, or **Allow for** while that lasts. Every call is in the request log
under `run_code`, and on the **Log** page. A program has no network, no files, no timers and none of
your secrets, and stops after 3 minutes, 15 seconds of computing, its memory
(**Settings → Resources**, above) or 100 calls (five of them at a time).

**Shell and Python programs.** Where PCP runs in Docker or Podman from a
checkout, add the sandbox and an assistant can also send a bash or Python
program, which runs in a container of its own beside PCP, with `jq`, the
usual command-line tools, ffmpeg and Python 3, and calls tools with a `pcp`
command (`pcp call github list_issues '{"repo": "pcp"}' | jq …`, `pcp image`,
`pcp frames`) or `import pcp`. The sandbox is also where JavaScript's
`pcp.video.frames` takes its frames:

```bash
docker compose -f docker-compose.yaml -f docker-compose.sandbox.yaml up -d
```

(Add `-f docker-compose.https.yaml` too when PCP serves HTTPS itself.) The
`language` argument of `run_code` then offers `bash` and `python` beside
JavaScript.

The sandbox has no network at all, a read-only file system, 1 GB of memory and
one CPU, and runs one program at a time; it reaches PCP only through a socket on
a volume they share, which PCP listens on (PCP never touches the Docker socket),
and each program runs as a user of its own that cannot reach that socket, with
everything it started or wrote removed when it ends. Its calls follow the
token's levels exactly as a JavaScript program's do. The installer and the
desktop apps do not add it; JavaScript works everywhere.

**The browser.** On the **Browser** page, **Add the browser**: it becomes a
server like any other, with tools to open a page (`navigate`, `back`, `tabs`),
read it (`snapshot`, which names each element with a ref; `read_page`; `find`;
`screenshot`), act on it (`click`, `type`, `select_option`, `press_key`,
`scroll`, `wait_for`, `handle_dialog`), move files (`upload_file`,
`download`), `hand_over` a tab to you and ask you for a secret to type
(`request_secret`). It is
Chromium without a window on PCP's machine, with up to eight tabs, started with
the first page and closed after an hour idle (**Settings → Resources** sets
how long; a tab you watch or one handed over to you keeps it open). The Docker
image includes it; elsewhere (the desktop app, a checkout), **Install
Chromium** on the Browser page downloads it, about 200 MB, into PCP's data folder; outside the app,
`PCP_BROWSER_EXECUTABLE` can point at a Chromium or Chrome already installed.
Which sites a token opens follows the same lines as web fetch, on the token's
page (as **Browser sites** for a token without web fetch): a site it has not
opened before asks you, **Allow once** lets that tab open the site's pages
while it is open, and **Allow this site for** lets every tab of the token open
them for that long. When you allow a `navigate` call itself, you have seen the
address, so it is not asked about again. Private addresses and PCP's own address
work as for web fetch. Each token sees and drives only its own tabs (the ones
it opened and the ones you hand it), not another token's or yours, and leaves
a page alone once its lines no longer let it open the site.

The browser keeps its cookies, local storage and IndexedDB, encrypted in your
vault, so a sign-in lasts between conversations; an assistant acts as you
where you signed in, but no tool hands back a cookie or runs a script.
Files go in and out as results PCP keeps for the token for a day, encrypted,
never as files on the machine: `download` keeps the file a page offers (a
download nobody asked for is refused) and `upload_file` puts kept ones, a
download or a mail attachment, into a page's file field, so a run_code
program can take an invoice from an email and upload it without its bytes
passing through the assistant. A token you let **Move files by link** can
also fetch such a file to the assistant's own computer (a sandbox or a
terminal it runs commands in) or send one from there, with curl and a link
that works for an hour, for that one file: still without the bytes passing
through the assistant.
**Forget all sites** signs it out of everything. Every answer names the tab
and a link to it in PCP, where you watch it live and **Take over**: your
mouse and keyboard go to the page, with the timing you made them, and the
assistant's tools leave the tab alone until you **Hand back** to the token
you choose (the one whose tab it was, unless you pick another; a tab you
opened is no token's until you hand it to one). `hand_over` asks you the same
way any request does, with the tab live on the request's page, and **Done**
gives it back.

**Secrets in pages.** An assistant types a password or a one-time code with
`type` and `{"$secret": "<name>"}` as the text: PCP types your secret into
the field itself, and the assistant never sees it. A secret is typed only at
a site (an origin, like `https://shop.example`) where you allowed it for that
token: the first use there asks you, with the secret's name, the site and the
tab live, and you answer **Allow once**, **Allow for 1 hour** or **Always
allow** (which also adds the site to the secret's sites). Only a field of the
page's own site takes it, not one in a frame from another site. Afterwards the
field reads as `[secret: name]` in every answer, any password field's value is
hidden, and screenshots of the tab are refused until the field changes or the
page moves on. A secret an API endpoint uses is not allowed in the browser by
that. Under **Secrets**, add one as **One-time codes (TOTP)** with the seed or
`otpauth://` link a site shows when you set up its codes: PCP types the code
of the moment, and **Code** shows it to you. **Browser** on a secret's row
lists its sites and the tokens allowed there, each with a way to end it, as
does the token's page. `request_secret` asks you for a secret PCP does not
hold yet: you type it on PCP's page, check its sites and choose how its uses
go, and the assistant gets its name. The request log names the secret and the
site of each use, never the value.

## How it is secured

The short version: everything sensitive is AES-256-GCM ciphertext under a
per-vault data key, and that key is stored only wrapped under keys derived from
credentials the server does not keep — your password (scrypt), a session cookie,
an API token, what an app that signed in holds (its access and refresh tokens),
the recovery key or the Mac app's Touch ID key (HKDF). A request
that presents one of those unwraps the key for its own duration and drops it.
Someone with the disk has ciphertext and hashes.
[ARCHITECTURE.md](ARCHITECTURE.md) has the full model;
[SECURITY.md](SECURITY.md) has the threat model and how to report a problem.

Consequences worth knowing:

- Changing the password re-wraps the key; sessions and API tokens keep
  working. Using the recovery key signs every browser out, turns Touch ID off,
  forgets the pinned public address and can revoke every API token.
- A stolen session cannot make an API token or a recovery key: both ask for
  the password again (a token, in the Mac app, takes Touch ID instead). Letting
  an app sign in makes a token, so it asks too, and so does changing PCP's
  public address, which decides where sign-ins and permission links go.
- Losing the password **and** the recovery key loses the data. That is the
  design, not a bug.
- An export is the encrypted vault as it is, under an export password of
  your own on top: reading one takes that password and your PCP password (or
  the recovery key, or a token). Nothing is decrypted to make it.
- The gateway never returns a secret to an assistant, only what the upstream
  server answered. An API's answer is scrubbed of the secret or token first,
  in case it echoes the key back in an error.

## Development

Node 24 and pnpm 10. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow
and [CLAUDE.md](CLAUDE.md) for the conventions an agent (or a person) should
keep to.

```bash
pnpm install
pnpm db:generate
pnpm dev             # http://localhost:3000, data in ./data
pnpm test            # unit tests (vitest)
pnpm test:e2e        # Playwright, against a fresh e2e database
```

| Script             | Description                                       |
| ------------------ | ------------------------------------------------- |
| `pnpm dev`         | Dev server (Turbopack); migrations apply at boot  |
| `pnpm build`       | Production build                                  |
| `pnpm start`       | Serve the production build                        |
| `pnpm lint`        | ESLint (`pnpm lint:fix` to auto-fix)              |
| `pnpm format`      | Prettier, writing (`pnpm format:check` to verify) |
| `pnpm typecheck`   | `tsc --noEmit`                                    |
| `pnpm test`        | Unit tests                                        |
| `pnpm test:e2e`    | Reset the e2e database, run the Playwright suite  |
| `pnpm db:generate` | Generate the Prisma client                        |
| `pnpm db:migrate`  | Create a migration after changing the schema      |

## Stack

Next.js 15 (App Router, Server Actions), React 19, TypeScript, Tailwind CSS 4
with shadcn/ui primitives, Prisma 7 on SQLite (`better-sqlite3`), the
`@modelcontextprotocol` v2 SDK for both the gateway and the upstream client,
QuickJS in WebAssembly for `run_code`, `patchright-core` driving Chromium for
the browser, Electron for the desktop apps, Vitest, Playwright, pnpm.

## Licence

[MIT](LICENSE).
