# automatic-project-map

Automatic feature map from GitHub and local agent work.

This repository is the local pilot from the MVP plan: a TypeScript npm workspace with a React web app, an Express API, a pg-boss worker, a local helper, and local Supabase for Postgres and GitHub login.

## Layout

| Path | Role |
|---|---|
| `apps/web` | React, Vite, and Tailwind |
| `apps/api` | Express HTTP routes |
| `apps/worker` | pg-boss background jobs |
| `packages/core` | Database, map processing, and other logic shared by the API and the worker |
| `apps/local-collector` | Local helper, SQLite checkpoints and upload queue |
| `apps/github-collector` | GitHub webhook normalization, enrichment, and refresh |
| `packages/shared` | Shared schemas and types |
| `supabase` | Local Postgres and Auth |

## Prerequisites

- Node.js 22
- Docker Desktop, running, for `supabase start`
- A GitHub OAuth app for local login, and a GitHub App for pull request and Actions webhooks
- An OpenAI, Anthropic, or Gemini API key for grouping work into the map. Each project owner saves their own key in Settings → Model. `OPENAI_API_KEY` is an optional server-wide fallback used when an owner has not saved one. Saving a key also needs `APM_SECRETS_KEY`, which encrypts it at rest. Without either a saved key or `OPENAI_API_KEY`, GitHub and session facts are still stored and pull request states still update.

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

## Server

`npm run dev:api` and `npm run dev:worker` stay on your machine and run TypeScript directly. On a server, compile first, then start the compiled programs:

```bash
npm run build:server
npm start --workspace @apm/api
npm start --workspace @apm/worker
```

`npm start` listens on every interface and on `PORT` (otherwise `API_PORT`, otherwise 4000). Set `HOST` to pin the address. The API and the worker both stop on `SIGTERM`: the API stops accepting requests, stops the webhook publisher, and closes the database pool. A worker stopped during a model call releases the interpretation lease it holds.

The web app bakes its addresses in at build time, so set them before building:

```bash
npm run build --workspace @apm/web
```

Required environment variables: `DATABASE_URL`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `SUPABASE_URL` (and `SUPABASE_JWT_SECRET` when tokens are still HS256), `APM_SECRETS_KEY`, and `WEB_ORIGIN`. `OPENAI_API_KEY` is only for a server-wide model key. A missing `.env` file is fine. Variables already set in the environment are left as they are.

`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_API_URL` have to be set before the web build. The helper still runs on each person's computer. Set that computer's `WEB_ORIGIN` to the hosted site so the site can reach it. Pairing sends the API address from `VITE_API_URL`.

Each API process opens `DATABASE_POOL_MAX` database connections (default 10) plus 2 for the webhook publisher. The worker opens `DATABASE_POOL_MAX` plus 4. Two API processes and one worker is 38 at the defaults. On Supabase, use the pooler connection string and lower `DATABASE_POOL_MAX`. Turn on database backups. Keep a copy of `APM_SECRETS_KEY` somewhere safe: saved model keys cannot be read without it.

In the Supabase dashboard, add the site address to the redirect URLs. Add that same address as the GitHub OAuth callback. Point the GitHub App webhook at `https://<your-api>/github/webhook`.

An index added later, once a table has real data, should use `create index concurrently` and run outside a transaction.

Login, the single-repository GitHub connection, webhook reception, session samples, folder matching, and the common event contracts sit on top of this skeleton.

Collection is recoverable. The helper keeps per-session checkpoints and an upload queue in SQLite. Eligible sessions are queued from the beginning of the log, including opening messages found after the helper starts. A session created before tracking stays excluded when it is resumed. Appended lines are queued once. If the upload fails, the queue is still there after a restart and the same event ids are sent again.

Start the helper, then click "Connect local helper" in the signed-in web app:

```bash
npm run dev:helper
```

The web app creates a one-time code and hands it to the helper at `http://127.0.0.1:47321`. If the helper cannot be reached, the web app shows the code so you can paste it on the helper page from a browser on that computer. The helper stores a revocable device token. `DELETE /helper/token` with that token stops further uploads. The helper page in the web app is where you add the project folders; only sessions whose working folder is inside one of them are uploaded.

