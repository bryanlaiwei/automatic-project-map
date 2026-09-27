-- GitHub's numeric account id. A login can be renamed and later taken by someone else; the id cannot.
alter table profiles add column if not exists github_user_id bigint;
alter table invitations add column if not exists github_user_id bigint;

create unique index if not exists invitations_open_account_idx on invitations (workspace_id, github_user_id)
  where accepted_at is null and revoked_at is null and github_user_id is not null;
-- The login stays unique only for invitations made before ids were recorded; a login can move to a new account.
drop index if exists invitations_open_idx;
create unique index if not exists invitations_open_login_idx on invitations (workspace_id, lower(github_login))
  where accepted_at is null and revoked_at is null and github_user_id is null;

-- Helpers paired before collector_tokens.user_id existed belong to nobody, so removing a member could not
-- disconnect them. Attach each to the person whose pairing code was used within five minutes of it, when
-- that is exactly one current member, and disconnect the rest so they are paired again by someone known.
with candidates as (
  select t.id as token_id, min(c.user_id::text)::uuid as user_id, count(distinct c.user_id) as people
  from collector_tokens t
  join projects p on p.id = t.project_id
  join collector_pairing_codes c
    on c.project_id = t.project_id
   and c.used_at between t.created_at - interval '5 minutes' and t.created_at + interval '5 minutes'
  join memberships m on m.workspace_id = p.workspace_id and m.user_id = c.user_id
  where t.user_id is null and t.revoked_at is null
  group by t.id
)
update collector_tokens t
set user_id = candidates.user_id
from candidates
where candidates.token_id = t.id and candidates.people = 1;

update collector_tokens set revoked_at = now() where user_id is null and revoked_at is null;

alter table collector_tokens drop constraint if exists collector_tokens_active_have_owner;
alter table collector_tokens add constraint collector_tokens_active_have_owner check (user_id is not null or revoked_at is not null);
