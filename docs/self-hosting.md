# Running PCP yourself: a step-by-step guide

This guide is for running PCP at home or on a small rented server without
already knowing Docker, DNS or HTTPS. It takes about half an hour, most of it
waiting for things to download. If you already run a reverse proxy (Caddy,
Traefik, nginx, Coolify, …), [skip to the end](#i-already-have-a-proxy).

What you end up with:

- PCP running on a computer that stays on,
- a name like `pcp-yourname.duckdns.org` that keeps working when your home
  internet address changes (optional),
- HTTPS with a free certificate from Let's Encrypt, so assistants and sign-ins
  with other services work from anywhere (optional).

## 1. What you need

- **A computer that stays on.** A Raspberry Pi 4 or 5 (64-bit OS), an old
  laptop or mini PC running Linux, a NAS that runs Docker, or a small cloud
  server (a few euros or dollars a month). PCP is light: 1 GB of memory is
  plenty.
- **Docker.** On Linux, this installs it:

  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER   # then log out and back in
  ```

  On a Mac or Windows PC, install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
  Check that it works with `docker compose version`.

- **git**, to download PCP: `sudo apt install git` on Debian, Ubuntu and
  Raspberry Pi OS.

## 2. Start PCP

```bash
git clone https://github.com/kaperkunde/pcp.git
cd pcp
docker compose -f docker-compose.yaml -f docker-compose.https.yaml up -d
```

The first start builds PCP, which takes a few minutes (longer on a Raspberry
Pi). The second file opens ports 80 and 443 for PCP's own HTTPS. Nothing
answers on them until you turn HTTPS on. If you only want PCP on your own
network, or something else on this computer already uses those ports, leave
it out: `docker compose up -d`.

## 3. Set up your vault

Open `http://<this computer's address>:3000` in a browser, for example
`http://192.168.1.20:3000` (`hostname -I` prints the address on Linux). On
that computer itself, `http://localhost:3000` works.

1. Choose your name and a password. The password encrypts everything PCP
   stores, so make it a good one.
2. PCP shows a **recovery key** once. Save it in your password manager. It is
   the only way back in if you forget the password; nobody, including PCP,
   can reset it for you.
3. The next page, **Reach PCP from anywhere**, is optional. If PCP is only for
   your home network, choose **Skip for now**. Otherwise, read on. Everything
   on it is also under **Settings** later.

## 4. Reach PCP from outside your home (optional)

This needs three things to line up: a **name** that points at your home
connection, your **router** sending the traffic to the computer running PCP,
and **HTTPS**. Do them in this order.

### 4a. Get a free name with DuckDNS

Home internet connections usually get a new address now and then. A dynamic
DNS service gives you a name that follows it.

1. Go to [duckdns.org](https://www.duckdns.org) and sign in (with GitHub,
   Google or another account).
2. Type a name under **sub domain** (for example `pcp-yourname`) and choose
   **add domain**.
3. Copy the **token** shown at the top of the page.
4. In PCP, under **Dynamic DNS**, keep **DuckDNS** selected, enter
   `pcp-yourname` and paste the token. Choose **Turn on dynamic DNS**.

PCP says something like "pcp-yourname.duckdns.org now points at
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
network.

### 4c. Turn on HTTPS

In PCP, under **HTTPS**:

1. Keep **Use my dynamic DNS name** ticked (or type your own name, if you have
   one).
2. Optionally enter your email address. Let's Encrypt only writes about
   problems with your account.
3. Accept the Let's Encrypt Subscriber Agreement and choose **Turn on HTTPS**.

Within a minute the card shows **Working** and the date the certificate lasts
until. PCP renews it on its own, well before it runs out. Choose **Use
https://pcp-yourname.duckdns.org as PCP's public address** when PCP offers it,
so sign-ins with other services send you back to the right place.

### 4d. Check it from outside

Turn Wi-Fi off on your phone and open `https://pcp-yourname.duckdns.org`. You
should see PCP's sign-in page with the padlock in the address bar.

Some routers do not let a computer at home reach the home's own name. If the
name works from your phone but not from your laptop on Wi-Fi, that is why.
Use `http://<this computer's address>:3000` at home.

## 5. Connect an assistant

In PCP, create an API token under **API tokens**. Then, for Claude Code:

```bash
claude mcp add --transport http pcp https://pcp-yourname.duckdns.org/mcp \
  --header "Authorization: Bearer pcp_…"
```

The [README](../README.md#use-it) explains servers, secrets, tokens and
permissions.

## 6. Keeping it running

**Updating.** In the `pcp` folder:

```bash
git pull
docker compose -f docker-compose.yaml -f docker-compose.https.yaml up -d --build
```

**Backing up.** Everything PCP keeps is in one Docker volume: the vault, the
settings and the certificate. Copy it to a file now and then:

```bash
docker run --rm -v pcp_pcp-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/pcp-backup.tgz -C /data .
```

(`docker volume ls` shows the volume's name if yours differs.) The backup is
as safe as your password: the vault in it is encrypted, but the dynamic DNS
token and the certificate's key are not.

**Restarting.** PCP starts again by itself after a reboot
(`restart: unless-stopped`). `docker compose logs -f` shows what it is doing.

## When something does not work

**"Let's Encrypt did not issue a certificate … Timeout during connect" or
"Connection refused".** Let's Encrypt could not reach port 80 at your name.
Check, in order:

- The name points at your connection: the Dynamic DNS card says "Working",
  and the address it shows matches what [ipify.org](https://api.ipify.org)
  shows from your home network.
- Port 80 is forwarded to the right computer (4b), and PCP was started with
  `docker-compose.https.yaml`.
- Your internet provider does not block port 80. Some do, mostly on
  residential plans. Ask them, or see "Neither works" below.

Then choose **Try again now**. Let's Encrypt allows only a few failed
attempts per hour, so PCP otherwise waits a while before trying again by
itself.

**The address PCP shows is not your router's.** Compare the "WAN" or
"Internet" address on your router's status page with what
[ipify.org](https://api.ipify.org) shows. If they differ, or the router's
starts with `100.64`–`100.127`, your provider shares one address between many
customers (this is called CGNAT) and port forwarding cannot work. Ask your
provider for a public IPv4 address (some give one for free on request), or
see below.

**"Port 80 is already in use" / "Port 443 is already in use".** Another
program on that computer (often another web server) uses the port. Stop it,
or let that program handle HTTPS for PCP and turn PCP's HTTPS off.

**Cloudflare: the name works but HTTPS does not.** Set the record to "DNS
only" (the grey cloud) in Cloudflare, so Let's Encrypt reaches PCP directly.

**Neither works (CGNAT, or port 80 blocked).** A tunnel avoids port forwarding
entirely:
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
or [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) can publish
`http://localhost:3000` on an HTTPS address of theirs. Leave PCP's dynamic DNS
and HTTPS off in that case, and set PCP's public address under Settings to the
tunnel's address.

## I already have a proxy

Leave **Dynamic DNS** and **HTTPS** off, which is how PCP starts, and start it
with plain `docker compose up -d` (or your platform's equivalent, such as
Coolify building the Dockerfile). Point your proxy at port 3000 and have it
set `X-Forwarded-Proto` and `X-Forwarded-Host`. If PCP guesses its public
address wrong, pin it under **Settings → Public address**.

The optional environment variables (`PCP_HTTP_PORT`, `PCP_HTTPS_PORT`,
`PCP_ACME_DIRECTORY`, `PCP_PUBLIC_IP_URL`) are listed in
[`.env.example`](../.env.example).
