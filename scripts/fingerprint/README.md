# Fingerprint harness

Why do Reddit and Cloudflare flag PCP's browser (kaperkunde/pcp#38)? This
folder measures it, rather than guessing:

- `harness.html` is one static page that reads what a page can read about
  the browser it runs in, and writes it as one JSON object. It loads nothing
  and sends nothing (`harness.test.ts` checks that).
- `diff.mjs` compares two of those JSON files, for example PCP's browser and
  a person's, and prints where they differ, the known tells first.
- The checklist below covers the live detection sites, which see what a page
  cannot: the TLS and HTTP/2 fingerprint, the address, and their own scoring.

This is a manual check, not part of CI: the live sites change, rate-limit
and answer differently from day to day. Run it again after a Chromium or
`patchright-core` upgrade, after a change to how the browser starts
(`lib/core/browser/launch.ts`), and after a change to the image's fonts or
graphics.

## What the JSON holds

What the harness reads: the user agent and its client hints, the screen and
window sizes, WebGL's renderer, canvas and audio hashes, the fonts it finds
(of a list of 46), codecs, the time zone and locale, permission states,
counts of media devices and speech voices, the `window.chrome` object,
automation marks (globals, `Runtime.enable`, automation code in stacks,
replaced functions), storage quota and WebRTC candidates. `behaviour` keeps
counts and timings of the input on the page, never what was typed.

It holds no address (WebRTC candidates are counted by kind) and no device
names. It does hold the time zone, the locale, the GPU's name and the fonts
found: look it over before you paste it somewhere public.

`flags` lists the rows the page itself thinks look unlike a person's Chrome;
the summary on the page marks them in red.

## Where the page is served

An assistant has to open the harness at a web address: PCP's browser opens
`http:` and `https:` pages only, through its gate. Use the file on GitHub
through raw.githack.com, which serves it as a page:

```
https://raw.githack.com/kaperkunde/pcp/develop/scripts/fingerprint/harness.html?label=pcp
```

For a version that does not move, use a commit:
`https://rawcdn.githack.com/kaperkunde/pcp/<commit>/scripts/fingerprint/harness.html`.
Before the file is on `develop`, use the branch it is on in place of
`develop`.

`?label=` fills in which browser it is; it goes into the JSON as
`meta.label` and heads its column in the diff.

Use the same address in both browsers. A copy published as a claude.ai
artifact would measure a frame inside claude.ai (`window.inIframe` is true,
and the frame's permissions policy hides the battery, media devices and the
clipboard), so take one only if raw.githack.com cannot be reached, and in
both browsers alike.

## Running it

### In PCP's browser

Ask an assistant with PCP's browser to:

1. Open the address above (with `label=pcp-desktop`, `pcp-container` and so
   on, for the way PCP runs). raw.githack.com is a new site for the token, so
   you are asked once; allow it.
2. Wait for the page to say "Done" (its title becomes `Fingerprint: done`).
3. Click "Click me" and type a few words into the box next to it, as it
   would on any site, then read the page: the JSON at the bottom follows the
   input. Save that JSON as `pcp-desktop.json` (or the label used).

In the Mac app the browser runs with a window of its own kept off the screen;
in the container image, with a window on a virtual display. Measure each way
PCP runs that is in question.

### The baseline: a person's browser

Open the same address (with `label=claude-app`) in the Claude app's browser,
or your own Chrome (`label=chrome`). Move the pointer over the page, click
"Click me", type a few words, then press "Copy JSON" and paste it into a
file, `claude-app.json`.

### Comparing

```bash
node scripts/fingerprint/diff.mjs pcp-desktop.json claude-app.json
node scripts/fingerprint/diff.mjs pcp-desktop.json claude-app.json --markdown
```

`--markdown` prints a table to paste into the issue, `--all` lists what is
the same too, `--wide` keeps long values whole. The `tell` column is how much
a check is known to weigh a difference (100 is a sure sign of automation, 10
a difference any two machines have); `!` marks a row the first browser's own
page flagged, `?` one the second's flagged.

For each row, the report on the issue gives a verdict: a cause, a
contributor, or no effect, from what the live sites below show.

## The live sites

Each of these is a site an assistant's token has to be allowed to open in
PCP's browser; you are asked once per site. Run each in PCP's browser (by an
assistant) and in the baseline browser (by you), and record:

| Site                                                                                                                                                                                                                                                | Record                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [bot.sannysoft.com](https://bot.sannysoft.com/)                                                                                                                                                                                                     | Every red or yellow row of both tables (WebDriver, Chrome, Permissions, Plugins, Languages, WebGL vendor and renderer, broken image size).                                                                                                                   |
| [CreepJS](https://abrahamjuliot.github.io/creepjs/)                                                                                                                                                                                                 | The headless, like-headless and stealth percentages, the number of lies and which, and whether the fingerprint id stays the same after a reload.                                                                                                             |
| [BrowserScan bot detection](https://www.browserscan.net/bot-detection)                                                                                                                                                                              | The verdict, and each test marked abnormal (WebDriver, CDP, user agent, navigator).                                                                                                                                                                          |
| [Pixelscan](https://pixelscan.net/)                                                                                                                                                                                                                 | Consistent or not, "automation framework" or masking detected, and the parts it calls inconsistent.                                                                                                                                                          |
| [deviceandbrowserinfo.com](https://deviceandbrowserinfo.com/are_you_a_bot)                                                                                                                                                                          | Human or bot, and every test that failed (for example `hasCDP`, `isPlaywright`, inconsistent client hints).                                                                                                                                                  |
| [Fingerprint demo](https://fingerprint.com/demo/) and its [bot detection](https://fingerprint.com/products/bot-detection/)                                                                                                                          | The bot result (not detected, good bot, bad bot), and the incognito, tampering, virtual machine and VPN signals; whether the visitor id holds across a reload.                                                                                               |
| browserleaks: [WebGL](https://browserleaks.com/webgl), [canvas](https://browserleaks.com/canvas), [fonts](https://browserleaks.com/fonts), [WebRTC](https://browserleaks.com/webrtc), [client hints](https://browserleaks.com/client-hints)         | The unmasked renderer and WebGL hash; the canvas hash and how unique it is; the fonts found; whether WebRTC shows any address (it should show none past the proxy); whether the `Sec-CH-UA` headers match what scripts read.                                 |
| [tls.peet.ws/api/all](https://tls.peet.ws/api/all)                                                                                                                                                                                                  | `ja3_hash`, `ja4`, `peetprint_hash`, `akamai_fingerprint_hash` (HTTP/2), `http_version` and the `user-agent` header; compare with a person's Chrome of the same major version. Note whether the `ip` is a home or a hosting address, not the address itself. |
| Turnstile: [peet.ws non-interactive](https://peet.ws/turnstile-test/non-interactive.html), [managed](https://peet.ws/turnstile-test/managed.html), and a challenge page ([scrapingcourse.com](https://www.scrapingcourse.com/cloudflare-challenge)) | Passes on its own, wants the checkbox, or loops; how long it took; whether PCP's answer named the check (`cf-mitigated: challenge`).                                                                                                                         |
| [reddit.com](https://www.reddit.com/) and a subreddit ([/r/test](https://www.reddit.com/r/test/))                                                                                                                                                   | Loads, a challenge, or "blocked by network security"; signed in or not; the same on `old.reddit.com`.                                                                                                                                                        |

Also compare the address the sites see: the same network for both browsers,
or not, and whether each is a home or a hosting address. A difference there
can outweigh everything the page shows.
