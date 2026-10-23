'use strict';

// Réserver les applis au launcher, sans rien changer dans les applis.
//
// Pour chaque appli installée, le vrai « Appli.exe » est renommé « Appli.nxe » et un petit programme
// (build/lock-stub.exe) prend sa place : un double-clic sur « Appli.exe » n'affiche qu'un message
// « Il faut aller dans le Nexora Launcher… ». Le launcher, lui, lance directement « Appli.nxe ».
// Le petit programme reprend l'icône de l'appli, pour que l'explorateur et les raccourcis ne changent pas d'aspect.
//
// Ce n'est pas une protection absolue : quelqu'un qui renomme « Appli.nxe » en .exe peut la lancer.
// Si le verrouillage échoue (fichier occupé, accès refusé), l'appli reste lançable normalement.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const REAL_EXT = '.nxe';
const EXE_RE = /\.exe$/i;
const MARKER = Buffer.from('NEXORA-LOCK-STUB-v2', 'utf16le'); // la marque, telle qu'elle est écrite dans le programme compilé
const MAX_STUB_BYTES = 1024 * 1024; // le petit programme pèse ~100 Ko : au-delà, ce n'est pas lui
// Premières versions du petit programme (1.0.5 et 1.0.6), sans marque ni icône de l'appli.
const LEGACY_STUB_SHA256 = ['0a1f3dbf8c7bcad4f9e6dd0ab30d90c1fa180304411db1d0b3d1fea35c4a5425'];
const RT_ICON = 3;
const RT_GROUP_ICON = 14;

let stubFile = null;
let template = null; // le petit programme, lu une fois

function init(file) {
  stubFile = file;
  template = null;
}

async function loadTemplate() {
  if (!template) template = await fsp.readFile(stubFile);
  return template;
}

// Le petit programme habillé de l'icône du vrai .exe. Sans icône lisible, on garde celle du launcher.
async function buildStub(realFile) {
  const base = await loadTemplate();
  try {
    const ResEdit = await require('resedit/cjs').load();
    const source = ResEdit.NtExecutable.from(await fsp.readFile(realFile), { ignoreCert: true });
    const sourceRes = ResEdit.NtExecutableResource.from(source);
    const icons = sourceRes.entries.filter((e) => e.type === RT_ICON || e.type === RT_GROUP_ICON);
    if (!icons.some((e) => e.type === RT_GROUP_ICON)) return base;
    const target = ResEdit.NtExecutable.from(base);
    const targetRes = ResEdit.NtExecutableResource.from(target);
    targetRes.entries = targetRes.entries.filter((e) => e.type !== RT_ICON && e.type !== RT_GROUP_ICON).concat(icons);
    targetRes.outputResource(target);
    const built = Buffer.from(target.generate());
    return built.includes(MARKER) ? built : base; // jamais un programme qu'on ne saurait plus reconnaître
  } catch {
    return base;
  }
}

async function isStub(file) {
  try {
    const { size } = await fsp.stat(file);
    if (size > MAX_STUB_BYTES) return false;
    const bytes = await fsp.readFile(file);
    return bytes.includes(MARKER) || LEGACY_STUB_SHA256.includes(crypto.createHash('sha256').update(bytes).digest('hex'));
  } catch {
    return false;
  }
}

// Le vrai programme est rangé à côté, sous un autre nom.
const realPathOf = (exePath) => exePath.replace(EXE_RE, '') + REAL_EXT;
const exists = (file) => fs.existsSync(file);

async function writeStub(exePath, real) {
  const bytes = await buildStub(real);
  await fsp.rm(exePath, { force: true });
  await fsp.writeFile(exePath, bytes);
}

// Verrouille l'appli. Renvoie le fichier que le launcher doit lancer, ou null si l'appli est introuvable.
async function lock(exePath) {
  if (!stubFile || !exePath || !EXE_RE.test(exePath)) return exePath || null;
  const real = realPathOf(exePath);

  if (!exists(exePath)) return exists(real) ? real : null;

  if (await isStub(exePath)) {
    if (!exists(real)) return null;
    // Petit programme d'une ancienne version (sans marque ni icône de l'appli) : on le refait.
    if (!(await fsp.readFile(exePath)).includes(MARKER)) await writeStub(exePath, real);
    return real;
  }

  // « Appli.exe » est le vrai programme (première fois, ou mis à jour depuis) : on le range et on met le message à sa place.
  await fsp.rm(real, { force: true }); // l'ancienne version, s'il y en a une
  await fsp.rename(exePath, real);
  try {
    await writeStub(exePath, real);
  } catch (err) {
    await fsp.rm(exePath, { force: true }).catch(() => {});
    await fsp.rename(real, exePath).catch(() => {}); // on remet l'appli comme elle était
    throw err;
  }
  return real;
}

// Remet le vrai « Appli.exe » en place (désinstallation, ou verrouillage désactivé).
async function unlock(exePath) {
  if (!exePath || !EXE_RE.test(exePath)) return;
  const real = realPathOf(exePath);
  if (!exists(real)) return;
  if (!exists(exePath)) return fsp.rename(real, exePath);
  if (await isStub(exePath)) {
    await fsp.rm(exePath, { force: true });
    return fsp.rename(real, exePath);
  }
  await fsp.rm(real, { force: true }); // « Appli.exe » est une version plus récente : l'ancienne copie ne sert plus
}

module.exports = { init, lock, unlock, isStub, realPathOf };
