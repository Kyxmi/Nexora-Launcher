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

-- Dépôt GitHub d'où l'appli se met à jour (« proprio/depot ») : le launcher lit sa dernière release,
-- et le fichier vient alors de GitHub. Sans fichier envoyé sur Supabase, les colonnes file_* restent vides.
alter table public.apps add column if not exists github_repo text;
alter table public.apps drop constraint if exists apps_github_repo_check;
alter table public.apps add constraint apps_github_repo_check check (github_repo is null or github_repo ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$');
alter table public.apps alter column file_name drop not null;
alter table public.apps alter column file_path drop not null;
alter table public.apps alter column file_size drop not null;
alter table public.apps alter column sha256 drop not null;
-- Ou un serveur PocketBase perso (adresse de sa collection app_updates) : même principe que GitHub.
alter table public.apps add column if not exists update_url text;
alter table public.apps drop constraint if exists apps_update_url_check;
alter table public.apps add constraint apps_update_url_check check (update_url is null or (update_url ~ '^https?://[^[:space:]]+$' and char_length(update_url) <= 300));
alter table public.apps drop constraint if exists apps_file_or_github_check;
alter table public.apps add constraint apps_file_or_github_check check (
  github_repo is not null or update_url is not null
  or (file_name is not null and file_path is not null and file_size is not null and sha256 is not null)
);

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


-- 6. Les amis et qui est en ligne ------------------------------------------------------
--  Chaque compte a un profil (son pseudo). On peut chercher un joueur par son pseudo et lui
--  envoyer une demande d'ami. On ne voit qui est en ligne (et à quoi il joue) que chez ses amis.
--  Les tables ne sont pas lisibles directement : tout passe par les fonctions ci-dessous,
--  qui ne renvoient que ce que le compte connecté a le droit de voir.

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text not null check (char_length(btrim(username)) between 1 and 40),
  created_at   timestamptz not null default now(),
  last_seen    timestamptz,
  online_until timestamptz,
  playing      text check (playing is null or char_length(playing) <= 60)
);
alter table public.profiles enable row level security;
revoke all on table public.profiles from anon, authenticated;

