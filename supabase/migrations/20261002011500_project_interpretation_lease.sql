-- Interpretation used to hold a session advisory lock, and that session stayed checked out for the
-- whole model call. A timestamp on the project expires on its own, so a worker can return the
-- connection while it waits.
alter table projects add column locked_until timestamptz;
