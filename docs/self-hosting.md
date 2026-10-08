# Running PCP yourself: a step-by-step guide

This guide is for running PCP at home or on a small rented server without
already knowing Docker, DNS or HTTPS. It takes about half an hour, most of it
waiting for things to download. If you already run a reverse proxy (Caddy,
Traefik, nginx, Coolify, …), [skip to the end](#i-already-have-a-proxy).

What you end up with:

- PCP running on a computer that stays on,
- a name like `yourname.duckdns.org` that keeps working when your home
  internet address changes (optional),
- HTTPS with a free certificate from Let's Encrypt, so assistants and sign-ins
  with other services work from anywhere (optional).

## 1. What you need

- **A computer that stays on.** A Raspberry Pi 4 or 5 (64-bit OS), an old
  laptop or mini PC running Linux, a NAS that runs Docker, or a small cloud
  server (a few euros or dollars a month). PCP is light: 1 GB of memory is
  plenty. If you add the browser, it runs Chromium while it is in use: give
  it another 1 GB. The image comes with Chromium.
- **Docker or Podman.** Fedora Atomic systems such as Bazzite come with
  Podman. On other Linux systems, this installs Docker:

  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER   # then log out and back in
  ```

  On a Mac or Windows PC, the PCP app needs no Docker at all: download it
  from the [README](../README.md#on-your-own-computer), set up your vault
  (step 3) and carry on with step 4, which works the same for it. If you
  would rather run the container there, install
  [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start
  PCP from a checkout (step 2). Check that it works with
  `docker compose version`.

- **git**, only for a checkout: `sudo apt install git` on Debian, Ubuntu and
  Raspberry Pi OS.

## 2. Start PCP

One line does it on Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh | PCP_HTTPS=1 sh
```

It finds Docker or Podman, downloads PCP (a minute or two), starts it so that
it comes back after a reboot, and prints the address to open. `PCP_HTTPS=1`
opens ports 80 and 443 for PCP's own HTTPS. Nothing answers on them until you
turn HTTPS on. It also keeps port 3000, which is plain HTTP, on this computer
only (`127.0.0.1`): Docker's published ports skip the firewall (ufw
included), so on a server that would put PCP's sign-in on the internet
unencrypted. If you only want PCP on your own network, or something else on
this computer already uses those ports, leave it out. The installer remembers
the choice, so the same line later updates PCP without changing it. Podman
without root may not open ports 80 and 443 until the system allows it; the
installer prints the one command that does, if so.

The installer never runs `sudo` and never installs Docker or Podman itself.
A few more settings go before `sh` the same way. All but the last are
remembered like `PCP_HTTPS` (in `~/.config/pcp/install.conf`, or in
`/etc/pcp/install.conf` when you run it as root; an older root install's
file in `~/.config/pcp` is carried over the first time you run the
installer again):

- `PCP_PORT=3000`: the port PCP answers on, if another program has 3000.
- `PCP_RUNTIME=docker` or `PCP_RUNTIME=podman`: when both are installed and
  it picks the wrong one.