-- Le pseudo choisi à l'inscription, sinon le début de l'adresse e-mail (comme dans le launcher).
create or replace function public.username_of(meta jsonb, email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(coalesce(
    nullif(btrim(meta ->> 'username'), ''),
    nullif(split_part(coalesce(email, ''), '@', 1), ''),
    'Joueur'
  ), 40);
$$;

create or replace function public.create_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, public.username_of(new.raw_user_meta_data, new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_profile on auth.users;
create trigger create_profile
  after insert on auth.users
  for each row execute function public.create_profile();

-- Les comptes créés avant cette version reçoivent aussi leur profil.
insert into public.profiles (id, username)
select id, public.username_of(raw_user_meta_data, email) from auth.users
on conflict (id) do nothing;

create table if not exists public.friendships (
  requester    uuid not null references public.profiles (id) on delete cascade,
  addressee    uuid not null references public.profiles (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  primary key (requester, addressee),
  check (requester <> addressee)
);
-- Une seule relation par paire de joueurs, quel que soit celui qui a demandé.
create unique index if not exists friendships_pair_unique
  on public.friendships (least(requester, addressee), greatest(requester, addressee));
create index if not exists friendships_addressee on public.friendships (addressee);
alter table public.friendships enable row level security;
revoke all on table public.friendships from anon, authenticated;

-- Le launcher signale toutes les minutes qu'il est ouvert, et ce que le joueur a lancé.
create or replace function public.heartbeat(p_playing text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.profiles
     set last_seen = now(),
         online_until = now() + interval '2 minutes',
         playing = nullif(left(btrim(coalesce(p_playing, '')), 60), '')
   where id = auth.uid();
$$;

-- Fermeture du launcher ou déconnexion : on passe hors ligne tout de suite.
create or replace function public.go_offline()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.profiles set online_until = now(), playing = null where id = auth.uid();
$$;

-- Ses amis, avec leur statut. C'est le seul endroit où l'on voit qui est en ligne.
create or replace function public.my_friends()
returns table (id uuid, username text, online boolean, playing text, last_seen timestamptz, since timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id,
         p.username,
         coalesce(p.online_until > now(), false),
         case when p.online_until > now() then p.playing end,
         p.last_seen,
         f.responded_at
    from public.friendships f
    join public.profiles p on p.id = case when f.requester = auth.uid() then f.addressee else f.requester end
   where f.status = 'accepted'
     and auth.uid() in (f.requester, f.addressee)
   order by coalesce(p.online_until > now(), false) desc, lower(p.username);
$$;

-- Les demandes en attente : reçues (« incoming ») et envoyées (« outgoing »).
create or replace function public.friend_requests()
returns table (id uuid, username text, direction text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id,
         p.username,
         case when f.addressee = auth.uid() then 'incoming' else 'outgoing' end,
         f.created_at
    from public.friendships f
    join public.profiles p on p.id = case when f.requester = auth.uid() then f.addressee else f.requester end
   where f.status = 'pending'
     and auth.uid() in (f.requester, f.addressee)
   order by f.created_at desc;
$$;

-- Lien entre le compte connecté et un autre joueur : none, friend, incoming ou outgoing.
create or replace function public.relation_with(other uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
             when f.status = 'accepted' then 'friend'
             when f.addressee = auth.uid() then 'incoming'
             else 'outgoing'
           end
      from public.friendships f
     where (f.requester = auth.uid() and f.addressee = other)
        or (f.requester = other and f.addressee = auth.uid())
     limit 1
  ), 'none');
$$;

-- Recherche par pseudo : seulement le pseudo, jamais le statut en ligne ni l'adresse e-mail.
create or replace function public.search_players(q text)
returns table (id uuid, username text, relation text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.username, public.relation_with(p.id)
    from public.profiles p
   where auth.uid() is not null
     and char_length(btrim(coalesce(q, ''))) >= 2
     and p.id <> auth.uid()
     and position(lower(btrim(q)) in lower(p.username)) > 0
   order by position(lower(btrim(q)) in lower(p.username)), char_length(p.username), lower(p.username)
   limit 20;
$$;

-- Suggestions : d'abord les amis de tes amis, puis les derniers inscrits.
create or replace function public.friend_suggestions()
returns table (id uuid, username text, mutual integer)
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select case when requester = auth.uid() then addressee else requester end as id
      from public.friendships
     where auth.uid() in (requester, addressee)
  ),
  my_friends as (
    select case when requester = auth.uid() then addressee else requester end as id
      from public.friendships
     where status = 'accepted' and auth.uid() in (requester, addressee)
  ),
  friends_of_friends as (
    select case when f.requester = mf.id then f.addressee else f.requester end as id, count(*)::int as mutual
      from my_friends mf
      join public.friendships f on f.status = 'accepted' and mf.id in (f.requester, f.addressee)
     group by 1
  )
  select p.id, p.username, coalesce(fof.mutual, 0)
    from public.profiles p
    left join friends_of_friends fof on fof.id = p.id
   where auth.uid() is not null
     and p.id <> auth.uid()
     and p.id not in (select id from mine)
   order by coalesce(fof.mutual, 0) desc, p.created_at desc
   limit 8;
$$;

-- Envoyer une demande. Si l'autre joueur nous en avait déjà envoyé une, on devient amis.
create or replace function public.send_friend_request(target uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  current_relation text;
begin
  if me is null then raise exception 'Connecte-toi pour ajouter des amis.'; end if;
  if target is null or target = me then raise exception 'Tu ne peux pas t’ajouter toi-même.'; end if;
  if not exists (select 1 from public.profiles where id = target) then raise exception 'Ce joueur n’existe plus.'; end if;

  current_relation := public.relation_with(target);
  if current_relation = 'friend' then return 'friend'; end if;
  if current_relation = 'outgoing' then return 'outgoing'; end if;
  if current_relation = 'incoming' then
    update public.friendships set status = 'accepted', responded_at = now()
     where requester = target and addressee = me and status = 'pending';
    return 'friend';
  end if;

  if (select count(*) from public.friendships where requester = me and status = 'pending') >= 50 then
    raise exception 'Tu as déjà 50 demandes en attente. Attends qu’elles soient acceptées.';
  end if;
  insert into public.friendships (requester, addressee) values (me, target);
  return 'outgoing';
end;
$$;

-- Accepter ou refuser une demande reçue.
create or replace function public.respond_friend_request(other uuid, accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if accept then
    update public.friendships set status = 'accepted', responded_at = now()
     where requester = other and addressee = auth.uid() and status = 'pending';
  else
    delete from public.friendships
     where requester = other and addressee = auth.uid() and status = 'pending';
  end if;
  if not found then raise exception 'Cette demande n’existe plus.'; end if;
end;
$$;

-- Retirer un ami, ou annuler une demande envoyée.
create or replace function public.remove_friend(other uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.friendships
   where (requester = auth.uid() and addressee = other)
      or (requester = other and addressee = auth.uid() and status = 'accepted');
$$;

revoke all on function public.username_of(jsonb, text) from public, anon, authenticated;
revoke all on function public.create_profile() from public, anon, authenticated;
revoke all on function public.relation_with(uuid) from public, anon, authenticated;
revoke all on function public.heartbeat(text) from public, anon;
revoke all on function public.go_offline() from public, anon;
revoke all on function public.my_friends() from public, anon;
revoke all on function public.friend_requests() from public, anon;
revoke all on function public.search_players(text) from public, anon;
revoke all on function public.friend_suggestions() from public, anon;
revoke all on function public.send_friend_request(uuid) from public, anon;
revoke all on function public.respond_friend_request(uuid, boolean) from public, anon;
revoke all on function public.remove_friend(uuid) from public, anon;
grant execute on function public.heartbeat(text) to authenticated;
grant execute on function public.go_offline() to authenticated;
grant execute on function public.my_friends() to authenticated;
grant execute on function public.friend_requests() to authenticated;
grant execute on function public.search_players(text) to authenticated;
grant execute on function public.friend_suggestions() to authenticated;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;


select 'Nexora-Launcher : base prête. Équipe Nexora-Team : ' || string_agg(email, ', ' order by added_at) as resultat
from public.team_members;
