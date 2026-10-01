import type { CallToolResult, McpServer } from "@modelcontextprotocol/server"

import type { PermissionDecision, PermissionKind } from "./constants"
import { oauthStartUrl } from "./upstream"

/**
 * PCP's panel (ui://pcp/panel): one MCP App the client shows in the
 * conversation when a gateway tool needs the owner. A tool opts in with
 * PANEL_TOOL_META; its result carries text for the assistant and
 * `structuredContent` for the panel, and the panel picks a view by
 * `structuredContent.kind`:
 *
 * - permission: a call (or a new server) waiting for the owner's answer. The
 *   buttons call the app-only answer_permission tool.
 * - connect: an OAuth server that needs connecting. OAuth cannot run inside
 *   the panel (hosts sandbox it, and sign-in pages refuse to be framed), so
 *   Connect asks the host to open PCP's start page in the owner's browser
 *   (ui/open-link) and polls check_server until the callback has landed.
 * - anything else: the result's text, compactly.
 *
 * To add a view: a builder here that returns panelResult() with a new kind,
 * and a renderer for that kind in SCRIPT below.
 *
 * The HTML is self-contained on purpose (no external scripts or styles:
 * hosts apply a strict CSP) and speaks the MCP Apps postMessage protocol
 * (2026-01-26) directly. Everything from a result is written with
 * textContent, never as HTML. Ported from plekje's confirmation panel.
 */

export const PANEL_URI = "ui://pcp/panel"

export const PANEL_MIME_TYPE = "text/html;profile=mcp-app"

/** For a tool whose results the panel shows. */
export const PANEL_TOOL_META = {
  ui: { resourceUri: PANEL_URI },
  "ui/resourceUri": PANEL_URI,
}

/** For a tool only the panel calls; hosts hide it from the assistant. */
export const APP_ONLY_TOOL_META = {
  ui: { resourceUri: PANEL_URI, visibility: ["app"] },
  "ui/resourceUri": PANEL_URI,
}

export type PermissionPanel = {
  id: string
  kind: PermissionKind
  status: "pending"
  title: string
  lines: string[]
  warning: string | null
  /** The same request on PCP's own page. */
  url: string
  expires_at: string
  decisions: Array<{ value: PermissionDecision; label: string }>
}

export type ConnectPanel = {
  serverId: string
  slug: string
  name: string
  /** Opened in the owner's browser: PCP's OAuth start route. */
  startUrl: string
  /** The server's page in PCP, for when the host will not open links. */
  pageUrl: string
}

export type ServerState = {
  id: string
  name: string
  slug: string
  connected: boolean
  status: string
  toolCount: number
}

export type PanelContent =
  | { kind: "permission"; permission: PermissionPanel }
  | { kind: "connect"; connect: ConnectPanel; server?: ServerState }
  | { kind: "done"; text: string; isError?: boolean; server?: ServerState }

/** A result the assistant reads as text and the panel renders. */
export function panelResult(
  text: string,
  content: PanelContent,
  { isError = false }: { isError?: boolean } = {},
): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: content as unknown as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  }
}

export function connectPanel(
  server: { id: string; slug: string; name: string },
  publicUrl: string,
): ConnectPanel {
  const base = publicUrl.replace(/\/+$/, "")

  return {
    serverId: server.id,
    slug: server.slug,
    name: server.name,
    startUrl: oauthStartUrl(base, server.id),
    pageUrl: `${base}/servers/${server.id}`,
  }
}

/** An OAuth server that needs the owner to sign in before it can be used. */
export function connectResult(
  server: { id: string; slug: string; name: string; status?: string },
  publicUrl: string,
  { lead = "Not done yet", state }: { lead?: string; state?: ServerState } = {},
): CallToolResult {
  const connect = connectPanel(server, publicUrl)

  // The server will not let PCP register itself: signing in cannot work
  // until the owner creates a client with the provider and gives it to PCP.
  // Connect still helps, as it opens the server's page, which says how.
  const waitsForClient = server.status === "client_required"

  return panelResult(
    waitsForClient
      ? `${lead}: ${server.name} needs an OAuth client from the owner before it can be connected, because it does not let PCP register itself. Ask the owner to open ${connect.pageUrl} (signed in to PCP), which says what to create with the provider and where to enter it, and then to choose Connect. Call check_server with server "${server.slug}" to see when it is connected, then try again.`
      : `${lead}: ${server.name} needs connecting before its tools can be used. Ask the owner to press Connect in the panel, or to open ${connect.pageUrl} (signed in to PCP) and choose Connect. Call check_server with server "${server.slug}" to see when it is connected (on clients that show panels, that also gives the owner the Connect button), then try again.`,
    { kind: "connect", connect, ...(state ? { server: state } : {}) },
  )
}

export function registerPanelResource(server: McpServer): void {
  server.registerResource(
    "pcp-panel",
    PANEL_URI,
    {
      title: "PCP",
      description:
        "Shows the owner what an assistant asked PCP for, lets them allow or block it, and connects servers that need signing in to.",
      mimeType: PANEL_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: PANEL_URI,
          mimeType: PANEL_MIME_TYPE,
          text: panelHtml(),
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    }),
  )
}

