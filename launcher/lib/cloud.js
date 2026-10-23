'use strict';

// Le lien entre le launcher et Supabase :
//   Auth     → les comptes (inscription, connexion, session gardée chiffrée sur le PC)
//   Database → la table « apps » (la liste des applis)
//   Storage  → le bucket « apps » (les .exe, privés) et « icons » (les icônes, publiques)
// Qui a le droit de publier ? C'est Supabase qui tranche, grâce aux règles de supabase/schema.sql.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient, isAuthRetryableFetchError } = require('@supabase/supabase-js');
const api = require('./api');

const { ApiError, NETWORK_MESSAGE } = api;
const APPS_BUCKET = 'apps';
const ICONS_BUCKET = 'icons';

const ADMIN_ONLY = 'Seuls les membres de Nexora-Team peuvent publier, modifier ou supprimer des applis.';
const SESSION_EXPIRED = 'Ta session a expiré. Reconnecte-toi.';
const SCHEMA_MISSING = 'La base Supabase n’est pas prête : lance le fichier supabase/schema.sql dans le SQL Editor de Supabase.';
const SUPABASE_DOWN = 'Supabase ne répond pas pour le moment. Si le projet est en pause, réactive-le depuis le tableau de bord Supabase.';

/* ---------- Traduction des erreurs Supabase en messages clairs ---------- */

const AUTH_MESSAGES = {
  invalid_credentials: 'E-mail ou mot de passe incorrect.',
  email_not_confirmed: 'Confirme d’abord ton adresse e-mail avec le lien reçu (regarde aussi dans les spams).',
  user_already_exists: 'Un compte existe déjà avec cette adresse e-mail.',
  email_exists: 'Un compte existe déjà avec cette adresse e-mail.',
  weak_password: 'Mot de passe trop faible : choisis-en un plus long (8 caractères minimum).',
  signup_disabled: 'Les inscriptions sont fermées pour le moment.',
  email_provider_disabled: 'Les inscriptions par e-mail sont désactivées sur ce projet Supabase.',
  email_address_invalid: 'Adresse e-mail refusée. Vérifie qu’elle est bien écrite.',
  validation_failed: 'Adresse e-mail ou mot de passe invalide.',
  over_email_send_rate_limit: 'Trop d’e-mails envoyés pour le moment. Réessaie dans une heure.',
  over_request_rate_limit: 'Trop de tentatives. Réessaie dans quelques minutes.',
  email_address_not_authorized: 'Supabase ne peut pas envoyer d’e-mail à cette adresse : l’admin doit configurer un service d’e-mails (SMTP) ou désactiver la confirmation par e-mail.',
  session_not_found: SESSION_EXPIRED,
  session_expired: SESSION_EXPIRED,
  refresh_token_not_found: SESSION_EXPIRED,
  refresh_token_already_used: SESSION_EXPIRED,
  bad_jwt: SESSION_EXPIRED,
  user_banned: 'Ce compte est suspendu.',
};

function authError(err) {
  if (!err) return new ApiError('Une erreur inattendue est survenue.');
  if (err instanceof ApiError) return err;
  if (isAuthRetryableFetchError(err) || err.name === 'AuthRetryableFetchError') {
    return err.status >= 500 ? new ApiError(SUPABASE_DOWN, err.status) : new ApiError(NETWORK_MESSAGE, 0);
  }
  const message = String(err.message || '');
  if (AUTH_MESSAGES[err.code]) return new ApiError(AUTH_MESSAGES[err.code], err.status || 400);
  if (/invalid login credentials/i.test(message)) return new ApiError(AUTH_MESSAGES.invalid_credentials, 400);
  if (/email not confirmed/i.test(message)) return new ApiError(AUTH_MESSAGES.email_not_confirmed, 400);
  if (/already (been )?registered/i.test(message)) return new ApiError(AUTH_MESSAGES.user_already_exists, 422);
  if (/password should/i.test(message)) return new ApiError(AUTH_MESSAGES.weak_password, 422);
  if (err.status >= 500) return new ApiError(SUPABASE_DOWN, err.status);
  return new ApiError(message || 'Erreur de connexion.', err.status || 400);
}

