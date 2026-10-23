'use strict';

// Lit les mises à jour d'une appli sur un serveur PocketBase personnalisé (collection « app_updates »).
// Chaque enregistrement : version, fichier (le .exe), plateforme (« win »), majforcee (mise à jour forcée),
// notedemiseajour. La liste doit être lisible sans connexion (règle « List » de la collection).

const api = require('./api');

const CACHE_MS = 10 * 60 * 1000;
const PLATFORM = 'win';
const EXE_NAME_RE = /^[\w.\- ()]{1,100}\.exe$/i;
const cache = new Map(); // adresse de la collection -> { at, release }

// « http://hote:8091/_/#/collections?collection=app_updates » (l'adresse de l'interface d'administration)
// ou « http://hote:8091/api/collections/app_updates » -> « http://hote:8091/api/collections/app_updates ».
function normalizeSource(input) {
  const text = String(input ?? '').trim();
  if (!text || text.length > 300) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const fromApi = /^\/api\/collections\/([\w-]{1,64})(?:\/|$)/.exec(url.pathname);
  const fromAdmin = /[?&]collection=([\w-]{1,64})(?:&|$)/.exec(`${url.search}${url.hash.replace(/^#[^?]*/, '')}`);
  const collection = fromApi?.[1] || fromAdmin?.[1];
  return collection ? `${url.origin}/api/collections/${collection}` : null;
}

// 1.10.0 > 1.9.2 : compare les numéros de version un par un.
function compareVersions(a, b) {
  const parts = (v) => String(v).split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] || 0) - (y[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function toRelease(source, record) {
  if (!record || !EXE_NAME_RE.test(String(record.fichier || ''))) return null;
  const url = new URL(source);
  return {
    source,
    tag: String(record.id),
    version: String(record.version || '').slice(0, 32),
    fileName: record.fichier,
    fileSize: 0, // le serveur ne l'indique pas : la taille se lit au téléchargement
    sha256: null, // pas d'empreinte non plus
    downloadUrl: `${url.origin}/api/files/${encodeURIComponent(record.collectionId)}/${encodeURIComponent(record.id)}/${encodeURIComponent(record.fichier)}`,
    forced: record.majforcee === true,
    notes: String(record.notedemiseajour || ''),
  };
}

// La version Windows la plus récente, ou null si le serveur ne répond pas ou n'en a aucune.
async function latestRelease(source, { force = false } = {}) {
  if (!normalizeSource(source)) return null;
  const cached = cache.get(source);
  if (cached && !force && Date.now() - cached.at < CACHE_MS) return cached.release;
  try {
    const url = new URL(source);
    const query = `?perPage=50&sort=-created&filter=${encodeURIComponent(`plateforme='${PLATFORM}'`)}`;
    const data = await api.request(url.origin, 'GET', `${url.pathname}/records${query}`, { timeout: 10000 });
    const records = (data?.items || []).filter((r) => EXE_NAME_RE.test(String(r.fichier || '')) && r.version);
    records.sort((a, b) => compareVersions(b.version, a.version)); // le numéro le plus haut, pas forcément le dernier ajouté
    const release = toRelease(source, records[0]);
    cache.set(source, { at: Date.now(), release });
    return release;
  } catch {
    return cached ? cached.release : null; // serveur injoignable : dernière réponse connue
  }
}

module.exports = { normalizeSource, latestRelease, compareVersions };
