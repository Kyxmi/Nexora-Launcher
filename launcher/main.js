'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  safeStorage,
  Menu,
  session: electronSession,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const config = require('./config');
const api = require('./lib/api');
const Store = require('./lib/store');
const windows = require('./lib/windows');
const { createCloud } = require('./lib/cloud');

const APP_ID_RE = /^[a-z0-9-]{1,64}$/;
const EXE_NAME_RE = /^[\w.\- ()]{1,100}\.exe$/i;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_ICON_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_MB = Number(config.maxUploadMb) || 50;
const BACKGROUND = '#060607';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let mainWindow = null;
let store = null;
let cloud = null;
let configError = null;
let appsDir = '';
const auth = { user: null };
const downloads = new Map(); // appId -> AbortController, pendant le téléchargement
const busy = new Set(); // appIds en cours d'installation ou de désinstallation
const running = new Map(); // appId -> processus lancé
const pickedFiles = new Map(); // chemin choisi dans la fenêtre « Ouvrir » -> 'exe' | 'icon'

/* ---------- Démarrage ---------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    for (const controller of downloads.values()) controller.abort();
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  app.whenReady().then(init);
}

function init() {
  store = new Store(app.getPath('userData'), { lastUser: null, ownedIds: [] });
  appsDir = path.join(app.getPath('userData'), 'apps');
  configError = checkConfig();
  if (!configError) {
    cloud = createCloud({
      url: config.supabaseUrl.trim(),
      key: config.supabaseKey.trim(),
      sessionFile: path.join(app.getPath('userData'), 'session.dat'),
      encrypt: encryptText,
      decrypt: decryptText,
      onSignedOut: expireSession,
    });
  }
  if (app.isPackaged) Menu.setApplicationMenu(null);
  electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  registerIpc();
  createWindow();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    title: 'Nexora-Launcher',
    backgroundColor: BACKGROUND,
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BACKGROUND, symbolColor: '#f6f6f8', height: 40 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

/* ---------- Configuration Supabase ---------- */

function jwtRole(key) {
  try {
    return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')).role || null;
  } catch {
    return null;
  }
}

function checkConfig() {
  const url = String(config.supabaseUrl || '').trim();
  const key = String(config.supabaseKey || '').trim();
  if (!/^https?:\/\/[^/\s]+/i.test(url) || url.includes('TON-PROJET')) {
    return 'Le launcher n’est pas encore relié à Supabase : indique l’adresse de ton projet dans launcher/config.js.';
  }
  if (!key || key.startsWith('COLLE-')) {
    return 'Le launcher n’est pas encore relié à Supabase : colle ta clé « publishable » dans launcher/config.js.';
  }
  if (key.startsWith('sb_secret_') || jwtRole(key) === 'service_role') {
    return 'Danger : launcher/config.js contient la clé SECRÈTE de Supabase. Remplace-la par la clé « publishable ».';
  }
  return null;
}

function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}

function requireCloud() {
  if (!cloud) throw new api.ApiError(configError || 'Supabase n’est pas configuré.');
  return cloud;
}

/* ---------- Outils ---------- */

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

const appDir = (appId) => path.join(appsDir, appId);
const imageMime = (file) => IMAGE_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

function assertAppId(appId) {
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) throw new api.ApiError('Appli inconnue.');
}

function requireAdmin() {
  if (!auth.user?.isAdmin) throw new api.ApiError('Réservé aux membres de Nexora-Team.');
}

function sniffImageMime(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.length > 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function safeExeName(original) {
  let name = path.basename(String(original || ''))
    .replace(/[^\w.\- ()]+/g, '_')
    .replace(/^[.\s]+/, '')
    .slice(0, 96);
  if (!name.toLowerCase().endsWith('.exe')) name = `${name.replace(/\.+$/, '')}.exe`;
  return name === '.exe' ? 'app.exe' : name;
}

// Un vrai exécutable Windows commence toujours par les lettres « MZ ».
async function assertWindowsExe(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buffer, 0, 2, 0);
    if (bytesRead < 2 || buffer.toString('latin1') !== 'MZ') {
      throw new api.ApiError('Ce fichier n’est pas un exécutable Windows valide.');
    }
  } finally {
    await handle.close();
  }
}

