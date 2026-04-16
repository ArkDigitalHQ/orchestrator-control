-- Minimum to power the weekend MVP. Will be migrated into the `orchestrator` schema in Sprint 1.

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  machine_id text not null unique,
  sdk_session_id text,
  project_path text,
  status text not null default 'idle',          -- idle | running | awaiting | errored | stopped
  awaiting text,                                 -- null | 'prompt' | 'permission'
  awaiting_detail jsonb,
  last_message text,
  last_event_at timestamptz default now(),
  created_at timestamptz default now()
);

create table public.commands (
  id uuid primary key default gen_random_uuid(),
  machine_id text not null,
  session_id uuid references public.sessions(id),
  command_type text not null,                    -- prompt | permission_decision | interrupt | close
  payload jsonb not null,
  status text not null default 'pending',        -- pending | delivered | acked | executed | failed | expired
  created_at timestamptz default now(),
  delivered_at timestamptz,
  acked_at timestamptz,
  result jsonb
);

create index on public.sessions (machine_id, status);
create index on public.sessions (awaiting) where awaiting is not null;
create index on public.commands (machine_id, status) where status in ('pending','delivered');

-- Realtime for the dashboard
alter publication supabase_realtime add table public.sessions;
alter publication supabase_realtime add table public.commands;
