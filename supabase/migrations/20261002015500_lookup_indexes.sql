-- The minute sweep reads only queued deliveries, oldest first. Finished rows stay out of this index.
create index if not exists webhook_deliveries_queued_idx on webhook_deliveries (received_at) where status = 'queued';

-- Settings health and project deletion look deliveries up by repository.
create index if not exists webhook_deliveries_repo_idx on webhook_deliveries (github_repo_id, received_at);

-- Project lists look memberships up by person. The primary key starts with workspace_id, so it cannot.
create index if not exists memberships_user_idx on memberships (user_id);
