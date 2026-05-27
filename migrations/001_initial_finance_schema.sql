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
  color text,
  icon text,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.accounts add column if not exists color text;
alter table public.accounts add column if not exists icon text;
alter table public.accounts add column if not exists external_source text;
alter table public.accounts add column if not exists external_id text;
alter table public.accounts add column if not exists masked_pan text;

do $$
begin
  alter table public.accounts drop constraint if exists accounts_type_check;
  alter table public.accounts
    add constraint accounts_type_check
    check (type in ('cash', 'bank', 'card', 'checking', 'savings', 'investment', 'other'));
end;
$$;

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  type text not null check (type in ('income', 'expense')),
  color text,
  icon text,
  is_system boolean not null default false,
  is_protected boolean not null default false,
  template_key text,
  created_at timestamptz not null default now(),
  unique (user_id, name, type)
);

alter table public.categories add column if not exists is_protected boolean not null default false;
alter table public.categories add column if not exists template_key text;

create table if not exists public.category_templates (
  key text primary key,
  name text not null,
  type text not null check (type in ('income', 'expense')),
  color text not null,
  icon text not null,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  account_id uuid references public.accounts(id) on delete set null,
  name text not null,
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null default 'UAH',
  period text not null default 'monthly' check (period in ('weekly', 'monthly', 'yearly')),
  next_payment_on date not null,
  color text,
  icon text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
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

create table if not exists public.monobank_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token_ciphertext text not null,
  token_iv text not null,
  token_auth_tag text not null,
  client_id text,
  client_name text,
  webhook_enabled boolean not null default false,
  imported_transactions integer not null default 0,
  last_sync_at timestamptz,
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
alter table public.category_templates enable row level security;
alter table public.transactions enable row level security;
alter table public.monobank_connections enable row level security;
alter table public.budgets enable row level security;
alter table public.debts enable row level security;
alter table public.subscriptions enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "accounts_owner_all" on public.accounts;
drop policy if exists "categories_owner_select" on public.categories;
drop policy if exists "categories_owner_write" on public.categories;
drop policy if exists "category_templates_select" on public.category_templates;
drop policy if exists "transactions_owner_all" on public.transactions;
drop policy if exists "monobank_connections_owner_all" on public.monobank_connections;
drop policy if exists "budgets_owner_all" on public.budgets;
drop policy if exists "debts_owner_all" on public.debts;
drop policy if exists "subscriptions_owner_all" on public.subscriptions;
drop policy if exists "audit_logs_select_own" on public.audit_logs;

create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "accounts_owner_all" on public.accounts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "categories_owner_select" on public.categories for select using (user_id is null or auth.uid() = user_id);
create policy "categories_owner_write" on public.categories for all using (auth.uid() = user_id and is_protected = false) with check (auth.uid() = user_id and is_protected = false);
create policy "category_templates_select" on public.category_templates for select using (true);
create policy "transactions_owner_all" on public.transactions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "budgets_owner_all" on public.budgets for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "debts_owner_all" on public.debts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "subscriptions_owner_all" on public.subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "audit_logs_select_own" on public.audit_logs for select using (auth.uid() = user_id);

create index if not exists accounts_user_id_idx on public.accounts(user_id);
create unique index if not exists accounts_user_external_idx on public.accounts(user_id, external_source, external_id);
create index if not exists categories_user_id_idx on public.categories(user_id);
create index if not exists subscriptions_user_id_next_payment_idx on public.subscriptions(user_id, next_payment_on);
create index if not exists transactions_user_id_occurred_at_idx on public.transactions(user_id, occurred_at desc);
create unique index if not exists transactions_user_source_external_idx on public.transactions(user_id, source, external_id);
create index if not exists budgets_user_id_idx on public.budgets(user_id);
create index if not exists debts_user_id_idx on public.debts(user_id);
create index if not exists audit_logs_user_id_created_at_idx on public.audit_logs(user_id, created_at desc);

insert into public.category_templates (key, name, type, color, icon, sort_order) values
  ('groceries', 'Groceries', 'expense', '#10B981', 'lucide:shopping-cart', 10),
  ('transport', 'Transport', 'expense', '#3B82F6', 'lucide:car', 20),
  ('entertainment', 'Entertainment', 'expense', '#8B5CF6', 'lucide:film', 30),
  ('dining_out', 'Dining Out', 'expense', '#F59E0B', 'lucide:utensils', 40),
  ('housing', 'Housing', 'expense', '#EF4444', 'lucide:home', 50),
  ('utilities', 'Utilities', 'expense', '#06B6D4', 'lucide:zap', 60),
  ('health', 'Health', 'expense', '#EC4899', 'lucide:heart-pulse', 70),
  ('work', 'Work', 'expense', '#6366F1', 'lucide:briefcase', 80),
  ('education', 'Education', 'expense', '#14B8A6', 'lucide:graduation-cap', 90),
  ('travel', 'Travel', 'expense', '#F97316', 'lucide:plane', 100),
  ('income', 'Income', 'income', '#10B981', 'lucide:trending-up', 110)
on conflict (key) do update set
  name = excluded.name,
  type = excluded.type,
  color = excluded.color,
  icon = excluded.icon,
  sort_order = excluded.sort_order;

create or replace function public.ensure_default_categories(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.categories (user_id, name, type, color, icon, is_system, is_protected, template_key)
  values
    (target_user_id, 'Subscriptions', 'expense', '#8B5CF6', 'lucide:repeat', true, true, 'subscriptions'),
    (target_user_id, 'Debts', 'expense', '#F97316', 'lucide:hand-coins', true, true, 'debts_expense'),
    (target_user_id, 'Debts', 'income', '#10B981', 'lucide:hand-coins', true, true, 'debts_income')
  on conflict (user_id, name, type) do update
    set is_system = true,
        is_protected = true,
        template_key = excluded.template_key,
        color = coalesce(public.categories.color, excluded.color),
        icon = coalesce(public.categories.icon, excluded.icon);

  update public.categories
  set template_key = 'debts_expense'
  where user_id = target_user_id
    and name = 'Debts'
    and type = 'expense'
    and template_key = 'debts';
end;
$$;

revoke execute on function public.ensure_default_categories(uuid) from anon, authenticated, public;

select public.ensure_default_categories(id) from auth.users;

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

  perform public.ensure_default_categories(new.id);

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
