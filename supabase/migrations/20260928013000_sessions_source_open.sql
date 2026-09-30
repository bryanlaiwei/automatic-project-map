-- Session source is checked by the shared event schema. A new agent should not need a migration
-- just to be stored.
alter table sessions drop constraint if exists sessions_source_check;