While it runs, the helper scans the agent logs every 30 seconds and uploads what it queued. It reads `~/.codex/sessions` and `~/.claude/projects` by default. Cursor sessions are read only from a folder set in `APM_CURSOR_SESSIONS`, because Cursor does not write `session.json` and `transcript.jsonl` without a hook. Files that have not changed since they were last collected are skipped; a session that fails to collect is tried again on the next scan without holding up the others. A session's new messages are split into events of at most 8,000 characters, 200 messages, and 256 KiB. The queue is sent in requests of at most 100 events and 448 KiB, so it always fits the API's limits. When the API is unreachable, the helper retries after 5 seconds, then doubles the wait up to 5 minutes. When the API refuses the device token, the helper page in the web app asks you to connect again. Events the API rejects for good (for example a session created before tracking) are dropped from the queue. The page shows the last scan, the last upload, what is waiting, and any paused sessions, and has a "Scan now" button.

The worker (`npm run dev:worker`) processes each webhook as a pg-boss job. The API stores the delivery and answers GitHub before calling the GitHub API; the worker then loads the current pull request or workflow run. Every minute it also processes deliveries that are still queued a minute after they arrived, for example because that job was never queued. Every 5 minutes it asks GitHub for the current state of open pull requests and unfinished workflow runs seen in the last 30 days and 24 hours, least recently checked first, and stores an update when GitHub reports a newer one. When GitHub cannot be reached, a delivery is stored from the webhook payload alone. A delivery whose processing fails is retried by the sweep after 1, 2, 4 and 8 minutes and marked `failed` after 5 attempts; it no longer holds up the deliveries behind it.

Stored events become the map. The worker checks every 5 seconds for projects with new events and processes them in two stages, up to three projects side by side. Facts never wait for AI: they are applied before interpretation starts and again after each model call, even while another run is interpreting the same project. Pull request and CI facts only enter through the verified webhook and the refresh; `/ingest/events` refuses GitHub events.

The facts stage uses no AI. It records pull requests, reviews and workflow runs (keeping every rerun attempt), and turns new session messages and new pull request descriptions into evidence. A message that was already stored does not become evidence again, and a pull request update that only changes GitHub's timestamp creates none. A work item's state comes from its pull requests when it has any: open means in review, a draft means in progress, and it counts as merged only when every pull request is closed and at least one was merged. Without pull requests, a session can only make work planned or in progress, so an agent saying "done" never marks anything merged.

The interpretation stage sends new evidence to the model key saved by a project owner (OpenAI, Anthropic, or Gemini), or to OpenAI when only `OPENAI_API_KEY` is set, once no new evidence has arrived for 20 seconds, or 60 seconds after the oldest piece is waiting. Up to 8 pieces go at once, along with the existing features, the work items most likely to be related (same session, same or explicitly linked pull request, recent, or sharing words), and earlier excerpts from the same sessions. The model answers with a fixed JSON shape. It refers to evidence and records only by short labels from the prompt, such as `E1` or `W2`, so it cannot name a record it was not shown. The API checks every operation before saving it and drops any that cite unknown labels, give no evidence, or change something a person set. Text inside sessions and pull requests is marked as data in the prompt. When the model call or saving its answer fails, the facts stay, the map keeps its last version, and the evidence is retried with a growing delay (30 seconds, doubling up to 30 minutes, and never dropped). Evidence that the model only cited in operations naming records it was not shown gets up to three tries. When the model returns no changes, processing finishes and the map revision stays the same.

The map revision goes up only when something a viewer can see changes. The API serves it at:

| Route | Returns |
|---|---|
| `GET /projects/:id/graph` | Features, their work items with state and counts, dependencies, and how much evidence still waits for analysis |
| `GET /projects/:id/graph/revision` | The revision number and how much evidence waits for analysis, for cheap polling |
| `GET /projects/:id/work-items/:workItemId` | Pull requests with CI runs, evidence excerpts, contributors, dependencies and change history |
| `GET /projects/:id/features/:featureId` | The feature's work items, contributors and history |
| `POST /projects/:id/corrections` | Applies `rename`, `move`, `merge`, `split` or `dismiss` |