const SCRIPT = String.raw`
(() => {
  const PROTOCOL = "2026-01-26";
  const POLL_MS = 3000;
  const POLL_TRIES = 100;
  const waiters = new Map();
  let nextId = 1;
  let permission = null;
  let connect = null;
  let polling = null;

  const $ = (id) => document.getElementById(id);

  function post(message) {
    window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, message), "*");
  }

  function request(method, params) {
    const id = nextId++;
    post({ id, method, params });
    return new Promise((resolve, reject) => {
      waiters.set(id, { resolve, reject });
      setTimeout(() => {
        if (waiters.delete(id)) reject(new Error("timeout"));
      }, 120000);
    });
  }

  function notify(method, params) {
    post({ method, params: params || {} });
  }

  function tell(text) {
    request("ui/update-model-context", {
      content: [{ type: "text", text }],
    }).catch(() => {});
  }

  function applyContext(context) {
    if (!context) return;
    if (context.theme === "dark" || context.theme === "light") {
      document.documentElement.dataset.theme = context.theme;
    }
    const vars = context.styles && context.styles.variables;
    if (vars && typeof vars === "object") {
      for (const [key, value] of Object.entries(vars)) {
        if (typeof value === "string" && key.startsWith("--")) {
          document.documentElement.style.setProperty(key, value);
        }
      }
    }
  }

  function textOf(result) {
    const parts = (result && result.content) || [];
    return parts
      .filter((part) => part && part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }

  function show(view) {
    for (const id of ["waiting", "permission", "connect", "done"]) {
      $(id).hidden = id !== view;
    }
    resize();
  }

  function stopPolling() {
    if (polling) clearInterval(polling);
    polling = null;
  }

  function renderDone(text, isError) {
    stopPolling();
    $("outcome").textContent = text || "Done.";
    $("outcome").className = isError ? "outcome error" : "outcome";
    show("done");
  }

  function renderPermission(asked) {
    permission = asked;
    $("p-title").textContent = asked.title || "Allow this?";
    const list = $("p-lines");
    list.replaceChildren();
    for (const line of asked.lines || []) {
      const item = document.createElement("li");
      item.textContent = line;
      list.append(item);
    }
    list.hidden = list.childElementCount === 0;
    $("p-warning").textContent = asked.warning || "";
    $("p-warning").hidden = !asked.warning;
    const buttons = $("p-buttons");
    buttons.replaceChildren();
    (asked.decisions || []).forEach((decision, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = decision.label;
      if (index === 0) button.className = "primary";
      if (decision.value === "block" || decision.value === "discard") {
        button.className = "danger";
      }
      button.addEventListener("click", () => decide(decision));
      buttons.append(button);
    });
    $("p-error").textContent = "";
    show("permission");
  }

  function setBusy(container, busy) {
    for (const button of container.querySelectorAll("button")) {
      button.disabled = busy;
    }
  }

  async function decide(decision) {
    if (!permission) return;
    setBusy($("p-buttons"), true);
    $("p-error").textContent = "";
    try {
      const result = await request("tools/call", {
        name: "answer_permission",
        arguments: { id: permission.id, decision: decision.value },
      });
      tell(
        'The owner chose "' + decision.label + '" for: ' +
          (permission.title || "") + "\n" + textOf(result),
      );
      onResult(result);
    } catch (error) {
      setBusy($("p-buttons"), false);
      $("p-error").textContent =
        "That did not go through. Try again, or decide in PCP.";
    }
  }

  function renderConnect(server) {
    connect = server;
    stopPolling();
    $("c-title").textContent = server.name + " needs connecting";
    $("c-status").textContent = "";
    $("c-go").textContent = "Connect";
    $("c-go").disabled = false;
    show("connect");
  }

  function startConnect() {
    if (!connect) return;
    request("ui/open-link", { url: connect.startUrl }).catch(() => {
      $("c-status").textContent =
        "Your app did not open the link. Open " + connect.pageUrl +
        " and choose Connect.";
    });
    $("c-status").textContent =
      "Sign in to " + connect.name +
      " in the browser window that opened. This updates by itself.";
    $("c-go").textContent = "Open again";
    poll();
  }

  function poll() {
    stopPolling();
    let tries = 0;
    let busy = false;
    polling = setInterval(async () => {
      if (busy || !connect) return;
      tries += 1;
      if (tries > POLL_TRIES) {
        stopPolling();
        $("c-status").textContent =
          "Still not connected. Press Connect to try again.";
        $("c-go").textContent = "Connect";
        return;
      }
      busy = true;
      try {
        const result = await request("tools/call", {
          name: "check_server",
          arguments: { server: connect.slug },
        });
        const state = result && result.structuredContent &&
          result.structuredContent.server;
        if (state && state.connected) {
          renderDone(connect.name + " is connected.", false);
          tell("The owner connected " + connect.name + ". Try the call again.");
        }
      } catch (error) {
        // Keep polling; the next round may get through.
      } finally {
        busy = false;
      }
    }, POLL_MS);
  }

  function onResult(result) {
    const content = result && result.structuredContent;
    if (
      content && content.kind === "permission" && content.permission &&
      content.permission.status === "pending"
    ) {
      renderPermission(content.permission);
    } else if (content && content.kind === "connect" && content.connect) {
      renderConnect(content.connect);
    } else {
      renderDone(textOf(result), result && result.isError);
    }
  }

  let lastSize = "";
  function resize() {
    const height = Math.ceil(
      document.documentElement.getBoundingClientRect().height,
    );
    const width = Math.ceil(window.innerWidth);
    const size = width + "x" + height;
    if (size !== lastSize) {
      lastSize = size;
      notify("ui/notifications/size-changed", { width, height });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;

    if (message.id !== undefined && !message.method) {
      const waiter = waiters.get(message.id);
      if (!waiter) return;
      waiters.delete(message.id);
      if (message.error) waiter.reject(message.error);
      else waiter.resolve(message.result);
      return;
    }

    switch (message.method) {
      case "ui/notifications/tool-result":
        onResult(message.params);
        break;
      case "ui/notifications/host-context-changed":
        applyContext(message.params);
        break;
      case "ui/resource-teardown":
        stopPolling();
        if (message.id !== undefined) post({ id: message.id, result: {} });
        break;
      default:
        // Other requests from the host just need an answer.
        if (message.id !== undefined) post({ id: message.id, result: {} });
    }
  });

  $("c-go").addEventListener("click", startConnect);
  $("p-open").addEventListener("click", (event) => {
    event.preventDefault();
    if (permission && permission.url) {
      request("ui/open-link", { url: permission.url }).catch(() => {});
    }
  });

  new ResizeObserver(resize).observe(document.body);

  request("ui/initialize", {
    appInfo: { name: "pcp-panel", version: "1.0.0" },
    appCapabilities: {},
    protocolVersion: PROTOCOL,
  })
    .then((result) => {
      applyContext(result && result.hostContext);
      notify("ui/notifications/initialized");
      resize();
    })
    .catch(() => {});
})();
`

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: var(--color-background-primary, #ffffff);
  --fg: var(--color-text-primary, #1c1917);
  --muted: var(--color-text-secondary, #57534e);
  --line: var(--color-border-primary, #e7e5e4);
  --accent: #0f766e;
  --danger: #b91c1c;
}
:root[data-theme="dark"] {
  --bg: var(--color-background-primary, #1c1917);
  --fg: var(--color-text-primary, #fafaf9);
  --muted: var(--color-text-secondary, #a8a29e);
  --line: var(--color-border-primary, #44403c);
  --accent: #2dd4bf;
  --danger: #f87171;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
h1 { font-size: 15px; margin: 0 0 8px; overflow-wrap: anywhere; }
.muted { color: var(--muted); margin: 0 0 12px; }
ul { margin: 0 0 12px; padding-left: 20px; }
li { margin: 2px 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.warning { border-left: 3px solid var(--danger); padding: 6px 10px; margin: 0 0 12px; }
.buttons { display: flex; gap: 8px; flex-wrap: wrap; }
button { font: inherit; padding: 8px 14px; border-radius: 8px; cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--fg); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
:root[data-theme="dark"] button.primary { color: #042f2e; }
button.danger { border-color: var(--danger); color: var(--danger); }
button:disabled { opacity: 0.6; cursor: default; }
.error { color: var(--danger); }
.fallback { color: var(--muted); font-size: 13px; margin: 12px 0 0; }
.fallback a { color: inherit; }
.outcome { white-space: pre-wrap; margin: 0; overflow-wrap: anywhere; }
`

const BODY = `
<div id="waiting"><p class="muted">Loading…</p></div>
<div id="permission" hidden>
  <h1 id="p-title"></h1>
  <ul id="p-lines"></ul>
  <p class="warning" id="p-warning" hidden></p>
  <div class="buttons" id="p-buttons"></div>
  <p class="error" id="p-error" role="alert"></p>
  <p class="fallback">Nothing runs until you answer. You can also <a href="#" id="p-open">decide in PCP</a>.</p>
</div>
<div id="connect" hidden>
  <h1 id="c-title"></h1>
  <p class="muted">Signing in happens in your browser, not here. PCP keeps the result encrypted; the assistant never sees it.</p>
  <div class="buttons"><button type="button" class="primary" id="c-go">Connect</button></div>
  <p class="muted" id="c-status" role="status"></p>
</div>
<div id="done" hidden><p class="outcome" id="outcome"></p></div>
`

let cached: string | null = null

export function panelHtml(): string {
  cached ??= `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PCP</title>
<style>${STYLE}</style>
</head>
<body>
${BODY}
<script>${SCRIPT}</script>
</body>
</html>`

  return cached
}
