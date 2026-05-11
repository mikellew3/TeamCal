-- MGH Robotic Surgery PA Team Calendar — Schema (v2, PWA + push)
-- Idempotent: safe to re-run when adding new columns / tables.

-- =============================================================
-- TABLES
-- =============================================================

create table if not exists team_members (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid references auth.users(id) on delete set null,
  name          text not null,
  email         text not null unique,
  color         text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists team_members_auth_idx on team_members (auth_user_id);
create index if not exists team_members_email_idx on team_members (lower(email));

create table if not exists calendar_entries (
  id               uuid primary key default gen_random_uuid(),
  member_id        uuid references team_members(id) on delete cascade,
  event_type       text not null
    check (event_type in ('pto', 'cme', 'pd', 'note', 'onb', 'shd', 'per_diem', 'swp', 'cov')),
  title            text,
  start_date       date not null,
  end_date         date not null,
  status           text not null default 'pending'
    check (status in ('pending', 'approved', 'denied')),
  notes            text,
  conference_link  text,
  requested_at     timestamptz not null default now(),
  decided_at       timestamptz,
  decided_by       text,
  constraint title_or_member check (member_id is not null or title is not null),
  constraint valid_date_range check (end_date >= start_date)
);
-- Add conference_link column for projects upgrading from v1.
alter table calendar_entries add column if not exists conference_link text;
-- Add signup_pending column for projects upgrading from v2.
alter table team_members add column if not exists signup_pending boolean not null default false;
-- Add must_change_password column. Set when admin pre-creates an account with
-- a temporary password; cleared after the member sets their own.
alter table team_members add column if not exists must_change_password boolean not null default false;

-- RPC for a signed-in member to clear their own must_change_password flag
-- after updating their password via supabase.auth.updateUser.
create or replace function clear_must_change_password()
returns void
language sql
security definer
set search_path = public
as $$
  update team_members
     set must_change_password = false
   where auth_user_id = auth.uid();
$$;
grant execute on function clear_must_change_password() to authenticated;
create index if not exists calendar_entries_dates_idx  on calendar_entries (start_date, end_date);
create index if not exists calendar_entries_status_idx on calendar_entries (status);
create index if not exists calendar_entries_type_idx   on calendar_entries (event_type);
create index if not exists calendar_entries_member_idx on calendar_entries (member_id);

-- Push subscriptions. One row per device — a member with web + iOS install
-- gets two rows. Admin subscriptions have member_id NULL and is_admin true.
create table if not exists push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid references team_members(id) on delete cascade,
  is_admin      boolean not null default false,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists push_subs_member_idx on push_subscriptions (member_id);
create index if not exists push_subs_admin_idx  on push_subscriptions (is_admin);

-- Audit log of admin actions. Written by every admin endpoint; never read
-- by the app — query directly in SQL Editor when you need it.
create table if not exists admin_actions (
  id            uuid primary key default gen_random_uuid(),
  actor_email   text,
  action        text not null,
  target_type   text,
  target_id     text,
  payload       jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists admin_actions_created_idx on admin_actions (created_at desc);
create index if not exists admin_actions_action_idx  on admin_actions (action);

-- =============================================================
-- HELPER FUNCTIONS
-- =============================================================

create or replace function entry_category(et text) returns text as $$
  select case
    when et in ('pto', 'cme', 'pd')         then 'time_away'
    when et in ('note', 'onb', 'shd')       then 'events'
    when et in ('cov', 'per_diem', 'swp')   then 'coverage_adds'
    else 'unknown'
  end;
$$ language sql immutable;

-- Auto-link a newly-created auth.users row to a pre-existing team_members row
-- by matching email (case-insensitive).
create or replace function link_auth_user_to_team_member() returns trigger as $$
begin
  update team_members
     set auth_user_id = new.id
   where lower(email) = lower(new.email)
     and auth_user_id is null;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function link_auth_user_to_team_member();

create or replace function current_member_id() returns uuid as $$
  select id from team_members where auth_user_id = auth.uid() limit 1;
$$ language sql stable security definer;

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================

alter table team_members        enable row level security;
alter table calendar_entries    enable row level security;
alter table push_subscriptions  enable row level security;

drop policy if exists "auth read team_members" on team_members;
create policy "auth read team_members"
  on team_members for select
  to authenticated
  using (true);

drop policy if exists "auth read calendar_entries" on calendar_entries;
create policy "auth read calendar_entries"
  on calendar_entries for select
  to authenticated
  using (true);

drop policy if exists "auth read own push subs" on push_subscriptions;
create policy "auth read own push subs"
  on push_subscriptions for select
  to authenticated
  using (member_id = current_member_id());

-- NO direct insert/update/delete policies — all writes go through serverless
-- functions using the service-role key, which bypasses RLS entirely.
