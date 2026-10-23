'use strict';

// Réserver les applis au launcher, sans rien changer dans les applis.
//
// Pour chaque appli installée, le vrai « Appli.exe » est renommé « Appli.nxe » et un petit programme
// (build/lock-stub.exe) prend sa place : un double-clic sur « Appli.exe » n'affiche qu'un message
// « Il faut aller dans le Nexora Launcher… ». Le launcher, lui, lance directement « Appli.nxe ».
//
// Ce n'est pas une protection absolue : quelqu'un qui renomme « Appli.nxe » en .exe peut la lancer.
// Si le verrouillage échoue (fichier occupé, accès refusé), l'appli reste lançable normalement.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const REAL_EXT = '.nxe';
const EXE_RE = /\.exe$/i;

let stubFile = null;
let stubInfo = null; // { size, sha256 } du petit programme, pour le reconnaître

function init(file) {
  stubFile = file;
  stubInfo = null;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function stubDetails() {
  if (!stubInfo) {
    const { size } = await fsp.stat(stubFile);
    stubInfo = { size, sha256: await sha256File(stubFile) };
  }
  return stubInfo;
}

// Le vrai programme est rangé à côté, sous un autre nom.
const realPathOf = (exePath) => exePath.replace(EXE_RE, '') + REAL_EXT;

async function isStub(file) {
  try {
    const info = await stubDetails();
    if ((await fsp.stat(file)).size !== info.size) return false;
    return (await sha256File(file)) === info.sha256;
  } catch {
    return false;
  }
}

const exists = (file) => fs.existsSync(file);

// Verrouille l'appli. Renvoie le fichier que le launcher doit lancer, ou null si l'appli est introuvable.
async function lock(exePath) {
  if (!stubFile || !exePath || !EXE_RE.test(exePath)) return exePath || null;
  const real = realPathOf(exePath);

  if (!exists(exePath)) return exists(real) ? real : null;
  if (await isStub(exePath)) return exists(real) ? real : null; // déjà verrouillée

  // « Appli.exe » est le vrai programme (première fois, ou mis à jour depuis) : on le range et on met le message à sa place.
  await fsp.rm(real, { force: true }); // l'ancienne version, s'il y en a une
  await fsp.rename(exePath, real);
  try {
    await fsp.copyFile(stubFile, exePath);
  } catch (err) {
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
