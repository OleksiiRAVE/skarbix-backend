create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  default_currency text not null default 'UAH',
  locale text not null default 'uk',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null check (type in ('cash', 'bank', 'card', 'savings', 'investment', 'other')),
  currency text not null default 'UAH',
  balance numeric(14,2) not null default 0,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  type text not null check (type in ('income', 'expense')),
  color text,
  icon text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, name, type)
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete set null,
  category_id uuid references public.categories(id) on delete set null,
  type text not null check (type in ('income', 'expense', 'transfer')),
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null default 'UAH',
  merchant text,
  notes text,
  occurred_at timestamptz not null default now(),
  source text not null default 'manual' check (source in ('manual', 'monobank', 'import', 'ai')),
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  name text not null,
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null default 'UAH',
  period text not null check (period in ('weekly', 'monthly', 'yearly')),
  starts_on date not null,
  ends_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  person_name text not null,
  direction text not null check (direction in ('owed_to_me', 'i_owe')),
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null default 'UAH',
  status text not null default 'pending' check (status in ('pending', 'overdue', 'paid')),
  due_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  ip inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.accounts enable row level security;
alter table public.categories enable row level security;
alter table public.transactions enable row level security;
alter table public.budgets enable row level security;
alter table public.debts enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "accounts_owner_all" on public.accounts;
drop policy if exists "categories_owner_select" on public.categories;
drop policy if exists "categories_owner_write" on public.categories;
drop policy if exists "transactions_owner_all" on public.transactions;
drop policy if exists "budgets_owner_all" on public.budgets;
drop policy if exists "debts_owner_all" on public.debts;
drop policy if exists "audit_logs_select_own" on public.audit_logs;

create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "accounts_owner_all" on public.accounts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "categories_owner_select" on public.categories for select using (user_id is null or auth.uid() = user_id);
create policy "categories_owner_write" on public.categories for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "transactions_owner_all" on public.transactions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "budgets_owner_all" on public.budgets for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "debts_owner_all" on public.debts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "audit_logs_select_own" on public.audit_logs for select using (auth.uid() = user_id);

create index if not exists accounts_user_id_idx on public.accounts(user_id);
create index if not exists categories_user_id_idx on public.categories(user_id);
create index if not exists transactions_user_id_occurred_at_idx on public.transactions(user_id, occurred_at desc);
create index if not exists budgets_user_id_idx on public.budgets(user_id);
create index if not exists debts_user_id_idx on public.debts(user_id);
create index if not exists audit_logs_user_id_created_at_idx on public.audit_logs(user_id, created_at desc);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'name')
  )
  on conflict (id) do update
    set email = excluded.email,
        display_name = coalesce(public.profiles.display_name, excluded.display_name),
        updated_at = now();

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from anon, authenticated, public;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rls_auto_enable'
      and p.pronargs = 0
  ) then
    revoke execute on function public.rls_auto_enable() from anon, authenticated, public;
  end if;
end;
$$;