- `PCP_DATA_VOLUME=pcp-data`: the volume that holds your vault.
- `PCP_AUTO_UPDATE=1`: update PCP once a day by itself (see
  [Keeping it running](#6-keeping-it-running)).
- `PCP_VERSION=1.2.3`: a release other than the latest, for this run only.

Use either the installer or a checkout, not both: the installer stops if a
checkout's PCP is running, and says how to take its vault over.

**From a checkout** (a Mac or Windows PC with Docker Desktop, or when you want
to change the compose file):

```bash
git clone https://github.com/kaperkunde/pcp.git
cd pcp
docker compose -f docker-compose.yaml -f docker-compose.https.yaml up -d
```

The first start builds PCP, which takes a few minutes (longer on a Raspberry
Pi); `docker compose pull` first fetches the published image instead. The
second file opens ports 80 and 443, and keeps port 3000 on this computer
only, like `PCP_HTTPS=1` above; leave it out for `docker compose up -d`, which
publishes port 3000 on every interface. (The second file needs Docker Compose
2.24 or newer.)

**Shell and Python programs (optional).** An assistant whose token you let
run code (**Let an assistant with this token run code that calls its
tools**) runs JavaScript programs inside PCP. From a checkout, a third file
adds a sandbox container where it can also run bash and Python programs; it
has no network and reaches PCP only through a shared volume. The installer
does not add it. From the `pcp` folder:

```bash
docker compose -f docker-compose.yaml -f docker-compose.https.yaml -f docker-compose.sandbox.yaml up -d
```

Name the same files whenever you run `docker compose` for PCP afterwards.

## 3. Set up your vault

Open `http://<this computer's address>:3000` in a browser, for example
`http://192.168.1.20:3000` (`hostname -I` prints the address on Linux). On
that computer itself, `http://localhost:3000` works.

If you started PCP with `PCP_HTTPS=1` (or the HTTPS compose file), port 3000
answers on that computer only. On a server, reach it with an SSH tunnel from
your own computer, and open `http://localhost:3000` there:

```bash
ssh -L 3000:127.0.0.1:3000 you@your-server
```

1. Choose your name and a password. The password encrypts everything PCP
   stores, so make it a good one.
2. PCP shows a **recovery key** once. Save it in your password manager. It is
   the only way back in if you forget the password; nobody, including PCP,
   can reset it for you.
3. The next page, **Reach PCP from anywhere**, is optional. If PCP is only for
   your home network, choose **Skip for now**. Otherwise, read on. Everything
   on it is also under **Settings** later, including **New releases**: PCP
   asks GitHub once a day whether there is a newer PCP, and you can turn
   that off there.

Moving from another PCP? Choose **Restore an export instead** on the first
page; see [Backing up](#6-keeping-it-running).

## 4. Reach PCP from outside your home (optional)

The easiest way is **pcp.gg**: sign in at [pcp.gg](https://pcp.gg), choose a
name, and paste the connection key from your pcp.gg dashboard under
**Settings → pcp.gg**. PCP connects to pcp.gg itself, comes online at your
name and gets its own HTTPS certificate for it. Nothing changes on your
router, and the rest of this section does not apply.

To do it with your own name and router instead, three things to line up: a **name** that points at your home
connection, your **router** sending the traffic to the computer running PCP,
and **HTTPS**. Do them in this order.

### 4a. Get a free name with DuckDNS

Home internet connections usually get a new address now and then. A dynamic
DNS service gives you a name that follows it.

1. Go to [duckdns.org](https://www.duckdns.org) and sign in (with GitHub,
   Google or another account).
2. Type a name under **sub domain** and choose **add domain**. Pick one that
   says nothing about PCP (not `pcp-something`): a name that gives away what
   runs behind it helps people who look for such servers to attack.
3. Copy the **token** shown at the top of the page. If copying exactly the
   token is fiddly, copy the whole update line from DuckDNS's **install**
   page instead: PCP picks the token and the name out of it.
4. In PCP, under **Dynamic DNS**, keep **DuckDNS** selected, enter
   your name and paste the token. Choose **Turn on dynamic DNS**.

PCP says something like "yourname.duckdns.org now points at
203.0.113.7". From now on it checks your address every five minutes and tells
DuckDNS when it changes.

Other services work too: **No-IP, Dynu and others** (any service that uses the
common "dyndns2" update protocol), **Cloudflare** (if you own a domain there),
or **Another service** with an update URL. No-IP's free names have to be
confirmed by email once a month, or No-IP removes them.

> The DuckDNS token (or the password of another service) is stored on your
> server **unencrypted**, unlike everything in your vault. PCP has to use it
> while you are signed out. All it allows is changing where your name
> points.

### 4b. Forward ports 80 and 443 on your router

Your router has to send traffic from the internet to the computer running PCP.

1. Open your router's settings page. It is usually at `http://192.168.1.1` or
   `http://192.168.0.1`, or printed on a sticker on the router, and often
   called "Port forwarding", "Virtual servers", "NAT" or "Applications".
   [portforward.com](https://portforward.com/router.htm) has guides for most
   models.
2. Add two rules, both TCP, both to the address of the computer running PCP:
   - external port **80** → internal port **80**
   - external port **443** → internal port **443**
3. Give that computer a fixed address on your network (often called "DHCP
   reservation" or "static lease" in the same settings), so the rules keep
   pointing at it.

Do **not** forward port 3000. It is plain HTTP and only meant for your own
network (with `PCP_HTTPS=1` it answers on the computer running PCP only).

### 4c. Turn on HTTPS

In PCP, under **HTTPS**:

1. Keep **Use my dynamic DNS name** ticked (or type your own name, if you have
   one).
2. Optionally enter your email address. Let's Encrypt only writes about
   problems with your account.
3. Accept the Let's Encrypt Subscriber Agreement and choose **Turn on HTTPS**.

Within a minute the card shows **Working** and the date the certificate lasts
until. PCP renews it on its own, well before it runs out. Choose **Use
https://yourname.duckdns.org as PCP's public address** when PCP offers it,
so sign-ins with other services send you back to the right place.

### 4d. Check it from outside

Turn Wi-Fi off on your phone and open `https://yourname.duckdns.org`. You
should see PCP's sign-in page with the padlock in the address bar.

Some routers do not let a computer at home reach the home's own name. If the
name works from your phone but not from your laptop on Wi-Fi, that is why.
Use `http://localhost:3000` on the computer running PCP, or an SSH tunnel to
its port 3000 from another computer at home (step 3): with HTTPS on, port
3000 answers on that computer only.

## 5. Connect an assistant

In PCP, create an API token under **API tokens** (PCP asks for your password
again, and shows the token once). Then, for Claude Code:

```bash
claude mcp add --transport http pcp https://yourname.duckdns.org/mcp \
  --header "Authorization: Bearer pcp_…"
```

The [README](../README.md#use-it) explains servers, secrets, tokens and
permissions.

## 6. Keeping it running

**Updating.** PCP tells you when a new release is out: a note in its header,
and **Settings → Updates** with the release notes and the command for your
install. (It asks GitHub once a day, which sees your address and PCP's
version; you can turn that off there.) Run the install line again: it
fetches the new release and restarts PCP with the settings it remembered.
From a checkout, in the `pcp` folder, with the same `-f` files you started
it with:

```bash
git pull
docker compose -f docker-compose.yaml -f docker-compose.https.yaml pull
docker compose -f docker-compose.yaml -f docker-compose.https.yaml up -d
```

(`up -d --build` instead builds PCP from the checkout.) PCP never updates
itself in a container; if a tool such as Coolify or Portainer runs it,
redeploy it there.

To have it done for you, run the install line once with `PCP_AUTO_UPDATE=1`;
it remembers that, and PCP is then updated once a day, starting again only
when there is a new release:

```bash
curl -fsSL https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh | PCP_AUTO_UPDATE=1 sh
```

Under Podman 4.4 or newer with systemd that turns on Podman's own
`podman-auto-update.timer`. Otherwise it adds a daily `pcp-update.timer` to
systemd (your user's, or the system's when you run it as root), or, without
a systemd session, prints the line for your crontab. The timer runs a copy
of the installer, kept in `~/.local/share/pcp/install.sh`; as root, in
`/usr/local/lib/pcp/install.sh`, whatever `HOME` is, so that only root can
change what root runs. `PCP_AUTO_UPDATE=0` takes it away again:
`pcp-update.timer` and the copy, or under Podman the auto-update label on
PCP's unit (Podman's timer stays on, since other containers may use it).

**Backing up.** **Settings → Export** writes everything PCP holds to one
file, locked with an export password you choose. **Settings → Restore** (or
**Restore an export instead** on a fresh PCP's setup page) puts it back, on
this machine or another, and your password, recovery key and API tokens
keep working. Restoring replaces everything on the PCP it is done on, so
export that one first if you may want it back. It also offers to restore
the machine's settings (dynamic DNS, HTTPS, the update check): leave that
ticked when you move PCP, so your name follows it, and untick it for a copy
that should not take the name over. Keep the file with your other backups:
it holds the vault as encrypted as it is here, but the dynamic DNS token
behind the export password alone.

Everything PCP keeps is also in one volume: the vault, the request log, the
settings and the certificate. Copying it is the other way to back up. Stop
PCP first, so the database is copied whole (`docker stop pcp`, and
`docker start pcp` after; `systemctl --user stop pcp` and `start` under
Podman; `docker compose stop` and `start` from a checkout):

```bash
docker run --rm -v pcp-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/pcp-backup.tgz -C /data .
```

(The volume is `pcp-data` from the installer and `pcp_pcp-data` from a
checkout; `docker volume ls` shows it. With Podman:
`podman volume export pcp-data --output pcp-backup.tar`.) The backup is as
safe as your password: the vault in it is encrypted, but the dynamic DNS
token and the certificate's key are not.

**Restarting.** PCP starts again by itself after a reboot; the installer
says so when it cannot (Podman older than 4.4, or no systemd session).
The installer's last lines name the command that shows what PCP is doing:
`docker logs -f pcp` under Docker, `journalctl --user -u pcp -f` under
Podman, `docker compose logs -f` from a checkout.

**Removing PCP.** This removes the container, its unit and the daily
update, and keeps the volume with your vault:

```bash
curl -fsSL https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh | sh -s -- uninstall
```

It prints the command that deletes the volume too
(`docker volume rm pcp-data`); after that, the vault is gone. The image stays
until you remove it (`docker image rm ghcr.io/kaperkunde/pcp`), and a crontab
line the installer gave you for daily updates stays until you take it out
(`crontab -e`). From a checkout, `docker compose down` stops PCP and keeps
the volume; `docker compose down -v` deletes it as well.

**Starting over.** To keep PCP but not what is in it, **Settings → Delete
vault** deletes the vault (servers, secrets, API tokens, memories, the
request log, your password and recovery key) after you confirm with your
password, and PCP opens on its setup page again. The machine's settings
(Dynamic DNS with its token, HTTPS and its certificate, updates, cleanup)
stay; turn them off first if you want them gone. Until you set it up again,
the first person to open PCP becomes its owner, so do that soon on a PCP
that is reachable from outside.

## When something does not work

**"Let's Encrypt did not issue a certificate … Timeout during connect" or
"Connection refused".** Let's Encrypt could not reach PCP at your name: it
asks on port 80 first, and when that fails once more on port 443. Check, in
order:

- The name points at your connection: the Dynamic DNS card says "Working",
  and the address it shows matches what [ipify.org](https://api.ipify.org)
  shows from your home network.
- Ports 80 and 443 are forwarded to the right computer (4b), and PCP was
  started with `PCP_HTTPS=1` (or `docker-compose.https.yaml`).
- Your internet provider does not block both. Some block port 80, mostly on
  residential plans; PCP then manages with port 443 alone. Ask them, or see
  "Neither works" below.

If this happens on the first try, PCP turns HTTPS off again and the card
says why: these problems do not go away by themselves, and Let's Encrypt is
a shared service that should not be asked over and over. Fix what it says,
then turn HTTPS on again. Once PCP has had a certificate, a renewal that fails
is tried again by itself, waiting longer each time, and the bell at the top of
every page says so until it works.

**The address PCP shows is not your router's.** Compare the "WAN" or
"Internet" address on your router's status page with what
[ipify.org](https://api.ipify.org) shows. If they differ, or the router's
starts with `100.64`–`100.127`, your provider shares one address between many
customers (this is called CGNAT) and port forwarding cannot work. Ask your
provider for a public IPv4 address (some give one for free on request), or
see below.

**"Port 80 is already in use", or the installer says "PCP did not start"
and the message above it names port 80 or 443.** Another program on that
computer (often another web server) uses the port. Stop it, or let that
program handle HTTPS for PCP: turn PCP's HTTPS off and run the installer
again with `PCP_HTTPS=0`. If it names port 3000, choose another with
`PCP_PORT=3001`.

**Cloudflare: the name works but HTTPS does not.** Set the record to "DNS
only" (the grey cloud) in Cloudflare, so Let's Encrypt reaches PCP directly.

**Neither works (CGNAT, or ports 80 and 443 blocked).** A tunnel avoids port forwarding
entirely:
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
or [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) can publish
`http://localhost:3000` on an HTTPS address of theirs. Leave PCP's dynamic DNS
and HTTPS off in that case, and set PCP's public address under Settings to the
tunnel's address.

## I already have a proxy

Leave **Dynamic DNS** and **HTTPS** off, which is how PCP starts, and start it
with the install line without `PCP_HTTPS=1` (with `PCP_HTTPS=0` if you ran
it with 1 before), or with plain
`docker compose up -d` from a checkout (or your platform's equivalent, such
as Coolify building the Dockerfile). Point your proxy at port 3000 and have it
set `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For` (the limit
on password tries counts per address it reports). Keep port 3000 itself
off the internet: PCP believes those headers from whoever sends them. If PCP
guesses its public address wrong, pin it under **Settings → Public
address**.

PCP counts the left-most `X-Forwarded-For` address. A proxy that replaces
the header puts the client's address there; most append to it instead
(nginx's `$proxy_add_x_forwarded_for`, Caddy, Traefik), and then the
left-most is whatever the client sent. For those, set `PCP_TRUSTED_PROXIES`
to your proxies' addresses (IP addresses and CIDR ranges, comma-separated,
such as `PCP_TRUSTED_PROXIES=172.16.0.0/12` for proxies on a Docker
network): PCP then reads the header from the right, past those addresses
and loopback, and counts the first one that is not yours. It is off unless
you set it, and it still needs port 3000 to be reachable from your proxies
alone.

PCP needs no environment variables. The optional ones (`PCP_DATA_DIR`,
`PORT`, `PCP_HTTP_PORT`, `PCP_HTTPS_PORT`, `PCP_ACME_DIRECTORY`,
`PCP_PUBLIC_IP_URL`, `PCP_PCPGG_RELAY_URL`, `PCP_TRUSTED_PROXIES`) are listed in [`.env.example`](../.env.example), for a
checkout or a deployment of your own; the installer does not pass them on.
