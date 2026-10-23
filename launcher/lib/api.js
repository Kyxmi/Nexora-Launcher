'use strict';

// Outils HTTP du launcher : requêtes JSON, envoi d'un fichier avec progression,
// téléchargement avec progression et vérification SHA-256. Node pur, sans dépendance.

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const NETWORK_MESSAGE = 'Impossible de joindre le serveur Nexora. Vérifie ta connexion Internet.';

class ApiError extends Error {
  constructor(message, status = 0, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status; // 0 = serveur injoignable ou erreur locale
    this.details = details; // réponse brute du serveur, pour traduire l'erreur
  }
}

function buildUrl(base, route) {
  let url;
  try {
    url = new URL(String(base).replace(/\/+$/, '') + route);
  } catch {
    throw new ApiError('Adresse du serveur invalide.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError('L’adresse du serveur doit commencer par https://.');
  }
  return url;
}

const transportFor = (url) => (url.protocol === 'https:' ? https : http);

function toApiError(err) {
  if (err instanceof ApiError) return err;
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
    const aborted = new ApiError('Téléchargement annulé.');
    aborted.aborted = true;
    return aborted;
  }
  switch (err?.code) {
    case 'EPERM':
    case 'EBUSY':
      return new ApiError('Fichier verrouillé : ferme l’appli si elle est ouverte, puis réessaie.');
    case 'EACCES':
      return new ApiError('Accès refusé au dossier d’installation.');
    case 'ENOSPC':
      return new ApiError('Plus assez d’espace disque.');
    case 'ENOENT':
      return new ApiError('Fichier introuvable sur ce PC.');
    case 'ETIMEDOUT':
      return new ApiError('Le serveur ne répond pas.');
    case 'ECONNRESET':
    case 'ERR_STREAM_PREMATURE_CLOSE':
      return new ApiError('La connexion a été coupée. Réessaie.');
    default:
      return new ApiError(NETWORK_MESSAGE);
  }
}

function readJson(res) {
  return new Promise((resolve) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve(null);
      }
    });
    res.on('error', () => resolve(null));
  });
}

function messageOf(data) {
  if (!data || typeof data !== 'object') return '';
  return data.msg || data.message || data.error_description || (typeof data.error === 'string' ? data.error : '') || '';
}

async function handleResponse(res) {
  const data = await readJson(res);
  if (res.statusCode >= 200 && res.statusCode < 300) return data;
  throw new ApiError(messageOf(data) || `Erreur du serveur (${res.statusCode}).`, res.statusCode, data);
}

function timeoutError() {
  return Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
}

/* ---------- Requête JSON ---------- */

function request(base, method, route, { token, body, headers = {}, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = buildUrl(base, route);
    } catch (err) {
      return reject(err);
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const allHeaders = { Accept: 'application/json', ...headers };
    if (payload) {
      allHeaders['Content-Type'] = 'application/json';
      allHeaders['Content-Length'] = payload.length;
    }
    if (token) allHeaders.Authorization = `Bearer ${token}`;

    const req = transportFor(url).request(url, { method, headers: allHeaders, timeout }, (res) => {
      handleResponse(res).then(resolve, reject);
    });
    req.on('timeout', () => req.destroy(timeoutError()));
    req.on('error', (err) => reject(toApiError(err)));
    req.end(payload || undefined);
  });
}

/* ---------- Envoi d'un fichier avec progression ---------- */

