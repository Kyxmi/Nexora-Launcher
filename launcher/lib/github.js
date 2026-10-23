'use strict';

// Lit la dernière release d'un dépôt GitHub public pour les applis qui se mettent à jour depuis GitHub.
// Sans compte ni clé : l'API publique de GitHub, limitée à 60 requêtes par heure et par adresse IP,
// d'où le cache de quelques minutes.

const api = require('./api');

const API_BASE = 'https://api.github.com';
const REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const EXE_NAME_RE = /^[\w.\- ()]{1,100}\.exe$/i;
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // dépôt -> { at, release }

// « https://github.com/proprio/depot/releases » ou « proprio/depot » -> « proprio/depot » (sinon null).
function normalizeRepo(input) {
  let text = String(input ?? '').trim();
  if (!text) return null;
  text = text.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/[?#].*$/, '');
  const [owner, name] = text.split('/');
  const repo = `${owner || ''}/${String(name || '').replace(/\.git$/i, '')}`;
  return REPO_RE.test(repo) ? repo : null;
}

// L'installateur de la release : un .exe, de préférence « setup » ou « install ».
function pickAsset(assets) {
  const exes = (assets || []).filter((a) => a && a.state !== 'open' && EXE_NAME_RE.test(String(a.name || '')) && a.browser_download_url);
  return exes.find((a) => /setup|install/i.test(a.name)) || exes[0] || null;
}

function toRelease(repo, data) {
  const asset = pickAsset(data?.assets);
  if (!asset) return null;
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
  return {
    repo,
    tag: String(data.tag_name || ''),
    version: String(data.tag_name || '').replace(/^v(?=\d)/i, '').slice(0, 32),
    fileName: asset.name,
    fileSize: Number(asset.size) || 0,
    sha256: digest ? digest[1].toLowerCase() : null, // absent sur les très anciennes releases
    downloadUrl: asset.browser_download_url,
    publishedAt: data.published_at || null,
  };
}

// La dernière release publiée (hors brouillons et préversions), ou null si le dépôt n'en a pas
// ou n'est pas joignable. force : ignore le cache.
async function latestRelease(repo, { force = false } = {}) {
  if (!REPO_RE.test(String(repo || ''))) return null;
  const cached = cache.get(repo);
  if (cached && !force && Date.now() - cached.at < CACHE_MS) return cached.release;
  try {
    const data = await api.request(API_BASE, 'GET', `/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Nexora-Launcher', 'X-GitHub-Api-Version': '2022-11-28' },
      timeout: 10000,
    });
    const release = toRelease(repo, data);
    cache.set(repo, { at: Date.now(), release });
    return release;
  } catch (err) {
    if (err.status === 404) {
      cache.set(repo, { at: Date.now(), release: null }); // dépôt sans release
      return null;
    }
    return cached ? cached.release : null; // GitHub injoignable ou limite atteinte : dernière réponse connue
  }
}

// Remplace la version et le fichier d'une appli par ceux de sa dernière release GitHub.
async function withRelease(app, options) {
  if (!app?.githubRepo) return app;
  const release = await latestRelease(app.githubRepo, options);
  if (!release) return app;
  return {
    ...app,
    version: release.version || app.version,
    fileName: release.fileName,
    fileSize: release.fileSize,
    sha256: release.sha256,
    downloadUrl: release.downloadUrl,
    fromGithub: true,
  };
}

module.exports = { normalizeRepo, latestRelease, withRelease };
