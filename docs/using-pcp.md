# Using PCP

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
   synced or shared. An assistant can propose each of these too: another
   server of one it sees (`register_server` or `create_wrapper` with
   `definition`), detaching one (`detach` on `update_endpoint` or
   `update_wrapper`), or a note (`note` there, or `/skills/<name>/.note` in
   its memory tool). You see the whole note and what is shared, and nothing
   changes until you agree.

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
   **Services** run on them: **Add → Service** takes a definition (the image
   pinned by digest, its ports, the names of its variables, named volumes, a
   health check, and what it serves: an API endpoint from its OpenAPI schema,
   an MCP server, or nothing), where its ports are published on the SSH
   server, and a secret for each variable. PCP runs it with the Docker or
   Podman already there, through its command line over SSH (it installs
   nothing and never touches the engine's socket), waits for it to be
   healthy and adds what it serves; if anything fails it takes it all back.
   Changing a secret it uses restarts it with the new value. Its tools
   (`status`, `logs`, `start`, `stop`, `restart`) follow your levels; a tool
   of the server it serves, called while it is stopped, says so.
   **Storage folders** are on them too: **Add a folder** on the SSH server's
   page takes the folder's path (a Samba share, a scans folder), whose files
   it should be, a umask (002 by default, so a group share sees ordinary
   files) and **Read-only**. Assistants then list, find, get, save, move and
   delete files there over SFTP, on the same SSH connection: `list_folder`,
   `find_files`, `get_file` (the file comes back as a kept result's handle),
   `save_file` (takes a handle, so a mail attachment, a scan or a converted
   document goes into the folder in one call), `make_folder`, `move` and
   `delete` (for good, Destructive). Every path stays inside the folder: PCP
   refuses `..` and checks each path's real path on the server, so a link to
   somewhere else is not followed. A file is written under a temporary
   `.pcp-part` name and renamed into place when whole, and one already there
   is replaced only when the call says `overwrite`. SFTP writes as PCP's
   login: when you want the files to be another user's, the page says so
   (sign PCP in as that user, or give the login the folder's group). The
   folder's page has a file browser of its own: folders, sizes and dates,
   download, upload, new folder, rename and delete.
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

| Tool                    | What it does                                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`                | Finds tools across servers, your skills, and the memories the token reads, from a few words ("create a github issue"), each with a ref for `describe`.                                                                                                                      |
| `list_tools`            | Lists every tool on one server, with whether it runs at once or asks you first, a page of 200 at a time.                                                                                                                                                                    |
| `describe`              | For a tool, its full description, JSON Schema, whether it asks you first, for an API what it answers, and the `call_handle` that calls it; for a skill or a memory, its text.                                                                                               |
| `call_tool_read`        | Runs the Read tool a `call_handle` stands for, after checking the arguments against its schema, with PCP adding the credentials; `fields`, `decode` and `keep` shape a long JSON answer. A Write or Destructive tool is refused, naming the entry that runs it.             |
| `call_tool_write`       | The same, for a Write tool (it changes things, deletes nothing for good) or a Read one.                                                                                                                                                                                     |
| `call_tool_destructive` | The same, for any tool, a Destructive one (it can change or delete for good, or says nothing about it) included.                                                                                                                                                            |
| `check_permission`      | Says how a request went once you have answered it; waits a little if you are still on it. Without an id, lists the token's own requests still waiting for you.                                                                                                              |
| `withdraw_request`      | Takes back one of the token's own requests while it still waits for you: it leaves your list, and nothing runs.                                                                                                                                                             |
| `check_server`          | Says whether a server is connected; waits a little if you are still signing in.                                                                                                                                                                                             |
| `read_result`           | Reads a long answer or a kept value, a slice at a time from any offset or from where a text appears; a file is described, not shown.                                                                                                                                        |
| `register_server`       | Proposes a new MCP server, an API from an OpenAPI 3 schema, a mail account (JMAP or IMAP) or a calendar account (CalDAV), with no auth, a secret by name, a user name and password, or OAuth; or another server of one it sees (`definition`), with a note for you to keep. |
| `propose_tool_access`   | Proposes which tools its token may run, many at once and across servers, and hears which tools would change; you review and save it in PCP.                                                                                                                                 |

A Write or Destructive call an assistant makes again with the same
arguments within a while (from `call_tool_*`, a program's `pcp.call` or a
wrapper) is not run twice: PCP answers with how the first one went (still
running, done and what it answered, failed, or waiting for you), and runs it
again only when the assistant says it means to, with a reason (`rerun`). The
log marks such a repeat. The while is 30 minutes unless you set otherwise
under Settings → Repeated calls, for every tool or for one tool, where you
can also have a tool never held back. Read tools, the browser, SSH commands,
stores and calls you allowed on PCP's page are not held back.

Options on a token's page, each off until you tick it, add more tools,
described further down:

| Tool                                                      | Option (**Let an assistant with this token …**)     | What it does                                                                                                                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_endpoint`                                            | **read and change API endpoints**                   | Reads an endpoint's settings and tools, its edits, one part of its schema at a time, and likely mistakes in it with fixes to make.                                                                          |
| `update_endpoint`                                         | **read and change API endpoints**                   | Changes an endpoint's name, description, schema or edits, base URL, read-only setting or tool descriptions, or reads its schema URL again; asks you for your note on it or an MCP server, or to detach one. |
| `list_secrets`                                            | **read and change API endpoints**                   | Lists your secrets by name, with what uses each, so an assistant can name one when it proposes an endpoint; never a value.                                                                                  |
| `get_wrapper`                                             | **propose wrappers**                                | Reads a wrapper's tools as you approved them: each one's program, schemas, the tools it calls, and where a secret goes in (by name).                                                                        |
| `create_wrapper`                                          | **propose wrappers**                                | Proposes a wrapper, a server whose tools are short programs over your other tools, or another wrapper of one it sees (`definition`); you read every program first.                                          |
| `update_wrapper`                                          | **propose wrappers**                                | Proposes a change to a wrapper, shown to you in full before and after; asks you for your note on it, or to detach one.                                                                                      |
| `delete_wrapper`                                          | **propose wrappers**                                | Proposes deleting a wrapper.                                                                                                                                                                                |
| `memory`                                                  | **keep memories**                                   | Keeps notes under `/memories` that last between conversations and follow you from one assistant to the next.                                                                                                |
| `read_memory`                                             | **keep memories**                                   | Reads those notes (`every`, `view`, `search`) and nothing else.                                                                                                                                             |
| `web_fetch`                                               | **fetch web pages**                                 | Fetches an address and returns the page as Markdown, a part at a time; with a method, headers and a body, other requests too.                                                                               |
| `run_code_read`, `run_code_write`, `run_code_destructive` | **run code that calls its tools**                   | Runs a program that calls the token's tools of that tier and below and works on their answers inside PCP.                                                                                                   |
| `check_run`                                               | **run code that calls its tools**                   | Says how one of its runs went, by the run's id: still running, with its calls so far, or how it ended.                                                                                                      |
| `share_result`                                            | **move files to and from its own computer by link** | A link the assistant's own computer downloads a file PCP keeps for it from with curl (a browser download, a mail attachment).                                                                               |
| `receive_file`                                            | **move files to and from its own computer by link** | A link its own computer sends one file to with curl, and the handle the file is then kept under.                                                                                                            |
| `create_upload_link`                                      | **move files to and from its own computer by link** | A link for you: a page where you upload files from your phone or computer (a photo, a scan, a file you dropped into the chat), for an hour, until you tap Done.                                             |
| `check_upload`                                            | **move files to and from its own computer by link** | Which files you uploaded to that page, each as a handle the assistant passes on (an attachment, an upload).                                                                                                 |

Every tool has a tier: **Read** (it only reads), **Write** (it changes
things, but deletes nothing for good) or **Destructive** (it can change or
delete for good). PCP takes it from what the server says of the tool (a tool
that says nothing is Destructive; an API's GET is Read, POST, PUT and PATCH
Write, DELETE Destructive; a wrapper's tool is the highest tier of the tools
it calls), and `describe` names the entry that runs it. Some apps ask you
before every call to a destructive tool, even one you always allow, so an
assistant reads with `call_tool_read` and changes with `call_tool_write`, and
those apps let them through. Set a tool's tier yourself on its server's page
(for every server of the same definition), and what PCP's own tools tell apps
on **Settings → PCP's own tools**; an assistant can propose tiers with
`propose_tool_access`, which you save on the request's page. A tier never
lets a tool run that your levels would stop.

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
to a PDF, a PDF or image an API endpoint answers with) and any part named in
`keep` come back as a handle,
`{"$result": "<id>", …}`, with its type and size. Put that handle in any later
call's arguments and PCP puts the value there: a text as text, a file as
base64. `get_attachment` reads any attachment that way, and `send_email` and
`create_draft` take handles as attachments, so an attachment from one mail
account can be sent from another, or handed to an API. The permission page
shows each handle as a file (its name, type, size, the tool that kept it and
until when), which you can open (a PDF, a picture, the first lines of a
text) or download while the request waits. A `call_tool_<tier>` answer also links
its handles as MCP resources (`pcp://results/<id>`), so a client that reads
resources can open a kept file itself.

A tool you have not decided about answers "Not done yet" and asks you: the
assistant ends its reply with a link to the request in PCP, labelled with
what it asks (such as "Allow gmail-imap/send_email?"), so an app that reads
the reply aloud says the label rather than the address. Answer there, tell
it you have, and it carries on. The bell at the top of every page in
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
tools** gets the `run_code` tools, one per tier (`run_code_read`,
`run_code_write`, `run_code_destructive`), whose programs call tools of that
tier and below. The assistant sends a JavaScript program, the
body of an async function, which PCP runs in a sandbox of its own: QuickJS,
compiled to WebAssembly, with nothing of the machine it runs on. The program
calls the token's tools with `await pcp.call(server, tool, args)` and gets
each answer whole, as a value, so it can pick the ten rows the assistant needs
out of ten thousand, join two tools' answers, or hand a file from one tool to
another, and only what it prints and returns goes back to the assistant.
Files move as handles, as they do between calls (above); `pcp.keep` keeps a
text it made (a CSV, a report), or bytes, as a handle to pass on, and
`pcp.read(handle, { as: "base64" })` reads a file's bytes when the program
has to build something from them (a MIME message with an attachment);
`{ offset, length }` reads only a part (bytes of a file, characters of a
text), so a large file is read a piece at a time. With
`keep`, a value one tool makes, such as a password a server generates, goes
into another tool's arguments as a handle, never read by the program or the
assistant. `pcp.tools()` lists the token's servers and tools, as `list_tools`
does, and `pcp.describe(server, tool)` gives one tool's arguments and what
it returns, as `describe` does. The program also has `atob`, `btoa`, `TextEncoder`, `TextDecoder` and
`crypto.getRandomValues`, so it can make a strong secret itself. It has no
timers of its own: `await pcp.sleep(ms)` waits (a minute at most at once),
and `pcp.withTimeout(ms, fn)` gives up on a slow part with an error coded
`timeout`, both on PCP's clock and within the run's three minutes. What it
gave up on is not taken back, so a call it was waiting for may still have
gone through.

A large picture costs an assistant far more to look at than a small one, so
`pcp.image.compress(handle, { maxWidth, maxHeight, crop, grayscale, format,
quality })` makes a smaller copy of a kept PNG, JPEG, WebP or GIF (a
screenshot, an attachment) and hands back its handle with its size; the
original stays as it was, for a tool that needs it whole. PCP decodes the
image itself, as WebAssembly, the same in the container, a checkout and the
desktop app, one image at a time and up to 50 million pixels; the copy
carries no metadata (no camera details or place). The `run_code` descriptions
tells the assistant when to crop, when grey is enough, and when to send the
original instead. `pcp.video.frames(handle, { at, every, count })` takes
frames from a kept video as JPEGs, with ffmpeg in the sandbox (below); without
the sandbox it says so.

Each call is decided as if the assistant had made it with `call_tool_<tier>`: a
tool above the program's tier is an error the program sees, an
allowed tool runs, a blocked one is an error the program sees, and one that
asks you first stops the program at that call (the calls before it have run),
with the usual request for you to answer; for the program to make that call
itself next time, choose **Always allow**, or **Allow for** while that lasts. Every call is in the request log
under the `run_code` entry it came through, and on the **Log** page. A program has no network, no files, no timers and none of
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
`screenshot`; `console_log` and `network_log`, the tab's console and requests
without credentials), act on it (`click`, `drag`, `type`, `select_option`,
`press_key`, `scroll`, `wait_for`, `handle_dialog`; `click`, `scroll` and
`drag` also at a point of the page, for a canvas app), move files
(`upload_file`, `download`), run a script in it (`evaluate`, below), `hand_over`
a tab to you and ask you for a secret to type (`request_secret`). It is Chromium on PCP's machine, kept out of sight (on a
virtual display in the Docker image, in a window off the screen in the desktop
app), with up to eight tabs, started with the first page and closed after an
hour idle (**Settings → Resources** sets
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
where you signed in, but no tool hands back a cookie or local storage. The
one way an assistant's JavaScript runs in a page is `evaluate`, and it asks you
per site, showing the whole script: **Run it once**, or **Allow scripts at this
site** for the token (the token's page lists those, and takes them back). It
is refused while a field holds a secret PCP typed, and while it runs the tab
reaches its own site only.
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
**Forget all sites** signs it out of everything. The Browser page lists
every open tab in one place, as a browser's tab strip would: the page's icon
(the one Chromium loaded for the page, or the site's first letter), its
title and site, who opened it and whose it is now, and whether it is idle,
in use or with you; **Close** on any tab closes it. Every answer names the
tab and a link into that list, where you watch it live and **Take over**:
your mouse and keyboard go to the page, with the timing you made them, and
the assistant's tools leave the tab alone until you **Hand back** to the
token you choose (the one whose tab it was, unless you pick another; a tab
you opened is no token's until you hand it to one). `hand_over` asks you the
same way any request does, and its link, the bell and Home all lead to the
tab, where the assistant's message waits on it: **Done** gives it back, and
**Not now** gives it back undone.

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
page moves on. Wherever a page of that tab repeats the secret later, even
written its own way (an IBAN in groups of four, in capitals, on the next
page), it reads as `[secret: name]` too, for as long as the tab is open. A secret an API endpoint uses is not allowed in the browser by
that. Under **Secrets**, add one as **One-time codes (TOTP)** with the seed or
`otpauth://` link a site shows when you set up its codes: PCP types the code
of the moment, and **Code** shows it to you. **Browser** on a secret's row
lists its sites and the tokens allowed there, each with a way to end it, as
does the token's page. `request_secret` asks you for a secret PCP does not
hold yet: you type it on PCP's page, check its sites and choose how its uses
go, and the assistant gets its name. The request log names the secret and the
site of each use, never the value.