function friendlyError(err) {
  if (err instanceof api.ApiError) return err.message;
  const byCode = {
    EPERM: 'Fichier verrouillé : ferme l’appli si elle est ouverte, puis réessaie.',
    EBUSY: 'Fichier verrouillé : ferme l’appli si elle est ouverte, puis réessaie.',
    EACCES: 'Accès refusé à ce fichier.',
    ENOSPC: 'Plus assez d’espace disque.',
    ENOENT: 'Fichier introuvable.',
  };
  if (err && byCode[err.code]) return byCode[err.code];
  console.error(err);
  return 'Une erreur inattendue est survenue.';
}

/* ---------- Session ---------- */

// La session Supabase est chiffrée par Windows (DPAPI) avant d'être écrite sur le disque.
function encryptText(text) {
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(text)
    : Buffer.from(`plain:${text}`, 'utf8');
}

function decryptText(buffer) {
  if (buffer.toString('latin1', 0, 6) === 'plain:') return buffer.toString('utf8', 6);
  return safeStorage.decryptString(buffer);
}

function setUser(user) {
  auth.user = user;
  store.setConfig({ lastUser: user });
  return user;
}

function setOwned(ids) {
  store.setConfig({ ownedIds: [...new Set(ids)].filter((id) => APP_ID_RE.test(id)) });
}

function expireSession() {
  if (!auth.user) return;
  auth.user = null;
  store.setConfig({ lastUser: null, ownedIds: [] });
  send('auth:expired');
}

async function onAuthFailure(err) {
  if (err?.status !== 401 || !cloud) return;
  await cloud.signOut();
  expireSession();
}

/* ---------- Boutique et bibliothèque ---------- */

async function localIcon(appId, local) {
  if (!local.iconFile) return null;
  try {
    const buffer = await fsp.readFile(path.join(appDir(appId), local.iconFile));
    const mime = sniffImageMime(buffer);
    return mime ? `data:${mime};base64,${buffer.toString('base64')}` : null;
  } catch {
    return null;
  }
}

function localState(appId, local) {
  return {
    installed: Boolean(local),
    installedVersion: local ? local.version : null,
    needsLocate: Boolean(local) && local.packageType === 'installer' && !local.launchPath,
    running: running.has(appId),
    downloading: downloads.has(appId),
    busy: busy.has(appId),
  };
}

// remoteApps = la boutique (null hors ligne) ; ownedIds = la bibliothèque du compte.
async function mergeApps(remoteApps, ownedIds) {
  const owned = new Set(ownedIds || []);
  const list = [];
  const seen = new Set();

  for (const remote of remoteApps || []) {
    if (!APP_ID_RE.test(remote.id)) continue;
    seen.add(remote.id);
    const local = store.installed[remote.id];
    list.push({
      id: remote.id,
      name: remote.name,
      description: remote.description,
      publisher: remote.publisher,
      packageType: remote.packageType,
      version: remote.version,
      fileSize: remote.fileSize,
      updatedAt: remote.updatedAt,
      downloads: remote.downloads,
      iconUrl: remote.iconUrl,
      remote: true,
      owned: owned.has(remote.id) || Boolean(local),
      // Une appli installée comme « autonome » alors qu'elle est devenue « installateur » doit être réinstallée :
      // sinon Lancer rouvrirait l'installateur au lieu de l'appli.
      updateAvailable: Boolean(local) && (local.sha256 !== remote.sha256
        || (remote.packageType === 'installer' && (local.packageType || 'app') !== 'installer')),
      ...localState(remote.id, local),
    });
  }

  // Applis installées que la boutique ne liste pas (hors ligne, ou retirées).
  for (const [id, local] of Object.entries(store.installed)) {
    if (seen.has(id) || !APP_ID_RE.test(id)) continue;
    list.push({
      id,
      name: local.name || id,
      description: local.description || '',
      publisher: local.publisher || 'Nexora-Team',
      packageType: local.packageType || 'app',
      version: local.version,
      fileSize: local.fileSize || 0,
      updatedAt: local.installedAt,
      downloads: 0,
      iconUrl: await localIcon(id, local),
      remote: false,
      owned: true,
      updateAvailable: false,
      ...localState(id, local),
    });
  }
  return list;
}

