'use strict';

// Fichiers locaux du launcher, dans %APPDATA%\Nexora-Launcher :
//   config.json     dernier compte connecté (pour le mode hors ligne)
//   installed.json  applis installées (version, empreinte, fichier)
//   session.dat     session Supabase, chiffrée par Windows (gérée par lib/cloud.js)

const fs = require('fs');
const path = require('path');

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dir, defaults = {}) {
    this.configFile = path.join(dir, 'config.json');
    this.installedFile = path.join(dir, 'installed.json');
    this.config = { ...defaults, ...readJson(this.configFile) };
    this.installed = readJson(this.installedFile);
  }

  setConfig(patch) {
    Object.assign(this.config, patch);
    writeJson(this.configFile, this.config);
  }

  setInstalled(appId, info) {
    this.installed[appId] = info;
    writeJson(this.installedFile, this.installed);
  }

  removeInstalled(appId) {
    delete this.installed[appId];
    writeJson(this.installedFile, this.installed);
  }
}

module.exports = Store;
