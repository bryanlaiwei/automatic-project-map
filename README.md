# automatic-project-map

Automatic feature map from GitHub and local agent work.

This repository is the local pilot from the MVP plan: a TypeScript npm workspace with a React web app, an Express API, a pg-boss worker, a macOS collector, and local Supabase for Postgres and GitHub login.

## Layout

| Path | Role |
|---|---|
| `apps/web` | React, Vite, and Tailwind |
| `apps/api` | Express API |
| `apps/worker` | pg-boss background jobs |
| `apps/collector` | Local helper, SQLite checkpoints and upload queue |
| `packages/shared` | Shared schemas and types |
| `supabase` | Local Postgres and Auth |

## Prerequisites

- Node.js 22
- Docker Desktop, running, for `supabase start`
- A GitHub OAuth app for local login, and a GitHub App for pull request and Actions webhooks
- An OpenAI API key (`OPENAI_API_KEY`) for grouping work into the map. Without it, GitHub and session facts are still stored and pull request states still update.

Copy `.env.example` to `.env` and fill the values after `supabase status`. Do not commit `.env`.

`GITHUB_WEBHOOK_SECRET` must be a non-empty string. The API exits on startup when it is missing, and signature checks reject an empty secret. Connecting a repository also requires `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. The API asks GitHub whether that App installation can access the repository before it accepts the claim. A private key stored in `.env` can use literal `\n` escapes.

Public tables have row level security enabled and no policies. The API uses `DATABASE_URL` (the database owner), which is not the anon key. Do not put the service role key in the browser.

## Local commands

```bash
npm install
npx supabase start
npm run typecheck
npm test
npm run dev:api
npm run dev:web
npm run dev:worker
npm run dev:helper
```

`npm test` needs `DATABASE_URL` and the migrations in `supabase/migrations` applied. `supabase start` does both. Tests that talk to GitHub are mocked.

The collector uploads each session as ordered chunks of at most 96 KiB. Each HTTP request is limited to 512 KiB, and that limit does not cap the session. The API keeps chunks in `session_upload_chunks` until every chunk has arrived, then reassembles the original bytes and writes events. A failed upload resumes from the last acknowledged chunk. Chunk rows are removed after assembly, so absolute paths in the payload are not kept with the stored events. A later upload of the same session stores new records; an identical retry does not create a second copy.

## Upload one session from the collector

Sign in with the web app, connect the repository, and start the API (`npm run dev:api`). Then upload one local session. Codex and Claude Code take a session file. Cursor takes the session directory that contains `session.json` and `transcript.jsonl`. Roots are absolute paths.

```bash
psql "$DATABASE_URL" -c "select id, github_owner, github_name, tracking_started_at from projects;"

export APM_ACCESS_TOKEN='paste-the-access-token'
npm start -w @apm/collector -- upload \
  /absolute/path/to/session.jsonl \
  codex \
  'project-uuid-from-the-query' \
  'tracking-started-at-from-the-query' \
  /absolute/selected/root
```

The API URL defaults to `http://127.0.0.1:4000`. Override it with `APM_API_URL` or `--api-url`. Put the token only in `APM_ACCESS_TOKEN`. The command exits with an error if that variable is missing, if you pass the token as an argument, or if the server rejects the reassembled bytes.

The web app reads the same token from `supabase.auth.getSession()` and sends it as `Authorization: Bearer`. After you are signed in at `http://127.0.0.1:5173`, open the browser devtools, choose Application → Local Storage → that origin, and open the key `sb-127-auth-token` (the default local Supabase URL is `http://127.0.0.1:54321`; the key is `sb-` plus the first label of that host). The value is JSON. Copy its `access_token` field. In the console on that page:

```js
copy(JSON.parse(localStorage.getItem("sb-127-auth-token")).access_token)
```

Day 1 builds login, the single-repository GitHub connection, webhook reception, session samples, folder matching, and the common event contracts on top of this skeleton.

Day 2 makes collection recoverable. The helper keeps per-session checkpoints and an upload queue in SQLite. Eligible sessions are queued from the beginning of the log, including opening messages found after the helper starts. A session created before tracking stays excluded when it is resumed. Appended lines are queued once. If the upload fails, the queue is still there after a restart and the same event ids are sent again.

Start the helper, then click "Connect local helper" in the signed-in web app:

```bash
npm run dev:helper
```