/* ---------- Installer, lancer, désinstaller ---------- */

async function installApp(appId) {
  assertAppId(appId);
  requireCloud();
  if (downloads.has(appId) || busy.has(appId)) throw new api.ApiError('Une installation est déjà en cours pour cette appli.');
  if (running.has(appId)) throw new api.ApiError('Ferme l’appli avant de la mettre à jour.');

  const controller = new AbortController();
  downloads.set(appId, controller);
  busy.add(appId);
  try {
    const meta = await cloud.getApp(appId);
    const fileName = path.basename(String(meta.fileName || ''));
    if (!EXE_NAME_RE.test(fileName)) throw new api.ApiError('Nom de fichier refusé par le launcher.');
    const isInstaller = meta.packageType === 'installer';
    if (isInstaller && !windows.isWindows) throw new api.ApiError('Cette appli s’installe avec un installateur Windows : elle ne peut être installée que sous Windows.');

    // Installer une appli l'ajoute aussi à la bibliothèque du compte.
    await cloud.addToLibrary(appId).then(() => setOwned([...(store.config.ownedIds || []), appId])).catch(() => {});

    const dir = appDir(appId);
    await fsp.mkdir(dir, { recursive: true });
    const downloaded = path.join(dir, fileName);
    await cloud.downloadApp(meta, downloaded, {
      signal: controller.signal,
      onProgress: (received, total) => send('download:progress', { appId, received, total: total || meta.fileSize }),
    });
    downloads.delete(appId); // téléchargement fini : on ne peut plus annuler

    const previous = store.installed[appId];
    let iconFile = null;
    if (meta.iconPath) {
      try {
        await cloud.downloadIcon(meta, path.join(dir, '.icon'));
        iconFile = '.icon';
      } catch {
        // L'icône est facultative.
      }
    } else {
      await fsp.rm(path.join(dir, '.icon'), { force: true }).catch(() => {});
    }
    const record = {
      name: meta.name,
      description: meta.description,
      publisher: meta.publisher,
      version: meta.version,
      fileName,
      fileSize: meta.fileSize,
      sha256: meta.sha256,
      iconFile,
      packageType: isInstaller ? 'installer' : 'app',
      installedAt: new Date().toISOString(),
    };

    if (!isInstaller) {
      if (previous && previous.fileName !== fileName) {
        await fsp.rm(path.join(dir, path.basename(previous.fileName)), { force: true }).catch(() => {});
      }
      store.setInstalled(appId, record);
      return { needsLocate: false };
    }

    // Installateur : on le lance une seule fois, puis on retrouve l'appli qu'il a installée.
    send('install:phase', { appId, phase: 'setup' });
    const before = await windows.listPrograms();
    const run = await windows.runAndWait(downloaded, '');
    if (run.code === windows.CANCELLED) throw new api.ApiError('Installation annulée.');

    let program = null;
    for (let attempt = 0; attempt < 6 && !program; attempt += 1) {
      if (attempt) await sleep(1500); // certains installateurs s'enregistrent juste après s'être fermés
      program = windows.findNewProgram(before, await windows.listPrograms(), meta.name, previous?.programKey);
    }
    if (!program && run.code !== 0) {
      throw new api.ApiError(`L’installation n’a pas abouti (code ${run.code}). Réessaie, ou vérifie que ton antivirus ne bloque pas l’installateur.`);
    }

    let launchPath = program ? await windows.findAppExe(program, meta.name) : null;
    if (!launchPath && previous?.launchPath && fs.existsSync(previous.launchPath)) launchPath = previous.launchPath;
    await fsp.rm(downloaded, { force: true }).catch(() => {}); // l'installateur ne sert plus

    store.setInstalled(appId, {
      ...record,
      programKey: program?.key || previous?.programKey || null,
      uninstallCommand: program?.uninstall || previous?.uninstallCommand || '',
      launchPath: launchPath || null,
    });
    return { needsLocate: !launchPath };
  } catch (err) {
    await onAuthFailure(err);
    throw err;
  } finally {
    downloads.delete(appId);
    busy.delete(appId);
  }
}

