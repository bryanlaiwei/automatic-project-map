// The loopback page for pairing this computer and choosing which folders to collect.

import type { LogRoots } from "./collection-pass.js";
import { describeLogRoots, type CollectorStatus } from "./collector-loop.js";
import type { LocalDb } from "./local-db.js";

export function renderHelperPage(db: LocalDb, logRoots: LogRoots, status: CollectorStatus | null): string {
  const pairing = db.getPairing();
  const folders = db.folders();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local helper · Automatic Project Map</title>
<style>${pageCss}</style>
</head>
<body>
<div class="dots" aria-hidden="true"></div>
<div class="glow" aria-hidden="true"></div>
<main>
  <header class="mast">
    ${logo}
    <div>
      <p class="eyebrow">Automatic Project Map</p>
      <h1>Local helper</h1>
      <p class="lede">Collects Codex, Claude Code, and Cursor sessions from folders you choose on this computer.</p>
    </div>
  </header>
  <p id="message" class="banner" hidden></p>
  ${pairingCard(pairing, status)}
  ${foldersCard(folders, Boolean(pairing))}
  ${collectionCard(logRoots, status)}
  <p class="footnote">This page only accepts connections from this computer.</p>
</main>
<script>${pageScript}</script>
</body>
</html>`;
}

const logo = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
  <defs>
    <linearGradient id="apm-logo" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6366f1"></stop>
      <stop offset="1" stop-color="#8b5cf6"></stop>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="9" fill="url(#apm-logo)"></rect>
  <path d="M10 11.5 L21 9.5 M10 11.5 L15.5 21.5 M21 9.5 L22 20" stroke="white" stroke-opacity="0.55" stroke-width="1.6" stroke-linecap="round"></path>
  <circle cx="10" cy="11.5" r="3" fill="white"></circle>
  <circle cx="21" cy="9.5" r="2.4" fill="white"></circle>
  <circle cx="15.5" cy="21.5" r="2.6" fill="white"></circle>
  <circle cx="22" cy="20" r="2" fill="white" fill-opacity="0.85"></circle>
</svg>`;

function pairingCard(
  pairing: ReturnType<LocalDb["getPairing"]>,
  status: CollectorStatus | null,
): string {
  const needsPairing = !pairing || status?.needsPairing === true;
  const tone = !pairing ? "idle" : status?.needsPairing ? "warn" : "good";
  const title = !pairing ? "Not connected" : status?.needsPairing ? "Connection expired" : "Connected";
  const detail = !pairing
    ? `Not paired yet. Use “Connect this computer” in the web app, or paste a pairing code here.`
    : status?.needsPairing
      ? `The server no longer accepts this helper’s token. Connect it again from the web app, or paste a new code.`
      : `Paired to project <code>${escapeHtml(pairing.projectId)}</code>.<span class="when">Tracking started ${escapeHtml(formatWhen(pairing.trackingStartedAt))}.</span>`;
  return `<section class="card">
    <div class="status">
      <span class="dot ${tone}"></span>
      <div>
        <h2>${title}</h2>
        <p>${detail}</p>
      </div>
    </div>
    ${needsPairing ? pairForm(pairing?.apiUrl ?? "http://127.0.0.1:4000") : ""}
  </section>`;
}

function pairForm(apiUrl: string): string {
  return `<form id="pair" class="stack">
    <label>
      <span>Pairing code</span>
      <input name="code" required autocomplete="one-time-code" spellcheck="false" placeholder="Paste the code from the web app">
    </label>
    <label>
      <span>API URL</span>
      <input name="apiUrl" required spellcheck="false" value="${escapeHtml(apiUrl)}">
    </label>
    <div class="actions"><button class="primary" type="submit">Pair</button></div>
  </form>`;
}

function foldersCard(folders: ReturnType<LocalDb["folders"]>, paired: boolean): string {
  const items =
    folders.length === 0
      ? `<p class="empty">No folders yet. Add a project directory and only sessions inside it are uploaded.</p>`
      : `<ul class="rows">${folders
          .map(
            (folder) => `<li>
              <div class="row-text">
                <p class="path">${escapeHtml(folder.canonicalPath)}</p>
                ${folder.enabled ? "" : `<p class="meta">Paused</p>`}
              </div>
              <form method="post" action="/folders/${encodeURIComponent(folder.id)}/disable">
                <button class="ghost" type="submit">Remove</button>
              </form>
            </li>`,
          )
          .join("")}</ul>`;
  const form = paired
    ? `<form id="folder" class="stack add">
        <label>
          <span>Folder path</span>
          <input name="path" required spellcheck="false" placeholder="/path/to/project">
        </label>
        <div class="actions"><button class="primary" type="submit">Add folder</button></div>
      </form>`
    : `<p class="hint">Pair this computer before choosing folders.</p>`;
  return `<section class="card">
    <div class="section-head">
      <h2>Folders</h2>
      <p>Only sessions whose working folder is inside one of these folders are uploaded.</p>
    </div>
    ${items}
    ${form}
  </section>`;
}

function collectionCard(logRoots: LogRoots, status: CollectorStatus | null): string {
  const roots = describeLogRoots(logRoots);
  const rootList =
    roots.length === 0
      ? `<p class="empty">No agent log directories were found on this computer.</p>`
      : `<ul class="roots">${roots
          .map((line) => {
            const split = line.indexOf(": ");
            const id = split === -1 ? line : line.slice(0, split);
            const path = split === -1 ? line : line.slice(split + 2);
            const mark = agentMark(id);
            return `<li>
              <span class="badge" style="background:${mark.color}">${escapeHtml(mark.short)}</span>
              <div>
                <p class="name">${escapeHtml(mark.label)}</p>
                <p class="path">${escapeHtml(path)}</p>
              </div>
            </li>`;
          })
          .join("")}</ul>`;
  return `<section class="card">
    <div class="section-head row">
      <div>
        <h2>Collection</h2>
        <p>Agent logs watched on this computer.</p>
      </div>
      ${status ? `<button id="scan" class="secondary" type="button">Scan now</button>` : ""}
    </div>
    ${rootList}
    ${statusBlock(status)}
  </section>`;
}

function statusBlock(status: CollectorStatus | null): string {
  if (!status) {
    return "";
  }
  const rows: Array<[string, string]> = [
    ["Last scan", status.lastScanAt ? formatWhen(status.lastScanAt) : "Not yet"],
    ["Last upload", status.lastUploadAt ? formatWhen(status.lastUploadAt) : "Not yet"],
    ["Waiting to upload", String(status.queued)],
    ["Uploaded since start", String(status.uploaded)],
    ["Dropped since start", String(status.dropped)],
  ];
  if (status.nextUploadAt) {
    rows.push(["Next upload attempt", formatWhen(status.nextUploadAt)]);
  }
  const stats = `<dl class="stats">${rows
    .map(
      ([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join("")}</dl>`;
  const problem = status.lastError
    ? `<p class="problem">Last problem: ${escapeHtml(status.lastError)}</p>`
    : "";
  const paused =
    status.paused.length === 0
      ? ""
      : `<div class="paused">
          <p>Paused sessions. Their log file was replaced or shortened.</p>
          <ul>${status.paused
            .map(
              (item) =>
                `<li><span class="badge" style="background:${agentMark(item.provider).color}">${escapeHtml(agentMark(item.provider).short)}</span> ${escapeHtml(item.sessionId)} <span class="meta">${escapeHtml(item.reason ?? "paused")}</span></li>`,
            )
            .join("")}</ul>
        </div>`;
  return `${stats}${problem}${paused}`;
}

function agentMark(id: string): { label: string; short: string; color: string } {
  switch (id) {
    case "codex":
      return { label: "Codex", short: "Cx", color: "#18181b" };
    case "claude_code":
      return { label: "Claude Code", short: "CC", color: "#d97757" };
    case "cursor":
      return { label: "Cursor", short: "Cu", color: "#3f3f46" };
    default:
      return { label: id, short: id.slice(0, 2).toUpperCase() || "?", color: "#71717a" };
  }
}

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

const pageCss = `
:root {
  color-scheme: light;
  --bg: #f7f7f8;
  --ink: #18181b;
  --muted: #71717a;
  --line: #e4e4e7;
  --indigo: #4f46e5;
  --indigo-hover: #6366f1;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, "Helvetica Neue", sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
.dots {
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: 0.7;
  background-image: radial-gradient(#d4d4d8 1.2px, transparent 1.2px);
  background-size: 22px 22px;
}
.glow {
  position: fixed;
  top: -10rem;
  left: 50%;
  width: 48rem;
  height: 24rem;
  transform: translateX(-50%);
  pointer-events: none;
  border-radius: 999px;
  background: rgb(199 210 254 / 0.45);
  filter: blur(64px);
}
main {
  position: relative;
  width: min(40rem, calc(100% - 2rem));
  margin: 0 auto;
  padding: 3.5rem 0 4rem;
}
.mast {
  display: flex;
  gap: 0.9rem;
  align-items: flex-start;
  margin-bottom: 1.5rem;
}
.logo { width: 2.75rem; height: 2.75rem; flex: none; }
.eyebrow {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
h1 {
  margin: 0.15rem 0 0;
  font-size: 1.5rem;
  line-height: 1.2;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.lede, .footnote, .hint, .empty, .section-head p, .status p {
  margin: 0.35rem 0 0;
  font-size: 0.875rem;
  line-height: 1.5;
  color: #52525b;
}
.status code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  color: #3f3f46;
  overflow-wrap: anywhere;
}
.when { display: block; margin-top: 0.15rem; }
.footnote { margin-top: 1rem; color: var(--muted); text-align: center; }
.card {
  margin-top: 0.85rem;
  padding: 1.05rem 1.1rem 1.1rem;
  background: #fff;
  border-radius: 1rem;
  box-shadow: 0 1px 2px rgb(24 24 27 / 0.04), 0 0 0 1px var(--line);
}
.card h2 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
}
.status { display: flex; gap: 0.75rem; align-items: flex-start; }
.dot {
  width: 0.625rem;
  height: 0.625rem;
  margin-top: 0.35rem;
  border-radius: 999px;
  flex: none;
}
.dot.good { background: #10b981; }
.dot.warn { background: #fbbf24; }
.dot.idle { background: #d4d4d8; }
.section-head.row, .actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.stack { display: grid; gap: 0.8rem; margin-top: 1rem; }
.stack.add { margin-top: 0.9rem; }
label { display: grid; gap: 0.4rem; }
label span, dt {
  font-size: 0.875rem;
  font-weight: 500;
  color: #27272a;
}
input {
  width: 100%;
  height: 2.25rem;
  padding: 0 0.75rem;
  border: 0;
  border-radius: 0.5rem;
  background: #fff;
  color: var(--ink);
  font: inherit;
  font-size: 0.875rem;
  box-shadow: inset 0 0 0 1px var(--line), 0 1px 2px rgb(24 24 27 / 0.04);
}
input::placeholder { color: #a1a1aa; }
input:focus {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--indigo);
}
button {
  height: 2rem;
  padding: 0 0.7rem;
  border: 0;
  border-radius: 0.5rem;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
}
button:focus-visible { outline: 2px solid var(--indigo); outline-offset: 2px; }
button:disabled { cursor: not-allowed; opacity: 0.5; }
button.primary {
  height: 2.25rem;
  padding: 0 0.9rem;
  background: var(--indigo);
  color: #fff;
  box-shadow: 0 1px 2px rgb(24 24 27 / 0.08);
}
button.primary:hover:not(:disabled) { background: var(--indigo-hover); }
button.secondary {
  background: #fff;
  color: #27272a;
  box-shadow: inset 0 0 0 1px var(--line), 0 1px 2px rgb(24 24 27 / 0.04);
}
button.secondary:hover:not(:disabled) { background: #fafafa; }
button.ghost {
  background: transparent;
  color: #52525b;
}
button.ghost:hover:not(:disabled) { background: #f4f4f5; color: #18181b; }
.rows, .roots, .paused ul { list-style: none; margin: 0.85rem 0 0; padding: 0; }
.rows { border-radius: 0.75rem; box-shadow: inset 0 0 0 1px var(--line); }
.rows li, .roots li, .paused li {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 0.85rem;
}
.rows li + li { box-shadow: inset 0 1px 0 var(--line); }
.row-text { min-width: 0; flex: 1; }
.path, .meta, .name { margin: 0; }
.path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  line-height: 1.45;
  color: #3f3f46;
  overflow-wrap: anywhere;
}
.meta { margin-top: 0.15rem; font-size: 0.75rem; color: var(--muted); }
.roots li { padding: 0.55rem 0; }
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.35rem;
  height: 1.35rem;
  border-radius: 0.35rem;
  color: #fff;
  font-size: 0.62rem;
  font-weight: 600;
  flex: none;
}
.name { font-size: 0.875rem; font-weight: 500; }
.stats {
  display: grid;
  margin: 1rem 0 0;
  border-radius: 0.75rem;
  box-shadow: inset 0 0 0 1px var(--line);
}
.stats div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.7rem 0.85rem;
}
.stats div + div { box-shadow: inset 0 1px 0 #f4f4f5; }
dt { font-weight: 400; color: var(--muted); }
dd { margin: 0; font-size: 0.875rem; text-align: right; }
.problem, .paused p {
  margin: 0.85rem 0 0;
  font-size: 0.8125rem;
  line-height: 1.45;
}
.problem {
  padding: 0.55rem 0.75rem;
  border-radius: 0.5rem;
  color: #be123c;
  background: #fff1f2;
  box-shadow: inset 0 0 0 1px #fecdd3;
}
.paused li { padding-left: 0; font-size: 0.8125rem; }
.banner {
  margin: 0 0 0.85rem;
  padding: 0.55rem 0.75rem;
  border-radius: 0.5rem;
  font-size: 0.875rem;
}
.banner.ok {
  color: #047857;
  background: #ecfdf5;
  box-shadow: inset 0 0 0 1px #a7f3d0;
}
.banner.bad {
  color: #be123c;
  background: #fff1f2;
  box-shadow: inset 0 0 0 1px #fecdd3;
}
.empty { margin-top: 0.75rem; }
@media (max-width: 640px) {
  main { padding-top: 1.5rem; }
  .section-head.row { flex-direction: column; }
}
`;

const pageScript = `
function note(ok, text) {
  const el = document.getElementById("message");
  if (!el) return;
  el.hidden = false;
  el.className = ok ? "banner ok" : "banner bad";
  el.textContent = text;
}
async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}
document.getElementById("scan")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  const { response, payload } = await post("/scan", {});
  note(response.ok, response.ok ? "Scan finished." : (payload.error || "Scan failed."));
  if (response.ok) location.reload();
  else button.disabled = false;
});
document.getElementById("pair")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  const data = new FormData(event.target);
  const { response, payload } = await post("/pair", { code: data.get("code"), apiUrl: data.get("apiUrl") });
  note(response.ok, response.ok ? "Paired." : (payload.error || "Pairing failed."));
  if (response.ok) location.reload();
  else button.disabled = false;
});
document.getElementById("folder")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  const data = new FormData(event.target);
  const { response, payload } = await post("/folders", { path: data.get("path") });
  note(response.ok, response.ok ? "Folder added." : (payload.error || "Could not add that folder."));
  if (response.ok) location.reload();
  else button.disabled = false;
});
`;
