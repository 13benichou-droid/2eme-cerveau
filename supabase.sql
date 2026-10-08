-- 2ème cerveau : table de synchronisation (à coller dans Supabase → SQL Editor → Run)
create table if not exists public.docs (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  col text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, col, id)
);
create index if not exists docs_user_updated on public.docs (user_id, updated_at);

alter table public.docs enable row level security;
drop policy if exists "lire mes données" on public.docs;
drop policy if exists "ajouter mes données" on public.docs;
drop policy if exists "modifier mes données" on public.docs;
drop policy if exists "supprimer mes données" on public.docs;
create policy "lire mes données" on public.docs for select to authenticated using ((select auth.uid()) = user_id);
create policy "ajouter mes données" on public.docs for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "modifier mes données" on public.docs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "supprimer mes données" on public.docs for delete to authenticated using ((select auth.uid()) = user_id);

create or replace function public.docs_touch() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs for each row execute function public.docs_touch();

grant select, insert, update, delete on public.docs to authenticated;