async function uninstallApp(appId) {
  assertAppId(appId);
  if (downloads.has(appId) || busy.has(appId)) throw new api.ApiError('Attends la fin de l’opération en cours.');
  if (running.has(appId)) throw new api.ApiError('Ferme l’appli avant de la désinstaller.');
  const local = store.installed[appId];
  if (!local) return true;

  busy.add(appId);
  try {
    // Appli installée par un installateur : on passe par son propre désinstallateur.
    if (local.packageType === 'installer' && local.uninstallCommand && windows.isWindows) {
      const command = windows.parseCommand(local.uninstallCommand);
      if (command) {
        const run = await windows.runAndWait(command.file, command.args);
        if (run.code === windows.CANCELLED) throw new api.ApiError('Désinstallation annulée.');
        if (local.programKey) {
          // Beaucoup de désinstallateurs se relancent depuis un dossier temporaire : on attend qu'ils aient fini.
          let gone = false;
          for (let attempt = 0; attempt < 45 && !gone; attempt += 1) {
            if (attempt) await sleep(2000);
            gone = !(await windows.listPrograms()).some((p) => p.key === local.programKey);
          }
          if (!gone) throw new api.ApiError('La désinstallation n’est pas terminée. Si tu l’as annulée, l’appli est toujours installée.');
        }
      }
    }
    await fsp.rm(appDir(appId), { recursive: true, force: true });
    store.removeInstalled(appId);
    return true;
  } finally {
    busy.delete(appId);
  }
}

async function launchApp(appId) {
  assertAppId(appId);
  const local = store.installed[appId];
  if (!local) throw new api.ApiError('Installe l’appli avant de la lancer.');
  if (downloads.has(appId) || busy.has(appId)) throw new api.ApiError('Attends la fin de l’installation.');
  if (running.has(appId)) throw new api.ApiError('Cette appli est déjà ouverte.');

  let exePath;
  if (local.packageType === 'installer') {
    if (!local.launchPath) throw new api.ApiError('Le launcher ne sait pas encore où est l’appli : clique sur « Localiser l’appli ».');
    exePath = local.launchPath;
    if (!fs.existsSync(exePath)) {
      store.removeInstalled(appId);
      throw new api.ApiError('L’appli n’est plus installée sur ce PC. Réinstalle-la depuis ta bibliothèque.');
    }
  } else {
    exePath = path.join(appDir(appId), path.basename(local.fileName));
    if (!fs.existsSync(exePath)) {
      store.removeInstalled(appId);
      throw new api.ApiError('Le fichier de l’appli a disparu. Réinstalle-la.');
    }
  }

  const child = spawn(exePath, [], { cwd: path.dirname(exePath), detached: true, stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (err) {
    throw new api.ApiError(`Impossible de lancer l’appli (${err.code || 'erreur inconnue'}). Ton antivirus l’a peut-être bloquée.`);
  }

  running.set(appId, child);
  child.on('error', () => {});
  child.once('exit', () => {
    running.delete(appId);
    send('apps:exited', { appId });
  });
  child.unref();
  return true;
}

// Secours : l'utilisateur indique lui-même le .exe de l'appli installée.
async function locateApp(appId) {
  assertAppId(appId);
  const local = store.installed[appId];
  if (!local) throw new api.ApiError('Installe l’appli avant de la localiser.');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `Où se trouve ${local.name} ?`,
    properties: ['openFile'],
    filters: [{ name: 'Application (.exe)', extensions: ['exe'] }],
  });
  if (result.canceled || !result.filePaths.length) return false;
  const file = result.filePaths[0];
  if (path.extname(file).toLowerCase() !== '.exe') throw new api.ApiError('Choisis le fichier .exe de l’appli.');
  store.setInstalled(appId, { ...local, packageType: 'installer', launchPath: file });
  return true;
}

