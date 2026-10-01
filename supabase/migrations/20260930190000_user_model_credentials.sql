-- A person's own model key, used to group repositories they own. The ciphertext is produced by the API
-- (AES-GCM under APM_SECRETS_KEY). The key itself is never stored in the clear and is never sent back
-- to the browser; key_hint is only the last four characters.
create table user_model_credentials (
  user_id uuid primary key,
  provider text not null check (provider in ('openai', 'anthropic', 'gemini')),
  model text not null,
  key_ciphertext bytea not null,
  key_hint text not null,
  updated_at timestamptz not null default now()
);

alter table user_model_credentials enable row level security;
