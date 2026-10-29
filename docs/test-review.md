# Test review (#36)

What each test file is kept for, what was pruned or made sturdier, and what
the suites cost before and after. A test earns its place by pinning a
boundary from CLAUDE.md, a bug that happened, or logic with branches; e2e
keeps one path per flow a person walks. Every test CLAUDE.md asks for
("add a test for …") is kept.

Verdicts: **keep** (as it is), **trim** (some tests or steps dropped),
**merge** (takes cases from another file), **remove** (the file goes),
**sturdier** (kept, and a wait on time or a machine's speed now waits on
state).

## The numbers

Measured on one machine (4 processors, 15 GB), the whole suite each time,
before on the base commit (f7ef889) and after on this branch.

| Suite                                | Before                                        | After                                                         |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------------------------- |
| Unit, wall time                      | 244 s (3 workers; 2 tests failed)             | 132 s (4 workers; all pass)                                   |
| Unit, time inside test files, summed | 644 s                                         | 422 s                                                         |
| Unit tests                           | 2,257 in 170 files                            | 2,257 in 170 files                                            |
| E2E, wall time                       | 13.9 min on `pnpm dev`: 3 failed, 8 never ran | 1.4 min to build, then 3.7 min on the build: 1 failed (below) |
| E2E tests                            | 93 in 27 specs                                | 93 in 27 specs                                                |

CI's runners have 4 processors for a public repository (2 for a private
one), so the unit job should take about what it takes here, well under the
5 minutes aimed for, and the e2e job, with installing, building (its
compiler cache now kept between runs) and the suite, under 10.

### The slowest unit files

| File                                 | Before | After  |
| ------------------------------------ | ------ | ------ |
| `lib/core/browser/call.test.ts`      | 60.8 s | 47.7 s |
| `lib/core/backup.test.ts`            | 37.5 s | 14.0 s |
| `lib/core/browser/solve.test.ts`     | 29.7 s | 12.4 s |
| `lib/core/code/run.test.ts`          | 25.7 s | 19.8 s |
| `lib/core/wrappers/wrappers.test.ts` | 25.7 s | 17.3 s |
| `lib/core/permissions.test.ts`       | 25.1 s | 13.1 s |
| `lib/core/browser/lanes.test.ts`     | 23.9 s | 22.8 s |
| `lib/core/browser/files.test.ts`     | 23.5 s | 17.4 s |
| `lib/core/endpoint-admin.test.ts`    | 18.9 s | 8.7 s  |
| `lib/core/browser/owner.test.ts`     | 16.6 s | 12.8 s |
| `lib/core/endpoints.test.ts`         | 16.2 s | 8.9 s  |
| `lib/core/tool-results.test.ts`      | 15.2 s | 9.8 s  |

### The slowest e2e specs

Each spec's tests summed. On the dev server most of a spec's time was the
first visit to each page, compiled while the test waited.

| Spec                                     | Dev server, before | Build, after |
| ---------------------------------------- | ------------------ | ------------ |
| `e2e/tests/oauth-client.spec.ts`         | 60.5 s             | 1.6 s        |
| `e2e/tests/setup.spec.ts`                | 56.5 s             | 18.6 s       |
| `e2e/tests/repositories.spec.ts`         | 51.4 s             | 7.5 s        |
| `e2e/tests/endpoints.spec.ts`            | 47.5 s             | 9.4 s        |
| `e2e/tests/browser.spec.ts`              | 47.3 s             | 9.4 s        |
| `e2e/tests/gateway.spec.ts`              | 45.4 s             | 10.7 s       |
| `e2e/tests/memories.spec.ts`             | 35.3 s             | 7.6 s        |
| `e2e/tests/recovery.spec.ts`             | 34.6 s             | 11.5 s       |
| `e2e/tests/backup.spec.ts`               | 33.2 s             | 11.2 s       |
| `e2e/tests/endpoint-credentials.spec.ts` | 29.4 s             | 6.6 s        |

## What made it faster

Most of the time was not in what the tests check but in how they ran.

- **A migrated database, copied.** `scratchDatabase` (`lib/core/test-db.ts`)
  applied every migration for every test that touches the database (67
  files do it in `beforeEach`). It now copies a database migrated once,
  named by a hash of the migrations, so a new or changed migration builds a
  new one. `migrate.test.ts` still applies every migration itself.
- **Cheaper key derivation.** Setting up a vault derives the password's key
  with scrypt at 64 MiB, on purpose slow. `vitest.setup.ts` gives tests the
  smallest cost an export may ask for (N = 2^14): the parameters are stored
  with each grant and read back, so every path is the one PCP runs.
  `crypto.test.ts` pins the real cost.
- **One worker per processor.** The Chromium suites wait more than they
  compute; `maxWorkers: "100%"` was a sixth faster than Vitest's default.
- **Shorter waits where the test's page answers at once or never.** An
  action's timeout in `browser/call.test.ts` and `files.test.ts` (10 s to
  3 s), a site's check in `browser/solve.test.ts` (20 s to 3 s, as
  `call.test.ts` already had).
- **E2E against a production build.** `pnpm test:e2e` builds with
  `PCP_TEST_BUILD=1` and serves the build as the image does
  (`e2e/scripts/serve.mjs`). The dev server compiled each page on its first
  visit and hydrated late; that was most of the e2e time, and the cause of
  the races. Only a build made with the flag may be pointed at the fake
  GitHub (`fakeGitHubAllowed`): `next.config.ts` writes the flag in, so a
  release compiles the check to false. CI keeps `.next/cache` between runs
  of the e2e job, so a build compiles again only what changed.
  `PCP_E2E_DEV=1` still runs a spec against `pnpm dev` while you work on it.

## What was removed or merged

The suite had little dead weight: nearly every file pins a boundary from
CLAUDE.md or logic with branches, and the cost was in how the tests ran,
not in how many there were. What went:

| Where                                                                                       | What                                                                                                                                                                                                                             | Count                                                     |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `lib/core/openapi/call.test.ts`                                                             | Three tests that only called `redactSecrets`, which `redact.test.ts` covers                                                                                                                                                      | −3 tests                                                  |
| `lib/core/openapi/redact.test.ts`                                                           | Takes their two cases `redact.test.ts` lacked (a key wrapped in a header value, a cut that did not reach the key), as assertions                                                                                                 | +0 tests                                                  |
| `e2e/tests/memories.spec.ts`, `web-fetch.spec.ts`, `run-code.spec.ts`, `file-links.spec.ts` | A second token made in the browser to show that a token without the switch gets no tool and no instructions for it; the unit suites (`memories.test.ts`, `web-fetch.test.ts`, `code/run.test.ts`, `file-links.test.ts`) pin that | 4 tokens made through the password sheet, and their steps |

