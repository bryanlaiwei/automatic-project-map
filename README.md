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

## Local commands

```bash
npm install
npm run typecheck
npm test
npx supabase start
npm run dev:api
npm run dev:web
```

Day 1 builds login, the single-repository GitHub connection, webhook reception, session samples, folder matching, and the common event contracts on top of this skeleton.
