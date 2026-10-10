# Design

How PCP's owner pages look and behave, and why. The components in
`components/ui/` carry the look; this file is what they cannot say on their
own: when to use which, what goes where, and the rules a new page follows.
Copy (the words) follows CLAUDE.md › Copy.

## Principles

1. **Simple first, powerful one click down.** Each page shows what the owner
   uses every week. What they set once and rarely look at again sits under a
   disclosure or on a page of its own, never removed: no feature is lost to
   make a page simpler.
2. **Opinionated defaults.** Every choice has a default that is right for
   most people, and the page says so ("Recommended", or a grey line under
   the control). The owner should be able to accept every default and end
   up safe.
3. **One primary action per view.** One teal button per page or sheet, the
   thing the page is for. Everything else is grey or plain text.
4. **What needs the owner comes first.** A request waiting for an answer, a
   server that needs signing in again: amber, at the top, with the button
   that settles it.
5. **The owner reads what an assistant proposed in full.** Simplicity never
   hides what is about to happen: a program, an address, a secret's place
   is shown whole on the page that asks.

## Navigation

The sidebar (`components/app-sidebar.tsx`) has two groups:

- **Every day:** Home, Servers, Assistants, Memories.
- **Now and then:** Secrets, Log, Settings.

At the bottom: the update notice, the owner's name and **Lock**. The bell
next to the logo lists what is waiting; Home shows the same count. On a
narrow window (under 768px) the sidebar becomes a bar across the top with
the items in one scrolling row.

A page under another (a server's page under Servers) has a back link above
its title, not an entry in the sidebar. The browser belongs to Servers (it
is a server); its page highlights Servers.

"Assistants" is the menu's name for API tokens: each assistant connects
with a token of its own. Inside the pages the thing is still called an "API
token" where the token itself is meant (creating, revoking, copying it).

## Pages

`PageColumn` (`components/page-column.tsx`) sets the width: the layout's
960px for lists and Home, `narrow` (820px) for one thing's page and for
Settings. Sections stand 32px apart.

A page starts with `PageHeader`: an optional back link, an optional icon
tile (on one server's page), the title (28–30px, bold), one grey line, and
the page's own action at the right. Destructive actions (remove, revoke,
delete) go last on the page, centred, as red text, with a grey line saying
what happens.

## Lists

Most of PCP is grouped lists (`components/ui/list.tsx`), as in the Mac's
settings:

- `ListSection`: the small grey heading above, an optional link at its
  right ("See all"), a caption under.
- `List`: the rounded panel, hairlines between rows. `as="ul"` with rows
  `as="li"` when the rows are items (servers, secrets, tokens).
- `ListRow`: icon, title, grey line, then what sits at the right. With
  `href` the row is a link and ends in a chevron. Rows are at least 56px
  tall.
- `SwitchRow` (`components/ui/switch.tsx`): a label and a switch, the
  switch at the right. Use it for anything on/off; the label names the
  switch for assistive technology and tests.
- `RowValue`: a grey value at a row's right ("Never", "2").

Use a `Card` for what is not rows: a form, a block of text, a code sample.

## Controls

- **Buttons** (`components/ui/button.tsx`): `default` (teal) for the one
  primary action; `secondary` (filled grey, also `outline`) for the rest;
  `ghost` (teal text) for an action inside a row; `plain` (grey text) for a
  quiet one; `destructive` (red text). Sizes: `default` 36px, `sm` 32px for
  inside rows, `lg` 44px for the decision buttons on a request.
- **Switch** for on/off. A checkbox only where it reads as a list of
  choices (servers a token reaches) or as "also for all tokens".
- **SegmentedControl** (`components/ui/segmented-control.tsx`) for two to
  four exclusive choices that fit on a line: a tool's level (Allow / Ask /
  Block, tinted with `tone`), a filter, a sign-in kind. Over four, a
  `Select`.
- **Fields**: `Field` puts the label above and a grey hint under. Inputs
  are 40px, on the darker field colour.
- **Disclosure** (`components/ui/disclosure.tsx`) for "Advanced": a row
  with the title and a grey line naming what is inside, so the owner knows
  whether to open it. Native `<details>`: forms inside still submit.
- **Dialog** (`components/ui/dialog.tsx`) for a short task that should not
  lose the page behind it: connecting an assistant. The primary button is
  last, at the right.
- **Menu** (`components/ui/menu.tsx`) for a button's list of choices: the
  bell, Add on Servers.
- **IconTile** (`components/ui/icon-tile.tsx`): a server's kind picks its
  tint and symbol (MCP blue, API orange, mail purple, browser teal, SSH
  grey, wrapper green), so kinds tell apart in a list at a glance.
- **Badge**: a short state beside a name ("Read-only", "Changes data").
  `solid-warning` only for what needs the owner now ("Sign in again").
  `CountBadge` for counts waiting; `StatusDot` before a status line.

## What goes where

| Shown on the page                               | Folded (Disclosure) or one page down                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| A server's description, sign-in state, on/off   | Its address, headers, sign-in app (OAuth client), private addresses    |
| Its tools                                       | Each tool's description in the owner's words                           |
| An endpoint's read-only switch                  | Schema source, base URL, sign-in kind, JSON Patch edits, public-only   |
| What an assistant reaches; memories, web, code  | Expiry, every tool's level, web methods and sites, what it may propose |
| Connecting an assistant: which app, name, reach | More options: expiry, memories, web, code, endpoints, wrappers         |
| Settings: address, updates, sign-in, backup     | Network (public address, outside access, pcp.gg, DNS, HTTPS), upkeep   |
| A request: what will happen, in plain words     | "Show exactly what will be sent": the raw arguments                    |

