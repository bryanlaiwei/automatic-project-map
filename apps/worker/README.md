# Worker

The worker process reads Postgres and turns stored events into map data. It does not handle HTTP and it does not scan the local machine.

## Structure

```mermaid
flowchart TD
  start["index.ts starts the worker"] --> jobIn["When a webhook arrives: finish that delivery"]
  start --> minute["Every minute: finish webhook rows still queued"]
  start --> fiveMin["Every 5 minutes: ask GitHub if stored pull requests and workflow runs changed"]
  start --> fiveSec["Every 5 seconds: find projects with pending events or ready evidence"]

  jobIn --> events["Write normalized_events"]
  minute --> events
  fiveMin --> events

  fiveSec --> job["Queue one job per project, up to 3 at once"]
  job --> facts["Facts: write pull requests, reviews, workflow runs, and evidence"]
  facts --> model{"Saved OpenAI, Anthropic, or Gemini key, or OPENAI_API_KEY?"}
  model -->|yes| interpret["Model reads up to 8 unread evidence rows and saves accepted map operations"]
  model -->|no| wait["Evidence stays unread"]
  events --> fiveSec
```

## Files

- `package.json` declares the `@apm/worker` package, its run scripts, and its dependency on `pg-boss`.
- `tsconfig.json` points the TypeScript compiler at `src` and emits into `dist`.
- `src/index.ts` checks configuration, connects to Postgres and GitHub, and starts the worker until the process is stopped. Map processing comes from `packages/core`.
- `src/worker.ts` runs a saved webhook as soon as the API queues it, schedules the minute and five-minute loops, and runs facts, then model interpretation, for each due project.
