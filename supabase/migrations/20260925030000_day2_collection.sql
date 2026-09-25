-- One-time codes the signed-in user gives the local helper.
create table collector_pairing_codes (
  code_hash text primary key,
  project_id uuid not null references projects (id) on delete cascade,
  user_id uuid not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

-- Revocable device tokens. Only the hash is stored.
create table collector_tokens (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  label text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Current GitHub facts used so a late webhook cannot undo a known merge.
create table github_observations (
  project_id uuid not null references projects (id) on delete cascade,
  kind text not null check (kind in ('pull_request', 'workflow_run', 'workflow_job')),
  source_id text not null,
  head_sha text,
  updated_at timestamptz not null,
  merged boolean,
  state jsonb not null,
  primary key (project_id, kind, source_id)
);

alter table collector_pairing_codes enable row level security;
alter table collector_tokens enable row level security;
alter table github_observations enable row level security;
