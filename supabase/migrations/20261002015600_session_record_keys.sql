-- Every session message already turned into evidence. A new upload checks only its own messages against the
-- primary key instead of reading every earlier key in the session.
create table session_record_keys (
  project_id uuid not null references projects (id) on delete cascade,
  source text not null,
  session_id text not null,
  record_key text not null,
  primary key (project_id, source, session_id, record_key)
);

insert into session_record_keys (project_id, source, session_id, record_key)
select distinct e.project_id, e.source, e.session_id, k.record_key
from evidence e
cross join lateral unnest(e.record_keys) as k (record_key)
where e.session_id is not null
on conflict do nothing;

alter table session_record_keys enable row level security;
