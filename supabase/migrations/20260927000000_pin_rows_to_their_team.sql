-- An update policy that only checks `user_id = auth.uid()` says who may change
-- a row, but not what they may change it into. Your own row is yours, so you
-- could rewrite its `workspace_id` and move yourself — or one of your agents,
-- or one of your claims — into any team whose id you happen to know.
--
-- The id is not a secret: vibez.team.json is meant to be committed, and it
-- carries the workspace id and the anon key. The join code is deliberately
-- kept out of that file so that having the repository is not enough to join a
-- team. These policies made the join code beside the point.
--
-- Each of these now pins the row to a team you are already in, on both sides
-- of the update, so a row can be changed but never moved.

drop policy if exists "members rename themselves" on public.team_members;
create policy "members rename themselves" on public.team_members
  for update
  using (user_id = auth.uid() and public.team_is_member(workspace_id))
  with check (user_id = auth.uid() and public.team_is_member(workspace_id));

drop policy if exists "people update their own agents" on public.team_agents;
create policy "people update their own agents" on public.team_agents
  for update
  using (user_id = auth.uid() and public.team_is_member(workspace_id))
  with check (user_id = auth.uid() and public.team_is_member(workspace_id));

drop policy if exists "people release their own claims" on public.team_claims;
create policy "people release their own claims" on public.team_claims
  for update
  using (user_id = auth.uid() and public.team_is_member(workspace_id))
  with check (user_id = auth.uid() and public.team_is_member(workspace_id));

-- team_memories was already written this way: the row has to be in one of your
-- teams both before and after, so it cannot be moved out of the team. Left
-- alone, as the shape the three above have been brought to.

-- ------------------------------------------------------------ joining the wrong team

-- Joining checked the code against the team in the project only after the
-- member row had already been written, so a code for another team added you to
-- that team and then told you the code was wrong. Nothing undid it. Since every
-- Vibez user shares one Supabase project by default, a stale or mistyped code
-- usually resolves to a real team belonging to someone else.
--
-- The check belongs here, before the insert, so a wrong code joins nothing.
create or replace function public.team_join_workspace(p_code text, p_member_name text, p_expect uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  ws_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select id into ws_id from team_workspaces where join_code = lower(trim(p_code));
  if ws_id is null then raise exception 'No team has that code.'; end if;
  if p_expect is not null and ws_id <> p_expect then
    raise exception 'That code is for a different team.';
  end if;
  insert into team_members (workspace_id, user_id, name) values (ws_id, auth.uid(), p_member_name)
    on conflict (workspace_id, user_id) do update set name = excluded.name;
  return ws_id;
end $$;

grant execute on function public.team_join_workspace(text, text, uuid) to authenticated;
