-- GitHub identity of signed-in people, refreshed when they open the app, so members, inviters and
-- correction authors can be shown by name.
create table profiles (
  user_id uuid primary key,
  github_login text,
  display_name text,
  avatar_url text,
  updated_at timestamptz not null default now()
);

create index profiles_github_login_idx on profiles (lower(github_login));

alter table memberships add column created_at timestamptz not null default now();

-- Invitations name a GitHub account. Only that account can accept.
create table invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  github_login text not null,
  role text not null default 'member' check (role in ('owner', 'member')),
  invited_by uuid not null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at timestamptz
);

create unique index invitations_open_idx on invitations (workspace_id, lower(github_login))
  where accepted_at is null and revoked_at is null;

-- Where feature nodes sit on the map. Presentation only: saving a position never changes the graph revision.
create table layout_positions (
  project_id uuid not null references projects (id) on delete cascade,
  node_id uuid not null,
  x double precision not null,
  y double precision not null,
  updated_at timestamptz not null default now(),
  primary key (project_id, node_id)
);

alter table collector_tokens add column user_id uuid;
alter table collector_tokens add column last_seen_at timestamptz;

alter table profiles enable row level security;
alter table invitations enable row level security;
alter table layout_positions enable row level security;