async function openAppFolder(appId) {
  assertAppId(appId);
  const local = store.installed[appId];
  if (local?.packageType === 'installer' && local.launchPath && fs.existsSync(local.launchPath)) {
    shell.showItemInFolder(local.launchPath);
    return true;
  }
  await fsp.mkdir(appDir(appId), { recursive: true });
  const error = await shell.openPath(appDir(appId));
  if (error) throw new api.ApiError(`Impossible d’ouvrir le dossier : ${error}`);
  return true;
}

/* ---------- Publication (équipe) ---------- */

async function pickFile(kind) {
  requireAdmin();
  if (kind !== 'exe' && kind !== 'icon') throw new api.ApiError('Type de fichier inconnu.');
  const isExe = kind === 'exe';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: isExe ? 'Choisir le .exe de l’appli' : 'Choisir une icône',
    properties: ['openFile'],
    filters: isExe
      ? [{ name: 'Application Windows (.exe)', extensions: ['exe'] }]
      : [{ name: 'Image (PNG, JPG, WEBP)', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;

  const file = result.filePaths[0];
  const ext = path.extname(file).toLowerCase();
  if (isExe ? ext !== '.exe' : !IMAGE_TYPES[ext]) {
    throw new api.ApiError(isExe ? 'Choisis un fichier .exe.' : 'Choisis une image PNG, JPG ou WEBP.');
  }
  const { size } = await fsp.stat(file);
  if (!isExe && size > MAX_ICON_BYTES) throw new api.ApiError('Icône trop lourde : 5 Mo maximum.');

  pickedFiles.set(file, kind);
  const info = { path: file, name: path.basename(file), size };
  if (isExe) info.looksLikeInstaller = await windows.looksLikeInstaller(file).catch(() => false);
  else info.preview = `data:${imageMime(file)};base64,${(await fsp.readFile(file)).toString('base64')}`;
  return info;
}

async function publishApp(input = {}) {
  requireAdmin();
  requireCloud();
  const appId = input.appId || null;
  if (appId) assertAppId(appId);
  const exePath = input.exePath || null;
  const iconPath = input.iconPath || null;

  // Le launcher n'envoie que des fichiers choisis dans la fenêtre « Ouvrir ».
  if (exePath && pickedFiles.get(exePath) !== 'exe') throw new api.ApiError('Choisis le .exe avec le bouton prévu.');
  if (iconPath && pickedFiles.get(iconPath) !== 'icon') throw new api.ApiError('Choisis l’icône avec le bouton prévu.');
  if (!appId && !exePath) throw new api.ApiError('Choisis le fichier .exe de ton appli.');

  const name = String(input.name ?? '').trim();
  const version = String(input.version ?? '').trim();
  const description = String(input.description ?? '').replace(/\r\n?/g, '\n').trim();
  const packageType = input.packageType === 'installer' ? 'installer' : 'app';
  if (!name || name.length > 60) throw new api.ApiError('Le nom doit faire entre 1 et 60 caractères.');
  if (!version || version.length > 32) throw new api.ApiError('La version doit faire entre 1 et 32 caractères.');
  if (description.length > 2000) throw new api.ApiError('Description trop longue : 2000 caractères maximum.');

  let exe = null;
  if (exePath) {
    await assertWindowsExe(exePath);
    const { size } = await fsp.stat(exePath);
    if (size > MAX_UPLOAD_MB * 1024 * 1024) {
      throw new api.ApiError(`Ce fichier dépasse la limite de ${MAX_UPLOAD_MB} Mo de ton projet Supabase.`);
    }
    send('upload:progress', { sent: 0, total: 0 }); // « Préparation de l'envoi… » pendant le calcul de l'empreinte
    exe = { path: exePath, fileName: safeExeName(exePath), size, sha256: await api.sha256File(exePath) };
  }
  const icon = iconPath
    ? { path: iconPath, ext: path.extname(iconPath).toLowerCase(), contentType: imageMime(iconPath) }
    : null;

  try {
    return await cloud.publish({
      appId,
      name,
      version,
      description,
      packageType,
      exe,
      icon,
      onProgress: (sent, total) => send('upload:progress', { sent, total }),
    });
  } catch (err) {
    await onAuthFailure(err);
    throw err;
  }
}

/* ---------- Canaux IPC (appelés par preload.js) ---------- */

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const origin = event.senderFrame?.url || '';
    if (!origin.startsWith('file://')) return { ok: false, error: 'Requête refusée.' };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });
}

