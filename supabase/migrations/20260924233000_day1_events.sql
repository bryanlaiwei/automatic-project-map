create extension if not exists pgcrypto;

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table memberships (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'member')),
  primary key (workspace_id, user_id)
);

-- One project per workspace, and one GitHub repository for that project.
create table projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references workspaces (id) on delete cascade,
  github_repo_id bigint not null unique,
  github_owner text not null,
  github_name text not null,
  tracking_started_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table normalized_events (
  event_id text primary key,
  source_key text not null,
  project_id uuid not null references projects (id) on delete cascade,
  source text not null,
  kind text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  details jsonb not null,
  schema_version integer not null
);

create index normalized_events_project_idx on normalized_events (project_id, received_at);

-- A GitHub delivery is stored before we trust the event.
-- The same delivery id is ignored on retry.
create table webhook_deliveries (
  delivery_id text primary key,
  event_name text not null,
  github_repo_id bigint,
  payload jsonb not null,
  status text not null check (status in ('queued', 'processed', 'ignored', 'failed')),
  note text,
  attempts integer not null default 0,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
