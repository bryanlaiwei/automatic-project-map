-- Staging for resumable session uploads. Rows are removed after the session is assembled.
-- The primary key is the session identity plus the chunk number, so a retry of the same
-- chunk is idempotent and a partial upload is still here after the API restarts.
create table session_upload_chunks (
  project_id uuid not null references projects (id) on delete cascade,
  source text not null check (source in ('codex', 'cursor', 'claude_code')),
  session_id text not null,
  chunk_index integer not null check (chunk_index >= 0),
  chunk_count integer not null check (chunk_count > 0),
  content_sha256 text not null,
  payload bytea not null,
  received_at timestamptz not null default now(),
  primary key (project_id, source, session_id, chunk_index),
  check (chunk_index < chunk_count)
);

-- Remembers a finished upload without keeping the payload (or the absolute paths inside it).
create table session_upload_receipts (
  project_id uuid not null references projects (id) on delete cascade,
  source text not null check (source in ('codex', 'cursor', 'claude_code')),
  session_id text not null,
  content_sha256 text not null,
  chunk_count integer not null check (chunk_count > 0),
  stored boolean not null,
  reason text,
  events_stored integer not null,
  assembled_at timestamptz not null default now(),
  primary key (project_id, source, session_id, content_sha256)
);

-- The API uses the database owner connection, which bypasses row level security.
-- The Supabase anon and authenticated roles have no policies, so the public anon key
-- cannot read or write these tables through the Data API.
alter table workspaces enable row level security;
alter table memberships enable row level security;
alter table projects enable row level security;
alter table normalized_events enable row level security;
alter table webhook_deliveries enable row level security;
alter table session_upload_chunks enable row level security;
alter table session_upload_receipts enable row level security;