Added: `crypto.test.ts` pins the real scrypt cost the suite now lowers
(+1), `repos/github.test.ts` pins that a release never reads the fake
GitHub's addresses (+1), and `browser/proxy.test.ts` closes a tunnel to an
allowed address that does not answer (+1; see Coverage). No file was removed: 170 unit files and
27 e2e specs before and after.

## Coverage

V8 coverage of `lib/core` (every `*.ts` but tests and fakes), the whole unit
suite, the base commit's tests against this branch's tests on the same code:

|           | Before                     | After                      |
| --------- | -------------------------- | -------------------------- |
| Lines     | 89.03 % (18,480 of 20,755) | 89.01 % (18,488 of 20,769) |
| Branches  | 81.18 %                    | 81.18 %                    |
| Functions | 90.89 % (4,002 of 4,403)   | 90.80 % (3,999 of 4,404)   |

No boundary module lost a path a test pins on purpose. The modules that moved:

| Module                        | Before                             | After                              | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/core/test-db.ts`         | 14 of 15 lines                     | 25 of 29 lines                     | The test helper itself grew: it now builds and copies a migrated template. Not a boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `lib/core/browser/proxy.ts`   | 89 of 97 lines, 30 of 30 functions | 86 of 97 lines, 25 of 30 functions | The tunnel's timeout and error callbacks ran only when Chromium's own background connections to the internet failed during the long waits in `solve.test.ts` and `call.test.ts` (this machine has no direct network); with those waits shortened they end first. Nothing pinned them before either. `proxy.test.ts` now closes a tunnel to an address that does not answer on purpose. The address check itself, the boundary, is covered as before. One branch cannot run: a tunnel whose dial fails is meant to answer 502, but Node has cleared `connecting` by the time it reports the error, so the browser gets a closed connection instead (refused either way). |
| `lib/core/browser/runtime.ts` | 88 of 121 functions                | 89 of 121 functions                | Run to run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Flaky tests made sturdy

| Test                                          | What failed                                                                                                                                                                                                        | Now                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `browser/input.test.ts`                       | Gaps between replayed events measured on a busy machine                                                                                                                                                            | Runs on a fake clock                                                                        |
| `browser/files.test.ts`                       | A cancelled download's `.crdownload`, which Chromium removes a moment after it says so (failed in the baseline run)                                                                                                | Waits for the folder to empty; the taken file is still checked gone at once                 |
| `browser/display.test.ts`                     | A new window's `outerWidth` read as 0 before it had a size (failed in the baseline run)                                                                                                                            | The page reports once the window has one                                                    |
| `network/pcpgg/tunnel.test.ts`                | The relay's name list read before it saw the socket close                                                                                                                                                          | Waits for the relay to let the name go                                                      |
| e2e `answerEverythingWaiting` (`permissions`) | The all-clear blinks while the queue is read again; the helper took the blink for another request and waited for its Not now. Failed on the dev server and the build, and the project's last eight tests never ran | Decides on a settled page: the all-clear or a request's answer                              |
| e2e `permissions`, following the bell         | The request's title matched both the page and the bell's closing menu                                                                                                                                              | Checks the page's heading                                                                   |
| e2e `browser`, the first site allowed         | The owner's answer starts Chromium for the first time in the run; on a machine that had just started that took over the 10 s an expectation waits (10.2 s on the dev server's baseline run, where it passed)       | Waits up to 30 s for that answer alone                                                      |
| e2e dialog and menu triggers                  | A click before hydration does nothing (`repositories`, and `oauth-client`, which timed out on the dev server)                                                                                                      | `clickHydrated` for every trigger whose only handler is React's; the build hydrates at once |

## Still failing

`secrets.spec.ts`, "a one-time codes secret takes only a seed…" (failed
in every run: on the dev server before, and on the build after): after the
seed is refused, the sheet has cleared the name the owner typed (React 19
resets a form's uncontrolled fields once its action returns), so the second
Save secret is stopped by the empty required Name, and the dialog stays open
with the old error. That is the product's behaviour, not the test's: the spec
is left as it is, and the fix belongs in `components/secret-add-dialog.tsx`
(and any other form that should keep what was typed after a refusal).

No other test is known to be flaky: the unit suite passed in each of its
last four whole runs, and in the last whole e2e run on the build every other
test passed (92 of 93).

## Unit tests, by area

Times are the file's own (start to end, inside its worker), in one run
each.

### Desktop app (`desktop/`)

| File                                        | Verdict | Why                                                                                             | Tests | Before | After |
| ------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- | ----- | ------ | ----- |
| `desktop/cookie-migration.test.mjs`         | keep    | Edge cases of moving the sign-in cookie (expired, already there, other cookies).                | 5     | 0.0 s  | 0.0 s |
| `desktop/scripts/keychain-profile.test.mjs` | keep    | Boundary: a provisioning profile macOS would kill the app over is refused (CLAUDE.md, desktop). | 6     | 0.0 s  | 0.0 s |
| `desktop/settings.test.mjs`                 | keep    | Parsing with fallbacks; cheap.                                                                  | 5     | 0.0 s  | 0.0 s |
| `desktop/touch-id-store.test.mjs`           | keep    | Boundary: the Touch ID key is handed over only after Touch ID; keychain and file paths.         | 14    | 0.0 s  | 0.0 s |
| `desktop/updates.test.mjs`                  | keep    | Version ordering and untrusted health answers; branches.                                        | 14    | 0.0 s  | 0.0 s |
| `desktop/window-policy.test.mjs`            | keep    | Boundary: what the app grants PCP's page and nothing else.                                      | 6     | 0.0 s  | 0.0 s |

### Server actions, request helpers and client logic (`lib/actions`, `lib/server`, `lib/*.test.ts`)

| File                                   | Verdict | Why                                                                                          | Tests | Before | After  |
| -------------------------------------- | ------- | -------------------------------------------------------------------------------------------- | ----- | ------ | ------ |
| `lib/actions/settings.test.ts`         | keep    | Boundary: the public address only with the password or Touch ID (confirmOwner).              | 3     | 1.9 s  | 1.0 s  |
| `lib/actions/tokens.test.ts`           | keep    | Boundary: an expired token's new expiry needs the owner; memory migration only by the owner. | 3     | 2.0 s  | 1.1 s  |
| `lib/browser-keyboard.test.ts`         | keep    | Edit-to-keystroke logic with edge cases (emoji, corrections).                                | 16    | 0.0 s  | 0.0 s  |
| `lib/browser-tabs.test.ts`             | keep    | Small logic of the tabs view; new in this run, milliseconds.                                 | 3     | 0.0 s  | 0.0 s  |
| `lib/pending-count.test.ts`            | keep    | Optimistic count logic (#29); edge cases.                                                    | 5     | 0.0 s  | 0.0 s  |
| `lib/server/client-ip.test.ts`         | keep    | Boundary: X-Forwarded-For and trusted proxies decide the rate limit's key.                   | 10    | 0.0 s  | 0.0 s  |
| `lib/server/oauth-endpoints.test.ts`   | keep    | Body size caps on PCP's authorization server.                                                | 6     | 0.0 s  | 0.0 s  |
| `lib/server/password-attempts.test.ts` | keep    | Password tries counted per address and instance; Touch ID kept off the budget.               | 3     | 0.0 s  | 0.1 s  |
| `lib/server/return-path.test.ts`       | keep    | Open-redirect guard.                                                                         | 2     | 0.0 s  | 0.0 s  |
| `lib/server/same-origin.test.ts`       | keep    | Boundary: the export download's and live view's origin check.                                | 4     | 0.0 s  | 0.0 s  |
| `scripts/docker.test.ts`               | keep    | Required by CLAUDE.md: the image's Chromium matches patchright-core.                         | 8     | 0.0 s  | 0.0 s  |
| `scripts/install.test.ts`              | keep    | The installer's many paths, against stubs.                                                   | 108   | 9.8 s  | 12.5 s |
| `scripts/sandbox.test.ts`              | keep    | Required by CLAUDE.md: pins the sandbox compose file.                                        | 7     | 0.1 s  | 0.0 s  |
| `scripts/standalone.test.ts`           | keep    | Regression: files the standalone tracing misses (runs after a build).                        | 3     | 0.2 s  | 0.2 s  |
| `scripts/version.test.ts`              | keep    | Release numbering logic.                                                                     | 20    | 0.0 s  | 0.1 s  |

### The browser (`lib/core/browser/`)

| File                                  | Verdict  | Why                                                                                                                                                                                                                                                     | Tests | Before | After  |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------ |
| `lib/core/browser/call.test.ts`       | keep     | Boundary: the gate, private addresses, PCP's own site, tabs per token, against real Chromium. Faster: an action's timeout lowered in the test (10 s to 3 s).                                                                                            | 22    | 60.8 s | 47.7 s |
| `lib/core/browser/challenge.test.ts`  | keep     | Boundary: web_fetch's solve shares no sign-ins and keeps to one site.                                                                                                                                                                                   | 7     | 11.7 s | 10.4 s |
| `lib/core/browser/display.test.ts`    | sturdier | Boundary: virtual display and windows. The place page now waits for the window to have a size before it reports (failed once under load: outerWidth 0).                                                                                                 | 11    | 8.9 s  | 9.0 s  |
| `lib/core/browser/failures.test.ts`   | keep     | Parsing Playwright's failure log into a reason; branches.                                                                                                                                                                                               | 7     | 0.0 s  | 0.0 s  |
| `lib/core/browser/favicon.test.ts`    | keep     | Size and type bounds; new in this run (#31).                                                                                                                                                                                                            | 2     | 0.0 s  | 0.0 s  |
| `lib/core/browser/files.test.ts`      | sturdier | Boundary: files only as kept results, nothing left on disk. Now waits for Chromium to remove a cancelled download's part (failed under load with a .crdownload); action timeout lowered in the test.                                                    | 6     | 23.5 s | 17.4 s |
| `lib/core/browser/gate.test.ts`       | keep     | Service worker detection; milliseconds.                                                                                                                                                                                                                 | 2     | 0.0 s  | 0.0 s  |
| `lib/core/browser/idle.test.ts`       | keep     | Idle close logic (#35), on a fake clock already.                                                                                                                                                                                                        | 5     | 0.0 s  | 0.0 s  |
| `lib/core/browser/input.test.ts`      | sturdier | The owner's input replayed at its pace. Now on a fake clock: the gaps it checks are the replay's own, never a busy machine's (failed once under load); 3.6 s to 0.05 s.                                                                                 | 8     | 3.6 s  | 0.1 s  |
| `lib/core/browser/install.test.ts`    | keep     | Boundary: Chromium only from Playwright's pinned addresses, bounded, in-process.                                                                                                                                                                        | 9     | 0.9 s  | 1.2 s  |
| `lib/core/browser/lanes.test.ts`      | keep     | A tab's lane under slow and crashed pages; deadlines already lowered.                                                                                                                                                                                   | 8     | 23.9 s | 22.8 s |
| `lib/core/browser/launch.test.ts`     | keep     | Launch mode decisions; never the automation switch.                                                                                                                                                                                                     | 20    | 0.1 s  | 0.1 s  |
| `lib/core/browser/owner.test.ts`      | keep     | Hand-over and tabs view (#31) against real Chromium.                                                                                                                                                                                                    | 12    | 16.6 s | 12.8 s |
| `lib/core/browser/profile.test.ts`    | keep     | Boundary: the profile encrypted, another vault's key refused.                                                                                                                                                                                           | 4     | 1.5 s  | 1.0 s  |
| `lib/core/browser/proxy.test.ts`      | keep     | Boundary: the proxy checks every resolved address before connecting. Adds a tunnel to an allowed address that does not answer: closed, never established (the browser suites reached that path only when Chromium's own background connections failed). | 6 → 7 | 0.1 s  | 0.0 s  |
| `lib/core/browser/queue.test.ts`      | keep     | Lane ordering and deadlines, without Chromium.                                                                                                                                                                                                          | 7     | 0.1 s  | 0.1 s  |
| `lib/core/browser/read-page.test.ts`  | keep     | Text extraction rules.                                                                                                                                                                                                                                  | 3     | 0.0 s  | 0.0 s  |
| `lib/core/browser/requests.test.ts`   | keep     | Owner's answers to site and hand-over requests.                                                                                                                                                                                                         | 8     | 3.3 s  | 2.3 s  |
| `lib/core/browser/restore.test.ts`    | keep     | Regression: a restore and a running browser.                                                                                                                                                                                                            | 2     | 5.0 s  | 4.9 s  |
| `lib/core/browser/screencast.test.ts` | keep     | Viewer limits.                                                                                                                                                                                                                                          | 2     | 0.0 s  | 0.0 s  |
| `lib/core/browser/screenshot.test.ts` | keep     | Size-fitting logic.                                                                                                                                                                                                                                     | 5     | 0.0 s  | 0.0 s  |
| `lib/core/browser/secrets.test.ts`    | keep     | Boundary (#32): typed secrets never shown, screenshots refused while held; required by CLAUDE.md.                                                                                                                                                       | 8     | 14.6 s | 13.4 s |
| `lib/core/browser/snapshot.test.ts`   | keep     | Snapshot parsing and masking.                                                                                                                                                                                                                           | 9     | 0.0 s  | 0.0 s  |
| `lib/core/browser/solve.test.ts`      | keep     | Boundary: GET only, its own context, the same site. Faster: the check's wait lowered in the test (20 s to 3 s) as call.test.ts already did; 29.7 s to about 9 s.                                                                                        | 9     | 29.7 s | 12.4 s |
| `lib/core/browser/target.test.ts`     | keep     | Target matching logic.                                                                                                                                                                                                                                  | 6     | 0.0 s  | 0.0 s  |
| `lib/core/browser/tools.test.ts`      | keep     | Boundary: no tool runs code or reads sign-ins; files only as kept results.                                                                                                                                                                              | 8     | 0.1 s  | 0.1 s  |

### Calendar accounts (`lib/core/caldav/`)

| File                               | Verdict | Why                                                                                | Tests | Before | After |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------- | ----- | ------ | ----- |
| `lib/core/caldav/accounts.test.ts` | keep    | Required by CLAUDE.md: a test per calendar tool and argument, against fake-caldav. | 17    | 6.8 s  | 3.2 s |
| `lib/core/caldav/ical.test.ts`     | keep    | Recurrence and zone logic.                                                         | 16    | 0.2 s  | 0.3 s |
| `lib/core/caldav/xml.test.ts`      | keep    | Untrusted XML parsing.                                                             | 6     | 0.0 s  | 0.0 s |
| `lib/core/caldav/zones.test.ts`    | keep    | DST edge cases.                                                                    | 11    | 0.2 s  | 0.2 s |

### run_code (`lib/core/code/`)

| File                            | Verdict | Why                                                                             | Tests | Before | After  |
| ------------------------------- | ------- | ------------------------------------------------------------------------------- | ----- | ------ | ------ |
| `lib/core/code/quickjs.test.ts` | keep    | Boundary: the program reaches nothing of Node; limits.                          | 32    | 2.7 s  | 2.9 s  |
| `lib/core/code/run.test.ts`     | keep    | Boundary: the bridge, levels, asks, media (#28); required per bridge operation. | 44    | 25.7 s | 19.8 s |
| `lib/core/code/sandbox.test.ts` | keep    | The sandbox runner behind the same bridge (skipped without a runner).           | 11    | 3.3 s  | 3.6 s  |

### Web fetch (`lib/core/fetch/`)

| File                               | Verdict | Why                                                                                      | Tests | Before | After |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------------- | ----- | ------ | ----- |
| `lib/core/fetch/challenge.test.ts` | keep    | Header detection; milliseconds.                                                          | 2     | 0.0 s  | 0.0 s |
| `lib/core/fetch/fetch.test.ts`     | keep    | Boundary: redirects to another site stop, public addresses only, PCP's own port refused. | 17    | 0.1 s  | 0.1 s |
| `lib/core/fetch/html.test.ts`      | keep    | Markdown conversion and decoding.                                                        | 4     | 0.0 s  | 0.0 s |
| `lib/core/fetch/request.test.ts`   | keep    | Boundary: never a credential or a header PCP owns.                                       | 4     | 0.0 s  | 0.0 s |
| `lib/core/fetch/rules.test.ts`     | keep    | Level resolution logic.                                                                  | 11    | 0.0 s  | 0.0 s |

### Mail accounts (`lib/core/mail/`)

| File                              | Verdict | Why                                                                                                  | Tests | Before | After |
| --------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- | ----- | ------ | ----- |
| `lib/core/mail/accounts.test.ts`  | keep    | Boundary: the password nowhere in answers; read-only accounts refuse writing tools; Sent copy (#34). | 29    | 12.1 s | 6.1 s |
| `lib/core/mail/addresses.test.ts` | keep    | Boundary: http:// only to private addresses; header injection.                                       | 19    | 0.0 s  | 0.0 s |
| `lib/core/mail/html.test.ts`      | keep    | Regression: bounded on input made to be slow.                                                        | 8     | 0.2 s  | 0.3 s |
| `lib/core/mail/imap.test.ts`      | keep    | Protocol logic; delete to Trash only; Sent copy logic (#34).                                         | 53    | 0.1 s  | 0.1 s |
| `lib/core/mail/jmap.test.ts`      | keep    | Boundary: same-origin addresses, no redirect followed, credential to its origin only.                | 45    | 0.4 s  | 0.4 s |
| `lib/core/mail/probe.test.ts`     | keep    | Boundary: probes with no credential, public addresses only.                                          | 12    | 0.1 s  | 0.1 s |
| `lib/core/mail/tools.test.ts`     | keep    | Required by CLAUDE.md: arguments checked before anything connects.                                   | 26    | 0.1 s  | 0.2 s |

### Network: HTTPS, dynamic DNS, pcp.gg (`lib/core/network/`)

| File                                      | Verdict  | Why                                                                                                                           | Tests | Before | After |
| ----------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ----- |
| `lib/core/network/acme-issuer.test.ts`    | keep     | Challenge fallbacks.                                                                                                          | 6     | 0.5 s  | 0.5 s |
| `lib/core/network/client-hello.test.ts`   | keep     | TLS parsing of untrusted bytes.                                                                                               | 3     | 0.0 s  | 0.1 s |
| `lib/core/network/ddns.test.ts`           | keep     | Per-provider protocols, back-off, credentials never shown.                                                                    | 27    | 0.3 s  | 0.3 s |
| `lib/core/network/edge.test.ts`           | keep     | Ports 80 and 443: challenge only, forwarded headers replaced.                                                                 | 11    | 0.3 s  | 0.3 s |
| `lib/core/network/pcpgg-runtime.test.ts`  | keep     | Boundary: nothing runs while off; names only under pcp.gg's domain.                                                           | 9     | 6.6 s  | 5.8 s |
| `lib/core/network/pcpgg.test.ts`          | keep     | Boundary: the pcp.gg key stays out of an export.                                                                              | 11    | 0.0 s  | 0.0 s |
| `lib/core/network/pcpgg/protocol.test.ts` | keep     | Wire protocol shared with pcp.gg.                                                                                             | 15    | 0.1 s  | 0.1 s |
| `lib/core/network/pcpgg/tunnel.test.ts`   | sturdier | Boundary: the relay sees only ciphertext. Now waits for the relay to let a revoked name go (read too early once, under load). | 8     | 0.3 s  | 0.3 s |
| `lib/core/network/pebble.test.ts`         | keep     | Real ACME against Pebble (skipped without one).                                                                               | 3     | 0.0 s  | 0.0 s |
| `lib/core/network/proxy.test.ts`          | keep     | Regression: request smuggling through a chunked GET.                                                                          | 2     | 0.1 s  | 0.0 s |
| `lib/core/network/runtime.test.ts`        | keep     | Boundary: opens nothing while off.                                                                                            | 3     | 0.5 s  | 0.6 s |
| `lib/core/network/tls.test.ts`            | keep     | Renewal and back-off logic.                                                                                                   | 13    | 0.5 s  | 0.1 s |

### API endpoints from OpenAPI (`lib/core/openapi/`)

| File                                 | Verdict | Why                                                                                                                                                                                    | Tests   | Before | After |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ----- |
| `lib/core/openapi/address.test.ts`   | keep    | Boundary: public and own addresses.                                                                                                                                                    | 11      | 0.0 s  | 0.0 s |
| `lib/core/openapi/call.test.ts`      | trim    | Boundary: no redirect followed, byte cap, redaction of real answers. Merged out three tests that only called redactSecrets, which redact.test.ts covers (its extra cases moved there). | 22 → 19 | 0.3 s  | 0.3 s |
| `lib/core/openapi/generate.test.ts`  | keep    | A schema is untrusted input: limits and edge cases.                                                                                                                                    | 40      | 2.3 s  | 2.6 s |
| `lib/core/openapi/lint.test.ts`      | keep    | Lint findings and their fixes.                                                                                                                                                         | 2       | 0.0 s  | 0.0 s |
| `lib/core/openapi/oauth.test.ts`     | keep    | Reading OAuth flows from a schema.                                                                                                                                                     | 4       | 0.0 s  | 0.0 s |
| `lib/core/openapi/parse.test.ts`     | keep    | Untrusted YAML: alias bombs, tags, **proto**.                                                                                                                                          | 12      | 1.3 s  | 1.6 s |
| `lib/core/openapi/patch.test.ts`     | keep    | JSON Patch edge cases and bounds.                                                                                                                                                      | 12      | 0.5 s  | 0.6 s |
| `lib/core/openapi/redact.test.ts`    | merge   | Takes call.test.ts's pure redaction cases (a key wrapped in a header, a cut that did not reach it).                                                                                    | 9       | 0.0 s  | 0.0 s |
| `lib/core/openapi/refs.test.ts`      | keep    | Boundary: never a remote $ref; fan-out bounds.                                                                                                                                         | 11      | 0.0 s  | 0.0 s |
| `lib/core/openapi/request.test.ts`   | keep    | Boundary: an argument never sets a header or leaves the base URL.                                                                                                                      | 31      | 0.0 s  | 0.0 s |
| `lib/core/openapi/schema.test.ts`    | keep    | Schema conversion rules.                                                                                                                                                               | 7       | 0.0 s  | 0.0 s |
| `lib/core/openapi/transport.test.ts` | keep    | Boundary: public-only transport, every redirect hop checked.                                                                                                                           | 17      | 0.3 s  | 0.4 s |

### Linked repositories (`lib/core/repos/`)

| File                                   | Verdict | Why                                                                                                  | Tests   | Before | After |
| -------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- | ------- | ------ | ----- |
| `lib/core/repos/apply.test.ts`         | keep    | Boundary: never writes an instance's own fields.                                                     | 9       | 8.1 s  | 5.1 s |
| `lib/core/repos/assist-share.test.ts`  | keep    | Required: a new way in gets a test against fake-github.                                              | 5       | 2.7 s  | 1.8 s |
| `lib/core/repos/assist.test.ts`        | keep    | Required: a new way in gets a test against fake-github.                                              | 3       | 1.7 s  | 1.4 s |
| `lib/core/repos/documents.test.ts`     | keep    | Boundary: no secret in a file; hostile repositories refused.                                         | 17      | 4.0 s  | 3.3 s |
| `lib/core/repos/github.test.ts`        | keep    | Boundary: no redirect, bounded answers, git ids checked; a release never reads the fake's addresses. | 11 → 12 | 1.8 s  | 1.3 s |
| `lib/core/repos/personal-data.test.ts` | keep    | Detector logic (#37).                                                                                | 14      | 0.0 s  | 0.0 s |
| `lib/core/repos/review.test.ts`        | keep    | What raises a flag.                                                                                  | 15      | 0.0 s  | 0.1 s |
| `lib/core/repos/share-review.test.ts`  | keep    | Boundary: Confirm pushes exactly what was shown.                                                     | 7       | 3.4 s  | 2.5 s |
| `lib/core/repos/sync.test.ts`          | keep    | Boundary: fast-forward only, one commit per item, trust rules.                                       | 20      | 8.7 s  | 4.4 s |

### Wrappers (`lib/core/wrappers/`)

| File                                     | Verdict | Why                                                                            | Tests | Before | After  |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------ | ----- | ------ | ------ |
| `lib/core/wrappers/flows.test.ts`        | keep    | Browser flows against real Chromium.                                           | 3     | 7.3 s  | 7.6 s  |
| `lib/core/wrappers/placeholders.test.ts` | keep    | Boundary: secrets only at bound places, scrubbed.                              | 5     | 0.0 s  | 0.0 s  |
| `lib/core/wrappers/schema-check.test.ts` | keep    | Output schema checks, bounded.                                                 | 9     | 0.1 s  | 0.1 s  |
| `lib/core/wrappers/wrappers.test.ts`     | keep    | Required by CLAUDE.md: a test per field an assistant can set; secret bindings. | 50    | 25.7 s | 17.3 s |

### SSH, pacing, cleanup, resources, updates, OAuth server

| File                                         | Verdict | Why                                                                             | Tests | Before | After |
| -------------------------------------------- | ------- | ------------------------------------------------------------------------------- | ----- | ------ | ----- |
| `lib/core/cleanup/cleanup.test.ts`           | keep    | Required by CLAUDE.md: each part of the cleanup, and the schedule's bound.      | 13    | 5.6 s  | 3.0 s |
| `lib/core/oauth-server/oauth-server.test.ts` | keep    | Required by CLAUDE.md: PKCE, exact redirect URIs, single-use codes, revocation. | 36    | 11.8 s | 4.6 s |
| `lib/core/pacing/config.test.ts`             | keep    | Policy resolution and bounds.                                                   | 8     | 2.7 s  | 1.4 s |
| `lib/core/pacing/entry-points.test.ts`       | keep    | Boundary: every way in is paced.                                                | 7     | 3.3 s  | 2.4 s |
| `lib/core/pacing/pace.test.ts`               | keep    | Slot logic.                                                                     | 11    | 0.1 s  | 0.1 s |
| `lib/core/resources/state.test.ts`           | keep    | Limits from the machine, within bounds.                                         | 11    | 0.5 s  | 0.5 s |
| `lib/core/ssh/client.test.ts`                | keep    | Required by CLAUDE.md: host trust and signing in against the test server.       | 11    | 3.3 s  | 3.4 s |
| `lib/core/ssh/hosts.test.ts`                 | keep    | Boundary: an assistant never pins a host key.                                   | 15    | 11.0 s | 9.5 s |
| `lib/core/ssh/keys.test.ts`                  | keep    | Key formats.                                                                    | 4     | 0.6 s  | 0.8 s |
| `lib/core/updates/check.test.ts`             | keep    | Boundary: untrusted answers, nothing but the version sent.                      | 26    | 0.1 s  | 0.1 s |
| `lib/core/updates/runtime.test.ts`           | keep    | Boundary: no timer or request while off, nothing before setup.                  | 17    | 1.9 s  | 1.0 s |
| `lib/core/updates/semver.test.ts`            | keep    | Version ordering edge cases.                                                    | 8     | 0.0 s  | 0.0 s |

### The rest of the core (`lib/core/*.test.ts`)

| File                                     | Verdict | Why                                                                                                                                                                            | Tests | Before | After  |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ | ------ |
| `lib/core/access-requests.test.ts`       | keep    | Boundary: proposed tool levels are written only by the owner's save; pattern logic.                                                                                            | 15    | 2.1 s  | 1.5 s  |
| `lib/core/activity.test.ts`              | keep    | The Log page reads only the vault's own lines.                                                                                                                                 | 3     | 1.3 s  | 0.8 s  |
| `lib/core/after-answer.test.ts`          | keep    | Ordering logic of work handed on after an answer.                                                                                                                              | 3     | 0.0 s  | 0.0 s  |
| `lib/core/allowances.test.ts`            | keep    | Boundary: Allow for never lifts a block; cleanup removes the ones that ran out.                                                                                                | 4     | 1.4 s  | 0.8 s  |
| `lib/core/answers.test.ts`               | keep    | Long-answer and handle logic, many branches.                                                                                                                                   | 39    | 0.1 s  | 0.1 s  |
| `lib/core/api-tokens.test.ts`            | keep    | Boundary: confirmOwner for an expired token's new expiry.                                                                                                                      | 3     | 1.0 s  | 0.6 s  |
| `lib/core/backup.test.ts`                | keep    | Boundary: export carries no session or Touch ID; restore covers every table and older files; never undoes a revocation. Faster: cheaper scrypt in tests.                       | 26    | 37.5 s | 14.0 s |
| `lib/core/browser-secrets.test.ts`       | keep    | Boundary (#32): a secret is typed only through the gate, never shown; new in this run, required by CLAUDE.md.                                                                  | 22    | 9.5 s  | 5.3 s  |
| `lib/core/call-handles.test.ts`          | keep    | Boundary: call_tool takes only an HMAC call_handle and checks arguments first.                                                                                                 | 14    | 5.5 s  | 2.6 s  |
| `lib/core/client-hello.test.ts`          | keep    | Boundary: never keeps a header's value but the user agent's.                                                                                                                   | 8     | 0.0 s  | 0.0 s  |
| `lib/core/connect.test.ts`               | keep    | Small result-shaping logic; milliseconds.                                                                                                                                      | 3     | 0.0 s  | 0.0 s  |
| `lib/core/crypto.test.ts`                | keep    | Boundary: encryption with the row id as associated data, grants. Adds a test that pins the real scrypt cost the suite lowers.                                                  | 8 → 9 | 0.7 s  | 0.2 s  |
| `lib/core/definitions.test.ts`           | keep    | Boundary (#37): shared content reaches every instance, the note never goes into a repository.                                                                                  | 20    | 7.1 s  | 3.5 s  |
| `lib/core/device-keys.test.ts`           | keep    | Boundary: the Touch ID key stands in for the password only where CLAUDE.md says.                                                                                               | 4     | 2.2 s  | 1.1 s  |
| `lib/core/endpoint-admin.test.ts`        | keep    | Boundary: what an assistant may do to an endpoint; a test per field it can set (required).                                                                                     | 51    | 18.9 s | 8.7 s  |
| `lib/core/endpoint-edits.test.ts`        | keep    | Boundary: schema edits, a changed document at a proposed URL needs the owner.                                                                                                  | 25    | 9.4 s  | 5.7 s  |
| `lib/core/endpoint-oauth.test.ts`        | keep    | Boundary: metadata counts only with the approved addresses; no private address.                                                                                                | 11    | 4.4 s  | 2.4 s  |
| `lib/core/endpoints.test.ts`             | keep    | Boundary: where a secret may go, never in an answer; logic of refresh and edits.                                                                                               | 44    | 16.2 s | 8.9 s  |
| `lib/core/file-links.test.ts`            | keep    | Boundary: a link's secret is the credential for one file, an hour, a few uses.                                                                                                 | 9     | 3.6 s  | 2.1 s  |
| `lib/core/gateway.test.ts`               | keep    | Re-read timing logic and updateServer's change detection.                                                                                                                      | 7     | 1.3 s  | 0.9 s  |
| `lib/core/instructions-defaults.test.ts` | keep    | The shipped suggestion passes the owner's own check; milliseconds.                                                                                                             | 2     | 0.0 s  | 0.0 s  |
| `lib/core/instructions.test.ts`          | keep    | Encrypted per row, merge with a newer suggestion, conflict handling.                                                                                                           | 11    | 3.8 s  | 2.1 s  |
| `lib/core/item-about.test.ts`            | keep    | About card states (#37); branches.                                                                                                                                             | 3     | 1.7 s  | 1.4 s  |
| `lib/core/json-result.test.ts`           | keep    | Credential kept out of results.                                                                                                                                                | 4     | 0.0 s  | 0.0 s  |
| `lib/core/kept-results-in-calls.test.ts` | keep    | Boundary: a handle is replaced only with the token's own results, before sending.                                                                                              | 6     | 2.6 s  | 1.7 s  |
| `lib/core/line-merge.test.ts`            | keep    | Three-way merge logic.                                                                                                                                                         | 7     | 0.0 s  | 0.0 s  |
| `lib/core/list-secrets.test.ts`          | keep    | Boundary: names only, never a value.                                                                                                                                           | 4     | 2.0 s  | 1.3 s  |
| `lib/core/local-address.test.ts`         | keep    | Address classification edge cases.                                                                                                                                             | 5     | 0.0 s  | 0.0 s  |
| `lib/core/media-types.test.ts`           | keep    | Sniffing and charset logic.                                                                                                                                                    | 10    | 0.0 s  | 0.0 s  |
| `lib/core/memories.test.ts`              | keep    | Boundary: shared memories only as the owner read them; only the owner marks always; migration (#30).                                                                           | 44    | 14.0 s | 5.2 s  |
| `lib/core/migrate.test.ts`               | keep    | Boundary: migrations apply once, keep rows through every migration, refuse an edited one. Still applies every migration itself; the other suites now copy a migrated template. | 3     | 0.2 s  | 0.2 s  |
| `lib/core/oauth-client.test.ts`          | keep    | Registration choice and reserved parameters.                                                                                                                                   | 16    | 0.0 s  | 0.0 s  |
| `lib/core/oauth.test.ts`                 | keep    | Boundary: no private address for a public-only server; tokens kept out of answers.                                                                                             | 19    | 5.9 s  | 2.8 s  |
| `lib/core/owner-queue.test.ts`           | keep    | Oldest-first queue and next-request logic (#29).                                                                                                                               | 5     | 1.9 s  | 1.3 s  |
| `lib/core/owner-wait.test.ts`            | keep    | check_permission's wait gives up and stops with the client.                                                                                                                    | 3     | 0.1 s  | 0.1 s  |
| `lib/core/permission-rules.test.ts`      | keep    | What the owner is shown: invisible characters written out, arguments in full.                                                                                                  | 23    | 0.7 s  | 0.7 s  |
| `lib/core/permissions.test.ts`           | keep    | Boundary: owner approval writes only what was shown; runs once under races; withdraw (#33).                                                                                    | 65    | 25.1 s | 13.1 s |
| `lib/core/rate-limit.test.ts`            | keep    | Bounded store logic.                                                                                                                                                           | 4     | 0.1 s  | 0.1 s  |
| `lib/core/read-only-tools.test.ts`       | keep    | Boundary: call_read_only_tool refuses a tool not marked read-only and keeps the levels.                                                                                        | 8     | 3.1 s  | 1.9 s  |
| `lib/core/register-rules.test.ts`        | keep    | Required by CLAUDE.md: a test for each register_server argument.                                                                                                               | 28    | 0.0 s  | 0.0 s  |
| `lib/core/register-server.test.ts`       | keep    | Required by CLAUDE.md: register_server arguments; private addresses flagged to the owner only.                                                                                 | 30    | 10.6 s | 4.7 s  |
| `lib/core/request-log.test.ts`           | keep    | Boundary: names only, bounded, pruned by date.                                                                                                                                 | 10    | 0.6 s  | 0.2 s  |
| `lib/core/result-handles.test.ts`        | keep    | Handle resolution limits and refusals.                                                                                                                                         | 13    | 0.1 s  | 0.0 s  |
| `lib/core/search.test.ts`                | keep    | Ranking logic (the gateway layer in skills.test.ts checks the wiring, not the ranking).                                                                                        | 13    | 0.0 s  | 0.0 s  |
| `lib/core/servers.test.ts`               | keep    | OAuth tokens dropped when the configuration changes; Basic login checks.                                                                                                       | 16    | 3.4 s  | 1.6 s  |
| `lib/core/skills.test.ts`                | keep    | Boundary: a skill change writes only what was shown, at the version shown; SKILL.md compatibility.                                                                             | 28    | 11.3 s | 4.5 s  |
| `lib/core/tool-access.test.ts`           | keep    | Levels for all tokens; a token's own wins.                                                                                                                                     | 9     | 3.1 s  | 2.0 s  |
| `lib/core/tool-results.test.ts`          | keep    | Boundary: kept results encrypted, for the token, a day, capped.                                                                                                                | 25    | 15.2 s | 9.8 s  |
| `lib/core/totp.test.ts`                  | keep    | RFC test vectors and seed parsing (#32).                                                                                                                                       | 24    | 0.0 s  | 0.0 s  |
| `lib/core/upstream.test.ts`              | keep    | Boundary: a credential scrubbed from answers; public-only servers refuse private addresses.                                                                                    | 12    | 4.4 s  | 2.7 s  |
| `lib/core/vault-reset.test.ts`           | keep    | Boundary: wipeVault counts every table (required).                                                                                                                             | 3     | 1.9 s  | 1.4 s  |
| `lib/core/vault.test.ts`                 | keep    | Boundary: setup, sign-in, recovery, revocation.                                                                                                                                | 13    | 8.4 s  | 2.9 s  |
| `lib/core/web-fetch.test.ts`             | keep    | Boundary: private addresses only by the owner's line, never PCP's own; a site's own decision.                                                                                  | 25    | 8.9 s  | 3.5 s  |

### Files around the app (`scripts/`)

| File                                  | Verdict | Why                                          | Tests | Before | After |
| ------------------------------------- | ------- | -------------------------------------------- | ----- | ------ | ----- |
| `scripts/fingerprint/diff.test.ts`    | keep    | Diff logic of the fingerprint harness (#38). | 7     | 0.0 s  | 0.0 s |
| `scripts/fingerprint/harness.test.ts` | keep    | The harness loads and sends nothing (#38).   | 2     | 3.2 s  | 3.1 s |

## E2E specs

Times are the spec's tests summed, in one run each.

| Spec                                     | Verdict  | Why                                                                                                                                                                                                                                                                                 | Tests | Dev server, before | Build, after | Result after       |
| ---------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------ | ------------ | ------------------ |
| `e2e/tests/setup.spec.ts`                | keep     | Flow: setup and sign-in; signs each project in (infrastructure for the rest).                                                                                                                                                                                                       | 3     | 56.5 s             | 18.6 s       | all passed         |
| `e2e/tests/secrets.spec.ts`              | keep     | Flow: adding, revealing, rotating a secret; a one-time codes secret (#32).                                                                                                                                                                                                          | 2     | 17.0 s             | 13.4 s       | 1 failed, 1 passed |
| `e2e/tests/gateway.spec.ts`              | keep     | Flow: adding a server and calling it through /mcp with the secret added by PCP.                                                                                                                                                                                                     | 9     | 45.4 s             | 10.7 s       | all passed         |
| `e2e/tests/oauth.spec.ts`                | keep     | Flow: an OAuth server connected through the browser.                                                                                                                                                                                                                                | 1     | 19.5 s             | 3.8 s        | all passed         |
| `e2e/tests/oauth-server.spec.ts`         | keep     | Flow: an app signs in to /mcp through PCP's own authorization server.                                                                                                                                                                                                               | 5     | 12.8 s             | 2.7 s        | all passed         |
| `e2e/tests/endpoint-oauth.spec.ts`       | keep     | Flow: an API that signs in with OAuth, its secret typed on PCP's page.                                                                                                                                                                                                              | 2     | 15.5 s             | 3.9 s        | all passed         |
| `e2e/tests/oauth-client.spec.ts`         | keep     | Flow: the owner's own OAuth client. Waits on the saved form before Connect.                                                                                                                                                                                                         | 1     | 60.5 s             | 1.6 s        | all passed         |
| `e2e/tests/endpoints.spec.ts`            | keep     | Flow: API endpoints added, proposed and changed through the owner.                                                                                                                                                                                                                  | 6     | 47.5 s             | 9.4 s        | all passed         |
| `e2e/tests/mail.spec.ts`                 | keep     | Flow: a mail account added, used, proposed.                                                                                                                                                                                                                                         | 4     | 28.9 s             | 6.1 s        | all passed         |
| `e2e/tests/calendar.spec.ts`             | keep     | Flow: a calendar account added, used, proposed.                                                                                                                                                                                                                                     | 3     | 18.8 s             | 3.9 s        | all passed         |
| `e2e/tests/ssh.spec.ts`                  | keep     | Flow: an SSH server, host key pinning, a command shown first.                                                                                                                                                                                                                       | 3     | 20.4 s             | 6.4 s        | all passed         |
| `e2e/tests/permissions.spec.ts`          | sturdier | Flow: answering a permission request (link, bell, queue, Allow for, withdraw). Clearing what waits decides on a settled page, and the bell's page is checked by its heading; before, its second test failed and the other eight never ran, so its dev-server time covers two tests. | 10    | 23.0 s             | 23.3 s       | all passed         |
| `e2e/tests/memories.spec.ts`             | trim     | Flow: sharing a memory through the owner. Dropped the second token that showed a token without the switch gets no memory tool (memories.test.ts pins it).                                                                                                                           | 6     | 35.3 s             | 7.6 s        | all passed         |
| `e2e/tests/skills.spec.ts`               | keep     | Flow: skills written, found, changed through the owner.                                                                                                                                                                                                                             | 3     | 16.3 s             | 3.7 s        | all passed         |
| `e2e/tests/definitions.spec.ts`          | keep     | Flow (#37): About card, note, clone, detach. First run in this workstream.                                                                                                                                                                                                          | 4     | 16.1 s             | 4.4 s        | all passed         |
| `e2e/tests/repositories.spec.ts`         | sturdier | Flow (#37): linked repositories against the fake GitHub, which only a test build may reach. Its dialogs open once their trigger is hydrated (it failed on the dev server when clicked before).                                                                                      | 4     | 51.4 s             | 7.5 s        | all passed         |
| `e2e/tests/endpoint-credentials.spec.ts` | keep     | Flow: Basic and two-header credentials kept from the assistant.                                                                                                                                                                                                                     | 2     | 29.4 s             | 6.6 s        | all passed         |
| `e2e/tests/web-fetch.spec.ts`            | trim     | Flow: a new site asks the owner. Dropped the second token that showed a token without the switch gets no web_fetch (web-fetch.test.ts pins it).                                                                                                                                     | 3     | 23.6 s             | 4.1 s        | all passed         |
| `e2e/tests/run-code.spec.ts`             | trim     | Flow: run_code calling tools, an ask stopping it. Dropped the second token without the switch (run.test.ts pins it).                                                                                                                                                                | 3     | 23.7 s             | 4.9 s        | all passed         |
| `e2e/tests/file-links.spec.ts`           | trim     | Flow: a file moved by link. Dropped the token without the switch (file-links.test.ts pins it).                                                                                                                                                                                      | 2     | 14.7 s             | 2.2 s        | all passed         |
| `e2e/tests/wrappers.spec.ts`             | keep     | Flow: a wrapper proposed, its key typed in, never seen by the assistant.                                                                                                                                                                                                            | 3     | 22.3 s             | 5.6 s        | all passed         |
| `e2e/tests/browser.spec.ts`              | sturdier | Flow: the browser added, a site asked about, hand-over in the tabs view (#31). The answer that starts Chromium waits up to 30 s (it took over 10 on a machine that had just started).                                                                                               | 4     | 47.3 s             | 9.4 s        | all passed         |
| `e2e/tests/log.spec.ts`                  | keep     | Flow: the Log page shows calls by name, never what they sent.                                                                                                                                                                                                                       | 1     | 10.5 s             | 2.5 s        | all passed         |
| `e2e/tests/touch-id.spec.ts`             | keep     | Flow: Touch ID with a stand-in for the Mac app.                                                                                                                                                                                                                                     | 3     | 22.9 s             | 6.1 s        | all passed         |
| `e2e/tests/recovery.spec.ts`             | keep     | Flow: recovery key, signing out everywhere.                                                                                                                                                                                                                                         | 3     | 34.6 s             | 11.5 s       | all passed         |
| `e2e/tests/backup.spec.ts`               | keep     | Flow: export and restore.                                                                                                                                                                                                                                                           | 2     | 33.2 s             | 11.2 s       | all passed         |
| `e2e/tests/reset.spec.ts`                | keep     | Flow: deleting the vault and setting up again.                                                                                                                                                                                                                                      | 1     | 17.4 s             | 5.0 s        | all passed         |