async function uploadFile(base, route, { method = 'POST', headers = {}, filePath, contentType, onProgress } = {}) {
  const url = buildUrl(base, route);
  const { size } = await fsp.stat(filePath);

  return new Promise((resolve, reject) => {
    let settled = false;
    let responded = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };

    const req = transportFor(url).request(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...headers,
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': size,
      },
    }, (res) => {
      responded = true;
      handleResponse(res)
        .then((data) => settle(resolve, data), (err) => settle(reject, err))
        .finally(() => {
          // Si le serveur a refusé avant la fin de l'envoi, on arrête d'envoyer.
          if (!req.writableFinished) req.destroy();
        });
    });
    req.on('error', (err) => {
      if (!responded) settle(reject, toApiError(err));
    });

    let sent = 0;
    let lastTick = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        sent += chunk.length;
        const now = Date.now();
        if (onProgress && (now - lastTick > 100 || sent === size)) {
          lastTick = now;
          onProgress(sent, size);
        }
        callback(null, chunk);
      },
    });

    pipeline(fs.createReadStream(filePath, { highWaterMark: 256 * 1024 }), meter, req).catch((err) => {
      if (!responded) settle(reject, toApiError(err));
    });
  });
}

/* ---------- Téléchargement vérifié ---------- */

// Hôtes vers lesquels GitHub peut rediriger un téléchargement de release.
const REDIRECT_HOST = /(^|\.)(github\.com|githubusercontent\.com)$/i;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// redirects : nombre de redirections acceptées (GitHub renvoie vers objects.githubusercontent.com).
function download(base, route, { token, headers = {}, dest, expectedSha256, onProgress, signal, timeout = 30000, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = buildUrl(base, route);
    } catch (err) {
      return reject(err);
    }
    const allHeaders = { Accept: '*/*', ...headers };
    if (token) allHeaders.Authorization = `Bearer ${token}`;
    const partial = `${dest}.part`;

    const req = transportFor(url).get(url, { headers: allHeaders, signal, timeout }, async (res) => {
      try {
        if (redirects > 0 && REDIRECT_CODES.has(res.statusCode) && res.headers.location) {
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, url);
          } catch {
            throw new ApiError('Redirection invalide du serveur.');
          }
          if (next.protocol !== 'https:' || !REDIRECT_HOST.test(next.hostname)) {
            throw new ApiError('Le serveur a redirigé le téléchargement vers une adresse non autorisée.');
          }
          // Pas d'en-tête d'autorisation vers l'hôte suivant.
          const result = await download(next.origin, next.pathname + next.search, {
            dest, expectedSha256, onProgress, signal, timeout, redirects: redirects - 1,
          });
          resolve(result);
          return;
        }
        if (res.statusCode !== 200) {
          await handleResponse(res);
          throw new ApiError(`Réponse inattendue du serveur (${res.statusCode}).`, res.statusCode);
        }
        const total = Number(res.headers['content-length']) || 0;
        const hash = crypto.createHash('sha256');
        let received = 0;
        let lastTick = 0;
        const meter = new Transform({
          transform(chunk, _encoding, callback) {
            received += chunk.length;
            hash.update(chunk);
            const now = Date.now();
            if (onProgress && now - lastTick > 120) {
              lastTick = now;
              onProgress(received, total);
            }
            callback(null, chunk);
          },
        });

        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await pipeline(res, meter, fs.createWriteStream(partial));

        if (total && received !== total) throw new ApiError('Téléchargement incomplet. Réessaie.');
        const digest = hash.digest('hex');
        if (expectedSha256 && digest !== expectedSha256) {
          throw new ApiError('Le fichier reçu ne correspond pas à celui publié (empreinte SHA-256 différente). Réessaie.');
        }
        if (onProgress) onProgress(received, total || received);
        await fsp.rename(partial, dest);
        resolve({ size: received, sha256: digest });
      } catch (err) {
        await fsp.rm(partial, { force: true }).catch(() => {});
        reject(signal?.aborted ? toApiError({ name: 'AbortError' }) : toApiError(err));
      }
    });
    req.on('timeout', () => req.destroy(timeoutError()));
    req.on('error', (err) => reject(signal?.aborted ? toApiError({ name: 'AbortError' }) : toApiError(err)));
  });
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

module.exports = { ApiError, NETWORK_MESSAGE, toApiError, request, uploadFile, download, sha256File };
