-- When the sweep may try a delivery again after its processing failed.
alter table webhook_deliveries add column if not exists next_attempt_at timestamptz;

-- When the periodic refresh last asked GitHub about an item, so every open item gets a turn.
alter table github_observations add column if not exists refreshed_at timestamptz;
