-- Vibez teams: several people's agents working on one project together.
--
-- Everyone runs their own agent (Claude Code, Codex, …) on their own machine
-- and subscription. This schema is only the shared picture they coordinate
-- through: who is working on what, which files and pages each agent has
-- claimed, notes the team wants every agent to know, and messages and
-- handoffs between people's agents.
--
-- Claims are advisory. Nothing here can stop a write on someone's machine;
-- it makes a collision visible before it happens, which is what lets agents
-- steer around each other.
--
-- Every table is readable only by members of its workspace (row-level
-- security). People join with a code, as anonymous or signed-in users.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------ workspaces and members

create table public.team_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  join_code text not null unique default encode(gen_random_bytes(6), 'hex'),
  created_by uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table public.team_members (
  workspace_id uuid not null references public.team_workspaces on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  name text not null check (length(name) between 1 and 40),
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create or replace function public.team_is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where workspace_id = ws and user_id = auth.uid())
$$;

-- ------------------------------------------------------------ what people's agents are doing

create table public.team_agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.team_workspaces on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind text not null default 'agent' check (length(kind) <= 40),
  task text not null default '' check (length(task) <= 500),
  branch text check (length(branch) <= 200),
  machine text check (length(machine) <= 100),
  status text not null default 'working' check (status in ('working', 'waiting', 'idle', 'done')),
  started_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index team_agents_workspace on public.team_agents (workspace_id, last_seen desc);

create table public.team_claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.team_workspaces on delete cascade,
  agent_id uuid not null references public.team_agents on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  path text not null check (length(path) between 1 and 500),
  note text not null default '' check (length(note) <= 300),
  created_at timestamptz not null default now(),
  released_at timestamptz
);
create index team_claims_active on public.team_claims (workspace_id) where released_at is null;

create table public.team_memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.team_workspaces on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  agent_id uuid references public.team_agents on delete set null,
  path text check (length(path) <= 500),
  kind text not null default 'note' check (kind in ('decision', 'gotcha', 'convention', 'note')),
  body text not null check (length(body) between 1 and 2000),
  commit_sha text check (length(commit_sha) <= 64),
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
create index team_memories_workspace on public.team_memories (workspace_id) where retired_at is null;

create table public.team_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.team_workspaces on delete cascade,
  from_user uuid not null default auth.uid() references auth.users on delete cascade,
  from_agent uuid references public.team_agents on delete set null,
  -- null means everyone in the workspace
  to_user uuid references auth.users on delete cascade,
  kind text not null default 'message' check (kind in ('message', 'handoff')),
  body text not null check (length(body) between 1 and 4000),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_by uuid[] not null default '{}',
  accepted_by uuid references auth.users on delete set null,
  accepted_at timestamptz
);
create index team_messages_workspace on public.team_messages (workspace_id, created_at desc);

create table public.team_activity (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.team_workspaces on delete cascade,
  user_id uuid references auth.users on delete set null,
  agent_id uuid references public.team_agents on delete set null,
  verb text not null,
  target text not null default '',
  detail text not null default '',
  created_at timestamptz not null default now()
);
create index team_activity_workspace on public.team_activity (workspace_id, created_at desc);

-- ------------------------------------------------------------ who may see and change what

alter table public.team_workspaces enable row level security;
alter table public.team_members enable row level security;
alter table public.team_agents enable row level security;
alter table public.team_claims enable row level security;
alter table public.team_memories enable row level security;
alter table public.team_messages enable row level security;
alter table public.team_activity enable row level security;

create policy "members see their workspace" on public.team_workspaces
  for select using (public.team_is_member(id));

create policy "members see each other" on public.team_members
  for select using (public.team_is_member(workspace_id));
create policy "members rename themselves" on public.team_members
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "members see agents" on public.team_agents
  for select using (public.team_is_member(workspace_id));
create policy "members start their own agents" on public.team_agents
  for insert with check (public.team_is_member(workspace_id) and user_id = auth.uid());
create policy "people update their own agents" on public.team_agents
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "members see claims" on public.team_claims
  for select using (public.team_is_member(workspace_id));
create policy "agents claim for their owner" on public.team_claims
  for insert with check (
    public.team_is_member(workspace_id) and user_id = auth.uid()
    and exists (select 1 from public.team_agents a where a.id = agent_id and a.user_id = auth.uid() and a.workspace_id = team_claims.workspace_id)
  );
create policy "people release their own claims" on public.team_claims
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "members see memories" on public.team_memories
  for select using (public.team_is_member(workspace_id));
create policy "members add memories" on public.team_memories
  for insert with check (public.team_is_member(workspace_id) and user_id = auth.uid());
create policy "members retire memories" on public.team_memories
  for update using (public.team_is_member(workspace_id)) with check (public.team_is_member(workspace_id));

create policy "members see messages meant for them" on public.team_messages
  for select using (public.team_is_member(workspace_id) and (to_user is null or to_user = auth.uid() or from_user = auth.uid()));
create policy "members send messages" on public.team_messages
  for insert with check (
    public.team_is_member(workspace_id) and from_user = auth.uid()
    and (to_user is null or exists (select 1 from public.team_members m where m.workspace_id = team_messages.workspace_id and m.user_id = to_user))
  );

create policy "members see activity" on public.team_activity
  for select using (public.team_is_member(workspace_id));

-- ------------------------------------------------------------ joining, reading, accepting