// postgrest-js renvoie status = 0 quand le réseau est coupé.
function dbError(error, status) {
  if (!status) return new ApiError(NETWORK_MESSAGE, 0);
  const code = error?.code || '';
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303') return new ApiError(SESSION_EXPIRED, 401);
  if (code === '42501') return new ApiError(ADMIN_ONLY, 403);
  if (code === '23505') return new ApiError('Une autre appli porte déjà ce nom.', 409);
  if (code === '23514') return new ApiError('La base refuse une des infos de l’appli (nom, version ou fichier).', 400);
  if (code === '23503') return new ApiError('Cette appli n’existe plus ou a été retirée de la boutique.', 409);
  if (['42P01', '42883', 'PGRST202', 'PGRST205'].includes(code)) return new ApiError(SCHEMA_MISSING, 500);
  if (status >= 500) return new ApiError(SUPABASE_DOWN, status);
  return new ApiError(error?.message || `Erreur Supabase (${status}).`, status);
}

function storageError(err, action) {
  const apiErr = api.toApiError(err);
  if (!apiErr.status || apiErr.aborted) return apiErr; // réseau coupé, annulation ou fichier local
  const d = apiErr.details || {};
  const raw = `${d.statusCode || ''} ${d.error || ''} ${d.message || ''} ${apiErr.message}`;
  if (apiErr.status === 413 || /maximum allowed size|payload too large|entity too large/i.test(raw)) {
    return new ApiError('Fichier trop lourd pour ton projet Supabase (50 Mo maximum sur l’offre gratuite).', 413);
  }
  if (/"exp"|jwt|invalid.+token|token.+expired/i.test(raw)) return new ApiError(SESSION_EXPIRED, 401);
  if (/row-level security|unauthorized|\b403\b/i.test(raw)) return new ApiError(ADMIN_ONLY, 403);
  if (/bucket not found/i.test(raw)) return new ApiError(SCHEMA_MISSING, 404);
  if (apiErr.status === 404 || /not.?found/i.test(raw)) {
    return new ApiError(action === 'download'
      ? 'Ce fichier n’est plus sur Supabase. L’admin doit republier l’appli.'
      : SCHEMA_MISSING, 404);
  }
  if (/mime/i.test(raw)) return new ApiError('Format de fichier refusé par Supabase.', 415);
  if (apiErr.status >= 500) return new ApiError(SUPABASE_DOWN, apiErr.status);
  return new ApiError(`Supabase a refusé le fichier : ${apiErr.message}`, apiErr.status);
}

/* ---------- Session gardée sur le disque, chiffrée ---------- */

function createSessionStore(file, { encrypt, decrypt }) {
  let cache = null;
  const load = () => {
    if (cache) return cache;
    try {
      cache = JSON.parse(decrypt(fs.readFileSync(file)));
    } catch {
      cache = {};
    }
    if (!cache || typeof cache !== 'object') cache = {};
    return cache;
  };
  const persist = () => {
    if (Object.keys(cache).length) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, encrypt(JSON.stringify(cache)));
    } else {
      fs.rmSync(file, { force: true });
    }
  };
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(load(), key) ? load()[key] : null),
    setItem: (key, value) => {
      load()[key] = value;
      persist();
    },
    removeItem: (key) => {
      delete load()[key];
      persist();
    },
    clear: () => {
      cache = {};
      persist();
    },
  };
}

/* ---------- Client ---------- */

const encodePath = (objectPath) => String(objectPath).split('/').map(encodeURIComponent).join('/');

