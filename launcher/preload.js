'use strict';

// Seules ces fonctions sont visibles par l'interface (window.nexora) : pas d'accès direct à Node.
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result || !result.ok) throw new Error(result?.error || 'Une erreur inattendue est survenue.');
  return result.data;
}

function listen(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('nexora', {
  getConfig: () => call('config:get'),
  checkServer: () => call('server:health'),

  restoreSession: () => call('auth:restore'),
  login: (email, password) => call('auth:login', { email, password }),
  register: (username, email, password) => call('auth:register', { username, email, password }),
  logout: () => call('auth:logout'),

  listApps: () => call('apps:list'),
  addToLibrary: (appId) => call('library:add', appId),
  removeFromLibrary: (appId) => call('library:remove', appId),
  installApp: (appId) => call('apps:install', appId),
  cancelDownload: (appId) => call('apps:cancel', appId),
  uninstallApp: (appId) => call('apps:uninstall', appId),
  launchApp: (appId) => call('apps:launch', appId),
  locateApp: (appId) => call('apps:locate', appId),
  openAppFolder: (appId) => call('apps:openFolder', appId),
  openAppsFolder: () => call('apps:openRoot'),

  friendsOverview: () => call('friends:overview'),
  searchPlayers: (query) => call('friends:search', query),
  friendSuggestions: () => call('friends:suggestions'),
  sendFriendRequest: (userId) => call('friends:request', userId),
  respondFriendRequest: (userId, accept) => call('friends:respond', userId, accept),
  removeFriend: (userId) => call('friends:remove', userId),

  getUpdate: () => call('update:get'),
  checkUpdate: () => call('update:check'),
  installUpdate: () => call('update:install'),

  pickFile: (kind) => call('admin:pickFile', kind),
  publishApp: (data) => call('admin:publish', data),
  deleteApp: (appId) => call('admin:delete', appId),

  onDownloadProgress: (callback) => listen('download:progress', callback),
  onInstallPhase: (callback) => listen('install:phase', callback),
  onUploadProgress: (callback) => listen('upload:progress', callback),
  onAppExited: (callback) => listen('apps:exited', callback),
  onSessionExpired: (callback) => listen('auth:expired', callback),
  onUpdateState: (callback) => listen('update:state', callback),
});