A correction is saved as a person's decision. A renamed title or a moved item is not changed back by later analysis. A merged item's old id keeps resolving to the item it was merged into. Evidence and pull requests split out of an item cannot be attached to it again by analysis; merging the two items back is a person's decision and returns them. Work items moved by a feature merge stay where the person put them. A dismissed dependency stays dismissed. If a correction lands while the model is still working on records it touched, that answer is discarded and the evidence is analyzed again against the corrected map.

To check grouping quality with a real model, set `OPENAI_API_KEY` and run:

```bash
npm run eval -w @apm/api
```

It feeds sample sessions from all three agents and a few pull requests into a temporary project, prints the resulting map, and reports how many pairs of related evidence ended up together and how many unrelated pairs stayed apart. The project is deleted afterwards unless you pass `-- --keep`. `OPENAI_MODEL` defaults to `gpt-5-nano`, the cheapest OpenAI model. If the eval shows related work being split up or unrelated work lumped together, set `OPENAI_MODEL=gpt-5-mini` (about five times the price) and compare.

The web app is at `http://127.0.0.1:5173`.

- **Sign in and connect.** Sign in with GitHub, then enter the repository as `owner/name` or paste its URL. The API asks the GitHub App for the repository id, so you no longer type it, and checks that your GitHub account has write access to the repository. If you were invited, the invitation shows up there with a Join button. Your GitHub account comes from the GitHub identity Supabase recorded at sign-in, not from profile metadata. Inviting looks the username up through the GitHub App and records the account's numeric id, so only that account can see and accept the invitation, even after it renames itself or someone else takes the old name. You can connect as many repositories as you like, but each repository belongs to one project; "Connect another repository" in the account menu opens the connect page.
- **The map.** Each feature is a card with a bar showing how many of its work items are in each state, a line like "1 in progress · 1 in review · 1 merged", a blocked count when something is blocked, and the agents and people who worked on it. An arrow between two cards means work in one waits for work in the other; hover it to see which. Click a card to expand it in place and list its work items. Click a work item to open its details on the right.
- **Details.** A work item shows where its state comes from (for example "From GitHub: a pull request is open and ready for review"), its pull requests with review decisions and CI results including earlier failed attempts, its dependencies, the session excerpts and pull request descriptions linked to it, contributors, and a readable history that says whether GitHub, the AI or a named person made each change.
- **Corrections.** Click a title to rename it. The `…` menu moves a work item to another feature, merges it into another item, or splits pull requests and excerpts into a new item; features can be merged too. Hover a dependency and click × to remove it. Each correction is saved as that person's decision.
- **Layout.** Positions are shared by everyone on the project and saved separately from the map, so moving a card never changes the map revision. New features take the next free spot and existing cards stay where they are. Drag cards to rearrange them; a card dropped on another moves down to the nearest free spot. The grid button in the bottom-left corner re-arranges everything, with prerequisites to the left of the work that waits for them.
- **Refresh.** The page checks the map revision every 15 seconds and when the window regains focus, and reloads the map and any open details when it changed. A small notice at the top says when updates are waiting for AI analysis, and turns amber when they have waited more than 3 minutes.
- **Settings.** General shows the repository and tracking start, and lets an owner delete the project (type its name to confirm). Members lets an owner invite a GitHub username, revoke open invitations and remove people; members can leave. Removing someone also disconnects the helpers they paired and cancels pairing codes they had not used yet. Every connected helper belongs to the person who paired it; helpers paired before that was recorded are matched to the pairing code used for them, or disconnected so they can be paired again. Deleting a project also removes the stored webhook payloads for its repository. Model lets you save your own OpenAI, Anthropic, or Gemini key and pick a model from that supplier's list; repositories you own are grouped with that key. Local helper shows whether the helper on this computer is running and connected, connects it in one click, links to its folder page, and lists every connected helper with when it was last seen. Health shows the last GitHub webhook, the last session activity, and whether AI analysis is waiting or failing.

To look around without an OpenAI key, create a sample project for your account. Sign in once first, then run:

```bash
npm run demo:seed -w @apm/api -- your-github-username
```

It adds `demo/shop-app` to the repository menu. Its sample sessions, pull requests, reviews and CI runs go through the same processing as real data, with a scripted stand-in for the model. Run it again to rebuild it, or add `--remove` to delete it.