function createCloud({ url, key, sessionFile, encrypt, decrypt, onSignedOut }) {
  const baseUrl = String(url).replace(/\/+$/, '');
  const storageUrl = `${baseUrl}/storage/v1`;
  const sessionStore = createSessionStore(sessionFile, { encrypt, decrypt });
  const supabase = createClient(baseUrl, key, {
    auth: {
      storage: sessionStore,
      storageKey: 'nexora-launcher-session',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  let signingOut = false;
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && !signingOut && onSignedOut) setImmediate(onSignedOut);
  });
  supabase.auth.startAutoRefresh().catch(() => {});

  const publicUrl = (bucket, objectPath) => `${storageUrl}/object/public/${bucket}/${encodePath(objectPath)}`;

  function mapRow(row) {
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      publisher: row.publisher || 'Nexora-Team',
      packageType: row.package_type === 'installer' ? 'installer' : 'app',
      version: row.version,
      githubRepo: row.github_repo || null,
      updateUrl: row.update_url || null,
      fileName: row.file_name || null,
      filePath: row.file_path || null,
      fileSize: Number(row.file_size) || 0,
      sha256: row.sha256 || null,
      iconPath: row.icon_path || null,
      iconUrl: row.icon_path ? publicUrl(ICONS_BUCKET, row.icon_path) : null,
      downloads: row.downloads || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function toUser(user, isAdmin) {
    const email = user.email || '';
    const username = String(user.user_metadata?.username || email.split('@')[0] || 'Joueur').slice(0, 40);
    return { id: user.id, email, username, isAdmin: Boolean(isAdmin) };
  }

  async function accessToken() {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw authError(error);
    if (!data.session) throw new ApiError(SESSION_EXPIRED, 401);
    return data.session.access_token;
  }

  async function rpc(name, args) {
    const { data, error, status } = await supabase.rpc(name, args);
    if (error) throw dbError(error, status);
    return data;
  }

  async function isAdmin() {
    const { data, error, status } = await supabase.rpc('is_admin');
    if (error) throw dbError(error, status);
    return data === true;
  }

  async function removeObjects(bucket, paths) {
    const list = paths.filter(Boolean);
    if (!list.length) return;
    const { error } = await supabase.storage.from(bucket).remove(list);
    if (error) console.warn(`[Supabase] fichiers non supprimés dans « ${bucket} » :`, error.message);
  }

  async function uploadObject(bucket, objectPath, filePath, contentType, onProgress) {
    const token = await accessToken();
    try {
      await api.uploadFile(storageUrl, `/object/${bucket}/${encodePath(objectPath)}`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${token}`,
          'x-upsert': 'false',
          'cache-control': 'max-age=3600',
        },
        filePath,
        contentType,
        onProgress,
      });
    } catch (err) {
      throw storageError(err, 'upload');
    }
  }

  async function getApp(id) {
    const { data, error, status } = await supabase.from('apps').select('*').eq('id', id).limit(1);
    if (error) throw dbError(error, status);
    if (!data || !data.length) throw new ApiError('Cette appli n’existe plus ou a été retirée.', 404);
    return mapRow(data[0]);
  }

  return {
    async health() {
      try {
        await api.request(baseUrl, 'GET', '/auth/v1/health', { headers: { apikey: key }, timeout: 8000 });
        return { ok: true };
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          throw new ApiError('Clé Supabase refusée : vérifie la clé dans launcher/config.js.', err.status);
        }
        if (err.status >= 500) throw new ApiError(SUPABASE_DOWN, err.status);
        throw err;
      }
    },

    // Session gardée sur ce PC : renvoie le compte, null si personne n'est connecté.
    async restore() {
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        const translated = authError(error);
        if (translated.status === 0 || translated.status >= 500) throw translated;
        return null;
      }
      if (!data.session) return null;
      // Les infos du compte gardées sur le PC peuvent être périmées (pseudo changé depuis) : on les redemande.
      const fresh = await supabase.auth.getUser().catch(() => null);
      return toUser(fresh?.data?.user || data.session.user, await isAdmin());
    },

    async signIn(email, password) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw authError(error);
      return toUser(data.user, await isAdmin());
    },

    async signUp(username, email, password) {
      const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { username } } });
      if (error) throw authError(error);
      // Quand la confirmation par e-mail est active, Supabase ne dit pas si l'adresse existe déjà :
      // il renvoie un compte sans « identities ».
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        throw new ApiError(AUTH_MESSAGES.user_already_exists, 422);
      }
      if (!data.session) return { needsConfirmation: true };
      return { user: toUser(data.user, await isAdmin()) };
    },

    async signOut() {
      signingOut = true;
      try {
        const { error } = await supabase.auth.signOut({ scope: 'local' });
        if (error) sessionStore.clear(); // hors ligne : on oublie quand même la session sur ce PC
      } catch {
        sessionStore.clear();
      } finally {
        signingOut = false;
      }
    },

    async listApps() {
      const { data, error, status } = await supabase.from('apps').select('*').order('updated_at', { ascending: false });
      if (error) throw dbError(error, status);
      return (data || []).map(mapRow);
    },

    getApp,

    // La bibliothèque du compte connecté : les applis ajoutées depuis la boutique.
    async listLibrary() {
      const { data, error, status } = await supabase.from('library').select('app_id');
      if (error) throw dbError(error, status);
      return (data || []).map((row) => row.app_id);
    },

    async addToLibrary(appId) {
      const { error, status } = await supabase.from('library').insert({ app_id: appId });
      if (error && error.code !== '23505') throw dbError(error, status); // déjà dans la bibliothèque : rien à faire
    },

    async removeFromLibrary(appId) {
      const { error, status } = await supabase.from('library').delete().eq('app_id', appId);
      if (error) throw dbError(error, status);
    },

    // Les amis : tout passe par les fonctions de supabase/schema.sql (partie 6),
    // qui ne renvoient que ce que le compte connecté a le droit de voir.
    async heartbeat(playing) {
      await rpc('heartbeat', { p_playing: playing || null });
    },

    async goOffline() {
      await rpc('go_offline');
    },

    async friends() {
      const rows = await rpc('my_friends');
      return (rows || []).map((row) => ({
        id: row.id,
        username: row.username,
        online: Boolean(row.online),
        playing: row.playing || null,
        lastSeen: row.last_seen || null,
        since: row.since || null,
      }));
    },

    async friendRequests() {
      const rows = await rpc('friend_requests');
      return (rows || []).map((row) => ({ id: row.id, username: row.username, direction: row.direction, createdAt: row.created_at }));
    },

    async searchPlayers(query) {
      const rows = await rpc('search_players', { q: query });
      return (rows || []).map((row) => ({ id: row.id, username: row.username, relation: row.relation }));
    },

    async friendSuggestions() {
      const rows = await rpc('friend_suggestions');
      return (rows || []).map((row) => ({ id: row.id, username: row.username, mutual: row.mutual || 0, relation: 'none' }));
    },

    async sendFriendRequest(userId) {
      return rpc('send_friend_request', { target: userId });
    },

    async respondFriendRequest(userId, accept) {
      await rpc('respond_friend_request', { other: userId, accept: Boolean(accept) });
    },

    async removeFriend(userId) {
      await rpc('remove_friend', { other: userId });
    },

    async downloadApp(app, dest, { signal, onProgress } = {}) {
      // Appli mise à jour depuis GitHub ou depuis un serveur perso : le fichier vient de là (voir lib/sources.js).
      if (app.downloadUrl) {
        const source = new URL(app.downloadUrl);
        // Le fichier doit venir de la source que l'équipe a indiquée pour cette appli, et d'aucune autre.
        const trusted = app.updateUrl
          ? source.origin === new URL(app.updateUrl).origin
          : source.protocol === 'https:' && source.hostname === 'github.com';
        if (!trusted) throw new ApiError('Adresse de téléchargement refusée.');
        await api.download(source.origin, source.pathname + source.search, {
          dest, expectedSha256: app.sha256, signal, onProgress, redirects: app.updateUrl ? 0 : 5, timeout: 30000,
        });
        supabase.rpc('record_download', { app_id: app.id }).then(() => {}, () => {});
        return;
      }
      if (!app.filePath) throw new ApiError('Cette appli n’a pas de fichier à télécharger : l’admin doit la republier.');
      const token = await accessToken();
      try {
        await api.download(storageUrl, `/object/${APPS_BUCKET}/${encodePath(app.filePath)}`, {
          token,
          headers: { apikey: key },
          dest,
          expectedSha256: app.sha256,
          signal,
          onProgress,
        });
      } catch (err) {
        throw storageError(err, 'download');
      }
      supabase.rpc('record_download', { app_id: app.id }).then(() => {}, () => {});
    },

    async downloadIcon(app, dest) {
      if (!app.iconPath) return false;
      await api.download(storageUrl, `/object/public/${ICONS_BUCKET}/${encodePath(app.iconPath)}`, { dest, timeout: 15000 });
      return true;
    },

    // exe : { path, fileName, size, sha256 } — icon : { path, ext, contentType }
    async publish({ appId, name, version, description, packageType, githubRepo, updateUrl, exe, icon, onProgress }) {
      const current = appId ? await getApp(appId) : null;
      const id = current ? current.id : crypto.randomUUID();
      const stamp = Date.now().toString(36);
      const uploaded = [];
      const fields = { name, version, description, package_type: packageType === 'installer' ? 'installer' : 'app', github_repo: githubRepo || null, update_url: updateUrl || null };

      try {
        // Chaque envoi a son propre chemin : on bascule d'un coup sur la nouvelle version,
        // puis on supprime l'ancienne.
        if (exe) {
          const objectPath = `${id}/${stamp}/${exe.fileName}`;
          await uploadObject(APPS_BUCKET, objectPath, exe.path, 'application/vnd.microsoft.portable-executable', onProgress);
          uploaded.push([APPS_BUCKET, objectPath]);
          Object.assign(fields, { file_name: exe.fileName, file_path: objectPath, file_size: exe.size, sha256: exe.sha256 });
        }
        if (icon) {
          const objectPath = `${id}/${stamp}${icon.ext}`;
          await uploadObject(ICONS_BUCKET, objectPath, icon.path, icon.contentType);
          uploaded.push([ICONS_BUCKET, objectPath]);
          fields.icon_path = objectPath;
        }

        const result = current
          ? await supabase.from('apps').update(fields).eq('id', id).select()
          : await supabase.from('apps').insert({ id, ...fields }).select();
        if (result.error) throw dbError(result.error, result.status);
        if (!result.data || !result.data.length) throw new ApiError(ADMIN_ONLY, 403);

        if (current) {
          if (exe && current.filePath && current.filePath !== fields.file_path) await removeObjects(APPS_BUCKET, [current.filePath]);
          if (icon && current.iconPath) await removeObjects(ICONS_BUCKET, [current.iconPath]);
        }
        return mapRow(result.data[0]);
      } catch (err) {
        for (const [bucket, objectPath] of uploaded) await removeObjects(bucket, [objectPath]);
        throw err;
      }
    },

    async deleteApp(id) {
      const current = await getApp(id);
      const { data, error, status } = await supabase.from('apps').delete().eq('id', id).select();
      if (error) throw dbError(error, status);
      if (!data || !data.length) throw new ApiError(ADMIN_ONLY, 403);
      await removeObjects(APPS_BUCKET, [current.filePath]);
      await removeObjects(ICONS_BUCKET, [current.iconPath]);
    },
  };
}

module.exports = { createCloud };