create or replace function public.team_create_workspace(p_name text, p_member_name text)
returns table (workspace_id uuid, join_code text)
language plpgsql security definer set search_path = public as $$
declare
  ws team_workspaces;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  insert into team_workspaces (name, created_by) values (p_name, auth.uid()) returning * into ws;
  insert into team_members (workspace_id, user_id, name, role) values (ws.id, auth.uid(), p_member_name, 'owner');
  return query select ws.id, ws.join_code;
end $$;

create or replace function public.team_join_workspace(p_code text, p_member_name text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  ws_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select id into ws_id from team_workspaces where join_code = lower(trim(p_code));
  if ws_id is null then raise exception 'No team has that code.'; end if;
  insert into team_members (workspace_id, user_id, name) values (ws_id, auth.uid(), p_member_name)
    on conflict (workspace_id, user_id) do update set name = excluded.name;
  return ws_id;
end $$;

create or replace function public.team_mark_read(p_ids uuid[])
returns void
language sql security definer set search_path = public as $$
  update team_messages
     set read_by = array_append(read_by, auth.uid())
   where id = any (p_ids)
     and not (auth.uid() = any (read_by))
     and public.team_is_member(workspace_id)
     and (to_user is null or to_user = auth.uid());
$$;

-- Taking over a handoff: the files it named are claimed for the new agent,
-- and the payload (task, branch, summary, next steps, notes) comes back.
create or replace function public.team_accept_handoff(p_message uuid, p_agent uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  msg team_messages;
  p text;
begin
  select * into msg from team_messages where id = p_message for update;
  if msg.id is null or not public.team_is_member(msg.workspace_id) then raise exception 'No such handoff.'; end if;
  if msg.kind <> 'handoff' then raise exception 'That message is not a handoff.'; end if;
  if msg.to_user is not null and msg.to_user <> auth.uid() then raise exception 'That handoff is for someone else.'; end if;
  if msg.accepted_at is not null then raise exception 'That handoff was already taken.'; end if;
  if not exists (select 1 from team_agents where id = p_agent and user_id = auth.uid() and workspace_id = msg.workspace_id) then
    raise exception 'That agent is not yours.';
  end if;
  update team_messages set accepted_by = auth.uid(), accepted_at = now() where id = p_message;
  for p in select jsonb_array_elements_text(coalesce(msg.payload -> 'paths', '[]'::jsonb)) loop
    insert into team_claims (workspace_id, agent_id, user_id, path, note)
      values (msg.workspace_id, p_agent, auth.uid(), p, 'taken over from a handoff');
  end loop;
  return msg.payload;
end $$;

grant execute on function public.team_create_workspace(text, text) to authenticated;
grant execute on function public.team_join_workspace(text, text) to authenticated;
grant execute on function public.team_mark_read(uuid[]) to authenticated;
grant execute on function public.team_accept_handoff(uuid, uuid) to authenticated;

-- ------------------------------------------------------------ the activity feed

create or replace function public.team_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'team_agents' then
    if tg_op = 'INSERT' then
      insert into team_activity (workspace_id, user_id, agent_id, verb, target) values (new.workspace_id, new.user_id, new.id, 'started', new.task);
    elsif new.status is distinct from old.status and new.status = 'done' then
      insert into team_activity (workspace_id, user_id, agent_id, verb, target) values (new.workspace_id, new.user_id, new.id, 'finished', new.task);
    elsif new.task is distinct from old.task then
      insert into team_activity (workspace_id, user_id, agent_id, verb, target) values (new.workspace_id, new.user_id, new.id, 'now working on', new.task);
    end if;
  elsif tg_table_name = 'team_claims' then
    if tg_op = 'INSERT' then
      insert into team_activity (workspace_id, user_id, agent_id, verb, target, detail) values (new.workspace_id, new.user_id, new.agent_id, 'claimed', new.path, new.note);
    elsif old.released_at is null and new.released_at is not null then
      insert into team_activity (workspace_id, user_id, agent_id, verb, target) values (new.workspace_id, new.user_id, new.agent_id, 'released', new.path);
    end if;
  elsif tg_table_name = 'team_memories' then
    if tg_op = 'INSERT' then
      insert into team_activity (workspace_id, user_id, agent_id, verb, target, detail) values (new.workspace_id, new.user_id, new.agent_id, 'noted', coalesce(new.path, ''), left(new.body, 200));
    end if;
  elsif tg_table_name = 'team_messages' then
    if tg_op = 'INSERT' then
      insert into team_activity (workspace_id, user_id, agent_id, verb, target, detail)
        values (new.workspace_id, new.from_user, new.from_agent, case when new.kind = 'handoff' then 'handed off' else 'messaged' end,
                coalesce(new.to_user::text, 'everyone'), left(new.body, 200));
    elsif old.accepted_at is null and new.accepted_at is not null then
      insert into team_activity (workspace_id, user_id, verb, target, detail) values (new.workspace_id, new.accepted_by, 'took over', new.from_user::text, left(new.body, 200));
    end if;
  end if;
  return new;
end $$;

create trigger team_agents_log after insert or update on public.team_agents for each row execute function public.team_log();
create trigger team_claims_log after insert or update on public.team_claims for each row execute function public.team_log();
create trigger team_memories_log after insert on public.team_memories for each row execute function public.team_log();
create trigger team_messages_log after insert or update on public.team_messages for each row execute function public.team_log();

-- Live updates for the IDE's Team panel, when it subscribes.
alter publication supabase_realtime add table public.team_agents, public.team_claims, public.team_messages, public.team_activity;