function registerIpc() {
  handle('config:get', () => ({
    configured: !configError,
    configError,
    serverHost: hostOf(config.supabaseUrl),
    appsDir,
    version: app.getVersion(),
    maxUploadMb: MAX_UPLOAD_MB,
  }));

  handle('server:health', () => requireCloud().health());

  handle('auth:restore', async () => {
    if (!cloud) return null;
    try {
      const user = await cloud.restore();
      if (!user) return null;
      setUser(user);
      return { user, offline: false };
    } catch (err) {
      if (err.status === 401) {
        await cloud.signOut();
        return null;
      }
      const cached = store.config.lastUser;
      if (err.status === 0 && cached) {
        auth.user = cached;
        return { user: cached, offline: true };
      }
      throw err;
    }
  });

  handle('auth:login', async (form = {}) => setUser(await requireCloud().signIn(
    String(form.email ?? '').trim(),
    String(form.password ?? ''),
  )));

  handle('auth:register', async (form = {}) => {
    const result = await requireCloud().signUp(
      String(form.username ?? '').trim(),
      String(form.email ?? '').trim(),
      String(form.password ?? ''),
    );
    if (result.user) setUser(result.user);
    return result;
  });

  handle('auth:logout', async () => {
    if (cloud) await cloud.signOut();
    auth.user = null;
    store.setConfig({ lastUser: null, ownedIds: [] });
    return true;
  });

  handle('apps:list', async () => {
    requireCloud();
    if (!auth.user) throw new api.ApiError('Connecte-toi pour continuer.', 401);
    try {
      const [remote, owned] = await Promise.all([cloud.listApps(), cloud.listLibrary()]);
      setOwned(owned);
      return { offline: false, apps: await mergeApps(remote, owned) };
    } catch (err) {
      if (err.status === 0) return { offline: true, apps: await mergeApps(null, store.config.ownedIds) };
      await onAuthFailure(err);
      throw err;
    }
  });

  handle('library:add', async (appId) => {
    assertAppId(appId);
    requireCloud();
    try {
      await cloud.addToLibrary(appId);
    } catch (err) {
      await onAuthFailure(err);
      throw err;
    }
    setOwned([...(store.config.ownedIds || []), appId]);
    return true;
  });

  handle('library:remove', async (appId) => {
    assertAppId(appId);
    requireCloud();
    if (store.installed[appId]) throw new api.ApiError('Désinstalle d’abord l’appli pour la retirer de ta bibliothèque.');
    try {
      await cloud.removeFromLibrary(appId);
    } catch (err) {
      await onAuthFailure(err);
      throw err;
    }
    setOwned((store.config.ownedIds || []).filter((id) => id !== appId));
    return true;
  });

  handle('apps:install', installApp);
  handle('apps:cancel', (appId) => {
    assertAppId(appId);
    downloads.get(appId)?.abort();
    return true;
  });
  handle('apps:uninstall', uninstallApp);
  handle('apps:launch', launchApp);
  handle('apps:locate', locateApp);
  handle('apps:openFolder', openAppFolder);

  handle('apps:openRoot', async () => {
    await fsp.mkdir(appsDir, { recursive: true });
    const error = await shell.openPath(appsDir);
    if (error) throw new api.ApiError(`Impossible d’ouvrir le dossier : ${error}`);
    return true;
  });

  handle('admin:pickFile', pickFile);
  handle('admin:publish', publishApp);
  handle('admin:delete', async (appId) => {
    requireAdmin();
    requireCloud();
    assertAppId(appId);
    try {
      await cloud.deleteApp(appId);
    } catch (err) {
      await onAuthFailure(err);
      throw err;
    }
    return true;
  });
}
