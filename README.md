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
- An Anthropic API key when interpretation work starts

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
```

`npm test` needs `DATABASE_URL` and the migrations in `supabase/migrations` applied. `supabase start` does both. Tests that talk to GitHub are mocked.

The collector uploads each session as ordered chunks of at most 96 KiB. Each HTTP request is limited to 512 KiB, and that limit does not cap the session. The API keeps chunks in `session_upload_chunks` until every chunk has arrived, then reassembles the original bytes and writes events. A failed upload resumes from the last acknowledged chunk. Chunk rows are removed after assembly, so absolute paths in the payload are not kept with the stored events. A later upload of the same session stores new records; an identical retry does not create a second copy.

Day 1 builds login, the single-repository GitHub connection, webhook reception, session samples, folder matching, and the common event contracts on top of this skeleton.