Anything an assistant proposes (a server, an endpoint change, a wrapper, a
shared memory) is never folded on the page that asks the owner: they read
it whole before they agree.

## Patterns built on these

Reuse these before writing a new one; each settles a question once.

- **Asking the owner** (`components/permission-actions.tsx`): the
  decision buttons of a request, the main yes last at the right (on top on
  a phone), at most three in the row; a smaller choice ("Allow for" and its
  time) at the left under them, rarer answers (Block, Discard) as quiet
  text at the right; then "Nothing runs until you answer". What the
  request carries is `PermissionLines`, and `ShownInFull` when the lines
  cut it short. The token page's waiting requests use the same pieces.
- **A server's form** (`components/server-form-parts.tsx`): the frame,
  sections, name and short name, a choice field (segmented or select),
  switch groups, More options and the footer, shared by the MCP server,
  endpoint, mail, SSH and wrapper forms. On an add page it is a card with
  More options; under a server's Advanced it is drawn flat, every setting
  in view.
- **A setting that opens in place** (`components/settings-item.tsx`): a
  Settings row whose form unfolds under it, with a grey line saying its
  state now. A row that needs the owner (an update, an HTTPS problem)
  opens by itself.
- **A token's settings** (`components/token-settings-form.tsx`,
  `components/token-options.tsx`): one table of the options' words, and a
  form that sends the settings it does not show as they are, so each
  section saves alone. A new expiry for an expired token asks for the
  password first, as making one does.
- **Adding** (`components/server-add-menu.tsx`, `assistant-connect.tsx`,
  `secret-add-dialog.tsx`, `memory-add-dialog.tsx`): one primary button
  per list, opening a menu of kinds or a sheet; never a form always open at
  the top of a list.
- **Choosing one of a few** (`components/assistant-choice.tsx`): large
  choice cards with a radio, for a decision that shapes the next step
  (which app, what it reaches).

## Defaults

Opinionated, and each one the safe side:

- A new API endpoint added by the owner is read-only until they turn that
  off (the add form says so).
- A new assistant reaches all servers, but every tool asks first; memories,
  web pages, running code and proposing are off until turned on.
- A server an assistant proposes reaches public addresses only.
- Advanced and More options start folded, except where something in them
  needs the owner now.

## Look

Dark only: PCP is a control panel kept open beside other windows. The
values live in `app/globals.css`; use the Tailwind names, not hex values.

| Token                          | Use                                         |
| ------------------------------ | ------------------------------------------- |
| `background` #0f1217           | The page                                    |
| `sidebar` #14181e              | The sidebar                                 |
| `card` #181c23                 | Lists and cards                             |
| `field` #11151b                | Inputs, code, values to copy                |
| `secondary` #262c37            | Grey buttons, the chosen sidebar item       |
| `muted` #232933                | Segmented controls, quiet badges            |
| `foreground` #e8eaee           | Text                                        |
| `muted-foreground` #9aa3b2     | Grey lines, captions (5:1 or more on cards) |
| `primary` #5ed3c3              | The primary button, links, "on"             |
| `warning` #f5b544              | What needs the owner now                    |
| `destructive` #ff8a8a          | Errors, destructive actions                 |
| `separator`                    | Hairlines between rows                      |
| `tile-*` / `tile-*-foreground` | A server kind's icon tile                   |

- **Type:** the system's own (`-apple-system`, SF Pro on a Mac), so nothing
  is downloaded. Titles 28–30px bold; section headings 13px semibold grey,
  or 17px semibold for Home's sections; row titles 15px; body 14px; grey
  lines 12–13px. Code and addresses in the system monospace.
- **Shape:** cards and lists 12px corners, controls 9px, sheets 18px.
- **Icons:** lucide, 1.8 stroke, 16–18px; decorative ones are
  `aria-hidden`, and icon-only buttons have an `aria-label`.
- **Colour is never the only signal:** a status has a word, a level has a
  label, and amber and red differ in lightness from teal.

## Accessibility

- Real controls: `<button>`, `<a href>`, `<input>` with a `<label>`. A
  switch is a checkbox with `role="switch"`; a segmented control is radio
  buttons in a `<fieldset>` with a `<legend>`.
- Targets are 36px or more (44px on a phone's decision buttons); rows 56px.
- Every page works at 390px wide: rows wrap their right-hand controls under
  the title, grids fall to one column, wide tables scroll inside their box.
- Focus shows as a teal ring; nothing removes it without a replacement.

## Tests and the design

E2E specs find things by role and label, so the label a component shows is
part of its contract: a `SwitchRow`'s label, a `SegmentedControl`'s legend,
a button's text. Change one and the specs that use it change with it, in
the same commit. Shared selectors live in `e2e/lib/ui.ts` and
`e2e/lib/auth.ts`.

A folded row is opened before what is in it is used (`openSettingsRow`,
`showServerSettings`, `openMoreOptions`); a segment is chosen by checking
its radio (`chooseSegment`, `chooseLevel`), never by clicking its label,
which the radio lies over.
