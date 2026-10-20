-- ============================================================================
--  Nexora-Launcher : base de données et stockage Supabase
--
--  À coller dans Supabase > SQL Editor > New query, puis cliquer sur « Run ».
--  Tu peux le relancer sans risque : il ne supprime ni comptes ni applis,
--  et il met à jour une base installée avec une version précédente.
--
--  Règles :
--   - seuls les membres de l'équipe (table team_members, adresse confirmée)
--     peuvent publier, modifier ou supprimer des applis ;
--   - toutes les applis sont publiées sous le nom « Nexora-Team » ;
--   - une fois connectés, tous les comptes peuvent voir et télécharger les applis ;
--   - chaque compte a sa bibliothèque : les applis qu'il a ajoutées depuis la boutique.
-- ============================================================================


-- 1. La table des applis ------------------------------------------------------

create table if not exists public.apps (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  description text not null default '' check (char_length(description) <= 2000),
  version     text not null check (char_length(btrim(version)) between 1 and 32),
  file_name   text not null check (file_name ~* '^[a-z0-9_. ()-]{1,100}\.exe$'),
  file_path   text not null,
  file_size   bigint not null check (file_size > 0),
  sha256      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  icon_path   text,
  publisher   text not null default 'Nexora-Team',
  package_type text not null default 'app',
  downloads   integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Base installée avec une version précédente : on ajoute la colonne « publisher ».
alter table public.apps add column if not exists publisher text not null default 'Nexora-Team';

-- Type de fichier publié : « app » = un .exe qui se lance directement,
-- « installer » = un installateur qui installe l'appli sur le PC (le launcher lance ensuite l'appli installée).
alter table public.apps add column if not exists package_type text not null default 'app';
alter table public.apps drop constraint if exists apps_package_type_check;
alter table public.apps add constraint apps_package_type_check check (package_type in ('app', 'installer'));

create unique index if not exists apps_name_unique on public.apps (lower(name));

-- Peu importe qui, dans l'équipe, publie ou modifie : l'appli est toujours signée Nexora-Team.
create or replace function public.apps_set_publisher()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.publisher := 'Nexora-Team';
  return new;
end;
$$;

drop trigger if exists apps_set_publisher on public.apps;
create trigger apps_set_publisher
  before insert or update on public.apps
  for each row execute function public.apps_set_publisher();

-- La date « Mise à jour le… » ne bouge que si l'appli change vraiment
-- (pas à chaque téléchargement).
create or replace function public.apps_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.name, new.description, new.version, new.file_path, new.icon_path)
     is distinct from (old.name, old.description, old.version, old.file_path, old.icon_path) then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

drop trigger if exists apps_set_updated_at on public.apps;
create trigger apps_set_updated_at
  before update on public.apps
  for each row execute function public.apps_set_updated_at();


-- 2. L'équipe Nexora-Team : les comptes qui ont le droit de publier ---------------
-- Cette liste n'est lisible ni modifiable depuis le launcher : seulement ici, dans le SQL Editor.

create table if not exists public.team_members (
  email    text primary key check (email = lower(btrim(email)) and position('@' in email) > 1),
  added_at timestamptz not null default now()
);
alter table public.team_members enable row level security;
revoke all on table public.team_members from anon, authenticated;

insert into public.team_members (email) values ('louisdelahodde@gmail.com') on conflict (email) do nothing;

-- Pour ajouter ton pote : il crée d'abord son compte, puis enlève les deux tirets
-- au début de la ligne suivante, mets son adresse (en minuscules) et relance le script.
-- insert into public.team_members (email) values ('adresse-de-ton-pote@exemple.fr') on conflict (email) do nothing;

