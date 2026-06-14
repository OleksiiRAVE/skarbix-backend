alter table public.monobank_connections
  alter column token_ciphertext drop not null,
  alter column token_iv drop not null,
  alter column token_auth_tag drop not null;

alter table public.monobank_connections
  add column if not exists auth_mode text not null default 'personal_token',
  add column if not exists status text not null default 'connected',
  add column if not exists token_request_id text,
  add column if not exists accept_url text,
  add column if not exists authorized_at timestamptz,
  add column if not exists last_webhook_at timestamptz;

do $$
begin
  alter table public.monobank_connections
    drop constraint if exists monobank_connections_auth_mode_check;
  alter table public.monobank_connections
    add constraint monobank_connections_auth_mode_check
    check (auth_mode in ('personal_token', 'provider'));

  alter table public.monobank_connections
    drop constraint if exists monobank_connections_status_check;
  alter table public.monobank_connections
    add constraint monobank_connections_status_check
    check (status in ('pending', 'connected', 'revoked', 'error'));
end;
$$;

create unique index if not exists monobank_connections_token_request_idx
  on public.monobank_connections(token_request_id)
  where token_request_id is not null;

create table if not exists public.monobank_webhook_events (
  id uuid primary key default gen_random_uuid(),
  token_request_id text not null,
  external_id text,
  event_type text not null,
  payload_hash text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  unique (token_request_id, payload_hash)
);

alter table public.monobank_webhook_events enable row level security;

create index if not exists monobank_webhook_events_received_idx
  on public.monobank_webhook_events(received_at desc);

revoke all on public.monobank_webhook_events from anon, authenticated;
