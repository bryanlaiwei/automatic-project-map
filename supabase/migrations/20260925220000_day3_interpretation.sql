-- The revision increases once per batch or correction that changes something a viewer can see.
alter table projects add column graph_revision bigint not null default 0;

-- One row per facts or interpretation pass. A batch's changes and its final status commit together.
create table processing_batches (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  stage text not null check (stage in ('facts', 'interpretation')),
  status text not null check (status in ('running', 'applied', 'no_change', 'failed')),
  event_ids text[] not null default '{}',
  evidence_ids uuid[] not null default '{}',
  attempt integer not null default 1,
  model text,
  prompt_version text,
  base_revision bigint not null,
  result_revision bigint,
  proposal jsonb,
  rejected jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index processing_batches_project_idx on processing_batches (project_id, created_at);

-- Facts are applied once per stored event. Interpretation is tracked on the evidence rows facts create.
alter table normalized_events
  add column facts_state text not null default 'pending' check (facts_state in ('pending', 'applied', 'invalid')),
  add column facts_batch_id uuid references processing_batches (id) on delete set null;

create index normalized_events_facts_pending_idx on normalized_events (project_id, occurred_at)
  where facts_state = 'pending';

create table sessions (
  project_id uuid not null references projects (id) on delete cascade,
  source text not null check (source in ('codex', 'cursor', 'claude_code')),
  session_id text not null,
  created_at timestamptz not null,
  source_version text,
  first_event_id text not null,
  primary key (project_id, source, session_id)
);

-- Current GitHub facts for a pull request or an Actions run. Jobs and earlier attempts live in state.
create table artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  kind text not null check (kind in ('pull_request', 'workflow_run')),
  source_id text not null,
  number integer,
  head_sha text,
  url text not null,
  state jsonb not null,
  source_updated_at timestamptz not null,
  text_fingerprint text,
  created_at timestamptz not null default now(),
  unique (project_id, kind, source_id)
);

create index artifacts_head_sha_idx on artifacts (project_id, head_sha);

create table evidence (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  event_id text not null references normalized_events (event_id) on delete cascade,
  part integer not null,
  kind text not null check (kind in ('session_excerpt', 'pull_request')),
  source text not null,
  session_id text,
  artifact_id uuid references artifacts (id) on delete cascade,
  record_ids text[] not null default '{}',
  -- Digest of id, role, time and text per message. A repeated full-session upload adds no new evidence.
  record_keys text[] not null default '{}',
  excerpt text not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  interpretation_state text not null default 'pending'
    check (interpretation_state in ('pending', 'applied', 'no_change', 'failed')),
  interpretation_batch_id uuid references processing_batches (id) on delete set null,
  interpretation_attempts integer not null default 0,
  retry_at timestamptz,
  unique (event_id, part)
);

create index evidence_pending_idx on evidence (project_id, observed_at)
  where interpretation_state in ('pending', 'failed');
create index evidence_session_idx on evidence (project_id, source, session_id);

create table feature_groups (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  title text not null,
  title_basis text not null check (title_basis in ('observed', 'inferred', 'human')),
  summary text not null,
  summary_basis text not null check (summary_basis in ('observed', 'inferred', 'human')),
  retired_into uuid references feature_groups (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index feature_groups_project_idx on feature_groups (project_id) where retired_into is null;

create table work_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  feature_id uuid not null references feature_groups (id),
  feature_basis text not null check (feature_basis in ('observed', 'inferred', 'human')),
  title text not null,
  title_basis text not null check (title_basis in ('observed', 'inferred', 'human')),
  summary text not null,
  summary_basis text not null check (summary_basis in ('observed', 'inferred', 'human')),
  state text not null check (state in ('planned', 'in_progress', 'in_review', 'merged', 'closed', 'unknown')),
  state_basis text not null check (state_basis in ('observed', 'inferred', 'human')),
  -- What the model read from sessions. Pull request facts override it.
  inferred_state text check (inferred_state in ('planned', 'in_progress')),
  inferred_state_at timestamptz,
  blocked boolean not null default false,
  blocked_reason text,
  retired_into uuid references work_items (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index work_items_project_idx on work_items (project_id) where retired_into is null;
create index work_items_feature_idx on work_items (feature_id);

create table work_item_evidence (
  work_item_id uuid not null references work_items (id) on delete cascade,
  evidence_id uuid not null references evidence (id) on delete cascade,
  basis text not null check (basis in ('observed', 'inferred', 'human')),
  created_at timestamptz not null default now(),
  primary key (work_item_id, evidence_id)
);

create index work_item_evidence_evidence_idx on work_item_evidence (evidence_id);

create table work_item_artifacts (
  work_item_id uuid not null references work_items (id) on delete cascade,
  artifact_id uuid not null references artifacts (id) on delete cascade,
  basis text not null check (basis in ('observed', 'inferred', 'human')),
  evidence_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (work_item_id, artifact_id)
);

create index work_item_artifacts_artifact_idx on work_item_artifacts (artifact_id);

create table relationships (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  kind text not null check (kind in ('depends_on')),
  from_work_item_id uuid not null references work_items (id) on delete cascade,
  to_work_item_id uuid not null references work_items (id) on delete cascade,
  basis text not null check (basis in ('observed', 'inferred', 'human')),
  evidence_ids uuid[] not null default '{}',
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (from_work_item_id, to_work_item_id, kind),
  check (from_work_item_id <> to_work_item_id)
);

create table corrections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  user_id uuid not null,
  kind text not null,
  payload jsonb not null,
  revision bigint not null,
  created_at timestamptz not null default now()
);

-- Links a person separated. Interpretation cannot recreate them.
create table link_blocks (
  work_item_id uuid not null references work_items (id) on delete cascade,
  target_kind text not null check (target_kind in ('evidence', 'artifact')),
  target_id uuid not null,
  correction_id uuid not null references corrections (id) on delete cascade,
  primary key (work_item_id, target_kind, target_id)
);

create table identity_aliases (
  project_id uuid not null references projects (id) on delete cascade,
  entity_kind text not null check (entity_kind in ('feature', 'work_item')),
  retired_id uuid not null,
  surviving_id uuid not null,
  correction_id uuid references corrections (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (entity_kind, retired_id)
);

create table graph_changes (
  id bigserial primary key,
  project_id uuid not null references projects (id) on delete cascade,
  revision bigint not null,
  entity_kind text not null check (entity_kind in ('feature', 'work_item', 'relationship')),
  entity_id uuid not null,
  change text not null,
  before jsonb,
  after jsonb,
  basis text not null check (basis in ('observed', 'inferred', 'human')),
  evidence_ids uuid[] not null default '{}',
  batch_id uuid references processing_batches (id) on delete set null,
  correction_id uuid references corrections (id) on delete set null,
  created_at timestamptz not null default now()
);

create index graph_changes_entity_idx on graph_changes (project_id, entity_kind, entity_id, id);

alter table processing_batches enable row level security;
alter table sessions enable row level security;
alter table artifacts enable row level security;
alter table evidence enable row level security;
alter table feature_groups enable row level security;
alter table work_items enable row level security;
alter table work_item_evidence enable row level security;
alter table work_item_artifacts enable row level security;
alter table relationships enable row level security;
alter table corrections enable row level security;
alter table link_blocks enable row level security;
alter table identity_aliases enable row level security;
alter table graph_changes enable row level security;
