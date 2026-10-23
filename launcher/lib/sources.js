'use strict';

// D'où vient la dernière version d'une appli : un dépôt GitHub (releases) ou un serveur PocketBase perso.
// Une appli sans source se met à jour par le fichier publié sur Supabase.

const github = require('./github');
const pocketbase = require('./pocketbase');

// « proprietaire/depot », l'adresse d'un dépôt GitHub, ou l'adresse d'un serveur PocketBase.
// Renvoie { githubRepo, updateUrl } (un seul des deux rempli), ou null si l'adresse n'est reconnue ni comme l'un ni comme l'autre.
function parseSource(input) {
  const repo = github.normalizeRepo(input);
  if (repo) return { githubRepo: repo, updateUrl: null };
  const url = pocketbase.normalizeSource(input);
  return url ? { githubRepo: null, updateUrl: url } : null;
}

const hasSource = (app) => Boolean(app?.githubRepo || app?.updateUrl);

async function latestRelease(app, options) {
  if (app?.updateUrl) return pocketbase.latestRelease(app.updateUrl, options);
  if (app?.githubRepo) return github.latestRelease(app.githubRepo, options);
  return null;
}

// Remplace la version et le fichier d'une appli par ceux de sa dernière version.
async function withRelease(app, options) {
  if (!hasSource(app)) return app;
  const release = await latestRelease(app, options);
  if (!release) return app;
  return {
    ...app,
    version: release.version || app.version,
    fileName: release.fileName,
    fileSize: release.fileSize || app.fileSize,
    sha256: release.sha256,
    downloadUrl: release.downloadUrl,
    forceUpdate: Boolean(release.forced),
    fromSource: true,
  };
}

module.exports = { parseSource, hasSource, latestRelease, withRelease };