The web app creates a one-time code and hands it to the helper at `http://127.0.0.1:47321`. If the helper cannot be reached, the web app shows the code so you can paste it on the helper page. The helper stores a revocable device token. `DELETE /collector/token` with that token stops further uploads. Open the helper page to add the project folders; only sessions whose working folder is inside one of them are uploaded.

While it runs, the helper scans the agent logs every 30 seconds and uploads what it queued. It reads `~/.codex/sessions` and `~/.claude/projects` by default. Cursor sessions are read only from a folder set in `APM_CURSOR_SESSIONS`, because Cursor does not write `session.json` and `transcript.jsonl` without a hook. Files that have not changed since the last scan are skipped. A session's new messages are split into events of at most 200 messages and 256 KiB, and a single message longer than 32 KiB is shortened. The queue is sent in requests of at most 100 events and 448 KiB, so it always fits the API's limits. When the API is unreachable, the helper retries after 5 seconds, then doubles the wait up to 5 minutes. When the API refuses the device token, the helper page asks you to connect again. Events the API rejects for good (for example a session created before tracking) are dropped from the queue. The page shows the last scan, the last upload, what is waiting, and any paused sessions, and has a "Scan now" button.

The worker (`npm run dev:worker`) runs two pg-boss schedules. Every minute it processes webhook deliveries that are still queued a minute after they arrived, for example because the API stopped mid-request. Every 5 minutes it asks GitHub for the current state of open pull requests and unfinished workflow runs seen in the last 30 days and 24 hours, and stores an update when GitHub reports a newer one. A delivery whose processing fails is retried by the sweep and marked `failed` after 5 attempts; it no longer holds up the deliveries behind it.

Day 3 turns stored events into the map. The worker checks every 5 seconds for projects with new events and processes each project one at a time, in two stages.

The facts stage uses no AI. It records pull requests, reviews and workflow runs (keeping every rerun attempt), and turns new session messages and new pull request descriptions into evidence. A message that was already stored does not become evidence again, and a pull request update that only changes GitHub's timestamp creates none. A work item's state comes from its pull requests when it has any: open means in review, a draft means in progress, and it counts as merged only when every pull request is closed and at least one was merged. Without pull requests, a session can only make work planned or in progress, so an agent saying "done" never marks anything merged.

The interpretation stage sends new evidence to the OpenAI model once no new evidence has arrived for 20 seconds, or 60 seconds after the oldest piece is waiting. Up to 12 pieces go at once, along with the existing features, the work items most likely to be related (same session, same or explicitly linked pull request, recent, or sharing words), and earlier excerpts from the same sessions. The model answers with a fixed JSON shape. It refers to evidence and records only by short labels from the prompt, such as `E1` or `W2`, so it cannot name a record it was not shown. The API checks every operation before saving it and drops any that cite unknown labels, give no evidence, or change something a person set. Text inside sessions and pull requests is marked as data in the prompt. When the model call fails, the facts stay, the map keeps its last version, and the evidence is retried with a growing delay (30 seconds, doubling up to 30 minutes, 6 attempts). When the model returns no changes, processing finishes and the map revision stays the same.

The map revision goes up only when something a viewer can see changes. The API serves it at:

| Route | Returns |
|---|---|
| `GET /projects/:id/graph` | Features, their work items with state and counts, dependencies, and how much evidence still waits for analysis |
| `GET /projects/:id/graph/revision` | Only the revision number, for cheap polling |
| `GET /projects/:id/work-items/:workItemId` | Pull requests with CI runs, evidence excerpts, contributors, dependencies and change history |
| `GET /projects/:id/features/:featureId` | The feature's work items, contributors and history |
| `POST /projects/:id/corrections` | Applies `rename`, `move`, `merge`, `split` or `dismiss` |

A correction is saved as a person's decision. A renamed title or a moved item is not changed back by later analysis. A merged item's old id keeps resolving to the item it was merged into. Evidence and pull requests split out of an item cannot be attached to it again. A dismissed dependency stays dismissed. If a correction lands while the model is still working on records it touched, that answer is discarded and the evidence is analyzed again against the corrected map.

To check grouping quality with a real model, set `OPENAI_API_KEY` and run:

```bash
npm run eval -w @apm/api
```

It feeds sample sessions from all three agents and a few pull requests into a temporary project, prints the resulting map, and reports how many pairs of related evidence ended up together and how many unrelated pairs stayed apart. The project is deleted afterwards unless you pass `-- --keep`. `OPENAI_MODEL` defaults to `gpt-5-mini`.