-- Vrai si le compte connecté fait partie de l'équipe et que son adresse est confirmée.
-- (La fonction garde le nom « is_admin » : le launcher l'utilise sous ce nom.)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    join public.team_members t on t.email = lower(u.email)
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Compteur de téléchargements : n'importe quel compte connecté peut l'augmenter de 1,
-- sans pour autant avoir le droit de modifier l'appli.
create or replace function public.record_download(app_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.apps set downloads = downloads + 1 where id = app_id;
$$;

revoke all on function public.record_download(uuid) from public, anon;
grant execute on function public.record_download(uuid) to authenticated;


-- 3. Les droits sur la table (Row Level Security) ---------------------------------

alter table public.apps enable row level security;

drop policy if exists "Applis : ajout par l'admin" on public.apps;
drop policy if exists "Applis : modification par l'admin" on public.apps;
drop policy if exists "Applis : suppression par l'admin" on public.apps;

drop policy if exists "Applis : lecture pour les comptes connectés" on public.apps;
create policy "Applis : lecture pour les comptes connectés"
  on public.apps for select to authenticated
  using (true);

drop policy if exists "Applis : ajout par l'équipe" on public.apps;
create policy "Applis : ajout par l'équipe"
  on public.apps for insert to authenticated
  with check ((select public.is_admin()));

drop policy if exists "Applis : modification par l'équipe" on public.apps;
create policy "Applis : modification par l'équipe"
  on public.apps for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Applis : suppression par l'équipe" on public.apps;
create policy "Applis : suppression par l'équipe"
  on public.apps for delete to authenticated
  using ((select public.is_admin()));

revoke all on table public.apps from anon;
grant select, insert, update, delete on table public.apps to authenticated;


-- 4. La bibliothèque de chaque compte ---------------------------------------------------
-- Les applis qu'un joueur a ajoutées depuis la boutique. Chacun ne voit et ne modifie que la sienne.

create table if not exists public.library (
  user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  app_id   uuid not null references public.apps (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (user_id, app_id)
);
alter table public.library enable row level security;

drop policy if exists "Bibliothèque : lecture de la sienne" on public.library;
create policy "Bibliothèque : lecture de la sienne"
  on public.library for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Bibliothèque : ajout dans la sienne" on public.library;
create policy "Bibliothèque : ajout dans la sienne"
  on public.library for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "Bibliothèque : retrait de la sienne" on public.library;
create policy "Bibliothèque : retrait de la sienne"
  on public.library for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.library from anon;
grant select, insert, delete on table public.library to authenticated;


-- 5. Le stockage des fichiers ---------------------------------------------------------
--  « apps »  : les .exe, privés (il faut être connecté pour les télécharger)
--  « icons » : les icônes, publiques (ce ne sont que des images)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('apps', 'apps', false, null, null),
  ('icons', 'icons', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Nexora : envoi par l'admin" on storage.objects;
drop policy if exists "Nexora : modification par l'admin" on storage.objects;
drop policy if exists "Nexora : suppression par l'admin" on storage.objects;

drop policy if exists "Nexora : lecture des fichiers" on storage.objects;
create policy "Nexora : lecture des fichiers"
  on storage.objects for select to authenticated
  using (bucket_id in ('apps', 'icons'));

drop policy if exists "Nexora : envoi par l'équipe" on storage.objects;
create policy "Nexora : envoi par l'équipe"
  on storage.objects for insert to authenticated
  with check (bucket_id in ('apps', 'icons') and (select public.is_admin()));

drop policy if exists "Nexora : modification par l'équipe" on storage.objects;
create policy "Nexora : modification par l'équipe"
  on storage.objects for update to authenticated
  using (bucket_id in ('apps', 'icons') and (select public.is_admin()))
  with check (bucket_id in ('apps', 'icons') and (select public.is_admin()));

drop policy if exists "Nexora : suppression par l'équipe" on storage.objects;
create policy "Nexora : suppression par l'équipe"
  on storage.objects for delete to authenticated
  using (bucket_id in ('apps', 'icons') and (select public.is_admin()));


select 'Nexora-Launcher : base prête. Équipe Nexora-Team : ' || string_agg(email, ', ' order by added_at) as resultat
from public.team_members;
