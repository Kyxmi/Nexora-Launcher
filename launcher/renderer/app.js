'use strict';

/* Interface du Nexora-Launcher : boutique, bibliothèque, publication. Tout passe par window.nexora (preload.js). */

const nx = window.nexora;
const $ = (selector, root = document) => root.querySelector(selector);

/* ---------- Outils ---------- */

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const ICONS = {
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  back: '<path d="m14.5 6-6 6 6 6"/>',
  minus: '<path d="M6 12h12"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
};

function icon(name) {
  const span = document.createElement('span');
  // Seulement nos propres icônes, écrites en dur ci-dessus.
  span.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstChild;
}

const numberFr = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${numberFr.format(value)}\u00a0${units[unit]}`;
}

function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

const percent = (done, total) => (total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0);
const initial = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();
const byData = (attr, id) => document.querySelector(`[data-${attr}="${CSS.escape(id)}"]`);

// Chaque appli a sa nuance de rouge, dérivée de son nom.
function hueFor(text) {
  let hash = 0;
  for (const ch of String(text)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return (hash % 24) - 12;
}

function downloadsLabel(count) {
  if (!count) return 'aucun téléchargement';
  return count === 1 ? '1 téléchargement' : `${count} téléchargements`;
}

async function withBusy(button, label, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await task();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* ---------- État ---------- */

function freshPublish() {
  return {
    editingId: null,
    draft: { name: '', version: '', description: '', githubRepo: '' },
    packageType: 'app',
    exe: null,
    icon: null,
    uploading: false,
    sent: 0,
    total: 0,
    error: '',
  };
}

const state = {
  config: { configured: false, serverHost: '', appsDir: '', version: '', maxUploadMb: 50 },
  user: null,
  offline: false,
  apps: [],
  loaded: false,
  loadError: '',
  page: 'library', // shop | shop-app | library | friends | publish | settings
  selectedId: null,
  shopAppId: null,
  lastStageId: null,
  query: '',
  shopQuery: '',
  progress: new Map(), // appId -> { received, total, phase }
  pending: new Map(), // appId -> texte de l'opération en cours
  lastRefresh: 0,
  refreshing: false,
  refreshQueued: false,
  firstLoad: true,
  publish: freshPublish(),
  friends: freshFriends(),
  update: { state: 'idle', version: null, percent: 0, error: '' },
};

function freshFriends() {
  return {
    list: [],
    requests: [],
    loaded: false,
    error: '',
    tab: 'friends', // friends | requests | add
    filter: '',
    query: '',
    results: null,
    searching: false,
    suggestions: null,
    busy: new Set(), // userIds avec une action en cours
  };
}

const findApp = (id) => state.apps.find((a) => a.id === id);
const libraryApps = () => state.apps.filter((a) => a.owned || a.installed);
const shopApps = () => state.apps.filter((a) => a.remote);

function showView(name) {
  document.body.dataset.view = name;
  for (const view of ['boot', 'auth', 'shell']) $(`#view-${view}`).hidden = view !== name;
}

/* ---------- Notifications et confirmation ---------- */

function toast(message, kind = 'info') {
  const el = h('div', { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  }, kind === 'error' ? 6500 : 3500);
}

function confirmDialog({ title, body, confirm, danger = false }) {
  const dialog = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  const ok = $('#confirm-ok');
  ok.textContent = confirm;
  ok.className = `btn btn--tall ${danger ? 'btn--danger-solid' : 'btn--primary'}`;
  dialog.returnValue = '';
  dialog.showModal();
  $('#confirm-cancel').focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

/* ---------- Connexion / inscription ---------- */

let authMode = 'login';

function showAuth(message = '') {
  state.user = null;
  state.apps = [];
  state.loaded = false;
  state.loadError = '';
  state.page = 'library';
  state.selectedId = null;
  state.shopAppId = null;
  state.lastStageId = null;
  state.firstLoad = true;
  state.publish = freshPublish();
  state.friends = freshFriends();
  state.progress.clear();
  state.pending.clear();
  showView('auth');
  setAuthMode(authMode);
  setAuthError(message);
  refreshServerLine();
  setTimeout(() => $(authMode === 'login' ? '#login-email' : '#register-username').focus(), 30);
}

function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').setAttribute('aria-selected', String(mode === 'login'));
  $('#tab-register').setAttribute('aria-selected', String(mode === 'register'));
  $('#login-form').hidden = mode !== 'login';
  $('#register-form').hidden = mode !== 'register';
  setAuthError('');
}

function setAuthMessage(message, kind = 'error') {
  const el = $('#auth-error');
  el.textContent = message || '';
  el.classList.toggle('is-info', kind === 'info');
  el.setAttribute('role', kind === 'info' ? 'status' : 'alert');
  el.hidden = !message;
}

function setAuthError(message) {
  setAuthMessage(message, 'error');
}

async function refreshServerLine() {
  $('#server-url').textContent = state.config.serverHost || '';
  const dot = $('#server-dot');
  const label = $('#server-state');
  if (!state.config.configured) {
    dot.dataset.state = 'down';
    label.textContent = 'Supabase n’est pas encore configuré';
    return;
  }
  dot.dataset.state = 'pending';
  label.textContent = 'Vérification du serveur…';
  try {
    await nx.checkServer();
    dot.dataset.state = 'ok';
    label.textContent = 'Serveur en ligne';
  } catch (err) {
    dot.dataset.state = 'down';
    label.textContent = 'Serveur injoignable';
    // Clé refusée, projet en pause… : on affiche la vraie raison.
    if (!/Impossible de joindre/.test(err.message) && $('#auth-error').hidden) setAuthError(err.message);
  }
}

async function onLogin(event) {
  event.preventDefault();
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  if (!email || !password) return setAuthError('Indique ton adresse e-mail et ton mot de passe.');
  setAuthError('');
  await withBusy($('#login-submit'), 'Connexion…', async () => {
    try {
      const user = await nx.login(email, password);
      $('#login-password').value = '';
      enterShell(user, false);
    } catch (err) {
      setAuthError(err.message);
    }
  });
}

async function onRegister(event) {
  event.preventDefault();
  const username = $('#register-username').value.trim();
  const email = $('#register-email').value.trim();
  const password = $('#register-password').value;
  if (username.length < 3) return setAuthError('Choisis un pseudo d’au moins 3 caractères.');
  if (!email.includes('@')) return setAuthError('Indique une adresse e-mail valide.');
  if (password.length < 8) return setAuthError('Le mot de passe doit faire au moins 8 caractères.');
  setAuthError('');
  await withBusy($('#register-submit'), 'Création du compte…', async () => {
    try {
      const result = await nx.register(username, email, password);
      $('#register-password').value = '';
      if (result.needsConfirmation) {
        setAuthMode('login');
        $('#login-email').value = email;
        setAuthMessage('Compte créé ! Clique sur le lien reçu par e-mail pour l’activer (regarde aussi dans les spams), puis connecte-toi ici.', 'info');
        return;
      }
      enterShell(result.user, false);
      toast(`Bienvenue, ${result.user.username}`);
    } catch (err) {
      setAuthError(err.message);
    }
  });
}

async function onLogout() {
  if (state.progress.size || state.pending.size) {
    toast('Attends la fin des installations avant de te déconnecter.', 'error');
    return;
  }
  try {
    await nx.logout();
  } catch {
    // On revient à l'écran de connexion dans tous les cas.
  }
  showAuth();
}

/* ---------- Coquille ---------- */

function enterShell(user, offline) {
  state.user = user;
  state.offline = Boolean(offline);
  state.page = 'library';
  state.firstLoad = true;
  showView('shell');
  renderAccount();
  renderAll();
  refreshApps();
  refreshFriends();
}

function renderAccount() {
  const user = state.user;
  $('#account-avatar').textContent = initial(user.username);
  $('#account-name').textContent = user.username;
  $('#account-role').textContent = user.isAdmin ? 'Nexora-Team' : user.email;
}

function setCurrent(el, on) {
  if (on) el.setAttribute('aria-current', 'page');
  else el.removeAttribute('aria-current');
}

function renderNav() {
  setCurrent($('#nav-shop'), state.page === 'shop' || state.page === 'shop-app');
  setCurrent($('#nav-library'), state.page === 'library');
  setCurrent($('#nav-friends'), state.page === 'friends');
  const f = state.friends;
  const incoming = f.requests.filter((r) => r.direction === 'incoming').length;
  const online = f.list.filter((friend) => friend.online).length;
  $('#friends-count').textContent = incoming ? String(incoming) : '';
  $('#friends-online').textContent = online ? `${online} en ligne` : '';
  const publishButton = $('#nav-publish');
  publishButton.hidden = !state.user?.isAdmin;
  setCurrent(publishButton, state.page === 'publish');
  setCurrent($('#nav-settings'), state.page === 'settings');
  $('#library-count').textContent = state.loaded ? String(libraryApps().length) : '';
}

function renderAll() {
  renderSidebar();
  renderMain();
  renderBanner();
}

function navigate(page) {
  state.page = page;
  renderAll();
}

function selectApp(id) {
  state.selectedId = id;
  state.page = 'library';
  renderAll();
}

function openShopApp(id) {
  state.shopAppId = id;
  state.page = 'shop-app';
  renderAll();
}

function rerenderApp(id) {
  renderSidebar();
  const onStage = (state.page === 'library' && state.selectedId === id) || (state.page === 'shop-app' && state.shopAppId === id);
  if (onStage || state.page === 'shop') renderMainSoft();
}

// Ne casse pas la saisie en cours dans la recherche de la boutique.
function renderMainSoft() {
  if (state.page === 'shop' && document.activeElement?.id === 'shop-search') renderShopResults();
  else if (state.page === 'publish') renderPublishedList();
  else if (state.page !== 'settings') renderMain();
}

async function refreshApps({ quiet = false } = {}) {
  if (!state.user) return;
  if (state.refreshing) {
    state.refreshQueued = true; // une actualisation est déjà en route : on en refera une juste après
    return;
  }
  state.refreshing = true;
  state.lastRefresh = Date.now();
  const button = $('#refresh');
  if (!quiet) button.classList.add('is-spinning');
  try {
    const { apps, offline } = await nx.listApps();
    if (!state.user) return;
    state.apps = apps;
    state.offline = offline;
    state.loadError = '';
  } catch (err) {
    state.loadError = err.message;
  } finally {
    state.loaded = true;
    state.refreshing = false;
    button.classList.remove('is-spinning');
  }
  if (!state.user) return;

  const library = libraryApps();
  if (!library.some((a) => a.id === state.selectedId)) state.selectedId = library[0]?.id ?? null;
  if (state.firstLoad) {
    state.firstLoad = false;
    // Bibliothèque vide : on arrive sur la boutique.
    if (!library.length && state.page === 'library' && !state.offline) state.page = 'shop';
  }
  renderSidebar();
  renderBanner();
  renderMainSoft();
  if (state.refreshQueued) {
    state.refreshQueued = false;
    refreshApps({ quiet: true });
  }
}

function renderBanner() {
  const banner = $('#banner');
  if (!state.offline || !state.user) {
    banner.hidden = true;
    banner.replaceChildren();
    return;
  }
  banner.replaceChildren(
    h('span', null, 'Serveur injoignable : tes applis installées restent utilisables.'),
    h('button', { class: 'btn btn--small', type: 'button', onclick: () => refreshApps() }, 'Réessayer'),
  );
  banner.hidden = false;
}

/* ---------- Barre latérale : la bibliothèque ---------- */

function statusOf(app) {
  const progress = state.progress.get(app.id);
  if (progress?.phase === 'setup') return { text: 'Installation en cours', accent: true };
  if (progress || app.downloading) {
    return { text: `Téléchargement ${percent(progress?.received || 0, progress?.total || app.fileSize)}\u202f%`, accent: true };
  }
  if (state.pending.has(app.id)) return { text: state.pending.get(app.id), accent: true };
  if (app.running) return { text: 'En cours d’exécution', accent: true };
  if (app.installed && app.needsLocate) return { text: 'Appli à localiser', accent: true };
  if (app.installed && app.updateAvailable) return { text: 'Mise à jour disponible', accent: true };
  if (app.installed && !app.remote && !state.offline) return { text: 'Retirée de la boutique' };
  if (app.installed) return { text: `Version ${app.installedVersion} installée` };
  return { text: 'Pas installée' };
}

function appIcon(app, className) {
  const monogram = () => h('span', { class: `${className} monogram`, 'aria-hidden': 'true' }, initial(app.name));
  if (!app.iconUrl) return monogram();
  const img = h('img', { class: className, src: app.iconUrl, alt: '', draggable: 'false' });
  img.addEventListener('error', () => img.replaceWith(monogram()), { once: true });
  return img;
}

function renderSidebar() {
  renderNav();
  const list = $('#app-list');
  list.replaceChildren();
  if (!state.loaded) {
    list.append(h('p', { class: 'list-note' }, 'Chargement…'));
    return;
  }
  const query = state.query.trim().toLowerCase();
  const apps = libraryApps().filter((a) => !query || a.name.toLowerCase().includes(query));
  if (!apps.length) {
    list.append(h('p', { class: 'list-note' }, query ? 'Aucune appli ne correspond.' : 'Ta bibliothèque est vide.'));
    return;
  }
  for (const app of apps) {
    const status = statusOf(app);
    const current = state.page === 'library' && app.id === state.selectedId;
    list.append(h('button', {
      class: 'app-row',
      type: 'button',
      'aria-current': current ? 'true' : null,
      onclick: () => selectApp(app.id),
    },
    appIcon(app, 'app-row__icon'),
    h('span', { class: 'app-row__text' },
      h('span', { class: 'app-row__name' }, app.name),
      h('span', { class: `app-row__status${status.accent ? ' is-accent' : ''}`, dataset: { statusFor: app.id } }, status.text))));
  }
}

/* ---------- Contenu principal ---------- */

function renderMain() {
  const main = $('#main');
  let page;
  if (state.page === 'publish' && state.user?.isAdmin) page = publishPage();
  else if (state.page === 'settings') page = settingsPage();
  else if (state.page === 'friends') page = friendsPage();
  else if (state.page === 'shop') page = shopPage();
  else if (state.page === 'shop-app') page = shopAppPage(findApp(state.shopAppId));
  else {
    state.page = 'library';
    page = libraryPage();
  }
  main.replaceChildren(page);
  renderNav();
}

function skyLayer(hue) {
  const sky = h('div', { class: 'sky', 'aria-hidden': 'true' });
  sky.style.setProperty('--hue', `${hue}deg`);
  return sky;
}

function emptyStage(title, text, actions = []) {
  state.lastStageId = null;
  return h('section', { class: 'stage stage--empty' },
    skyLayer(0),
    h('div', { class: 'stage__panel glass' },
      h('h1', { class: 'stage__heading' }, title),
      h('p', { class: 'stage__lead' }, text),
      actions.length ? h('div', { class: 'stage__actions' }, actions) : null));
}

function emptyCard(title, text, actions = []) {
  return h('div', { class: 'empty glass' },
    h('h2', { class: 'empty__title' }, title),
    h('p', { class: 'empty__text' }, text),
    actions.length ? h('div', { class: 'empty__actions' }, actions) : null);
}

const retryButton = () => h('button', { class: 'btn btn--primary btn--tall', type: 'button', onclick: () => refreshApps() }, 'Réessayer');

function metaItems(app, { showInstalled }) {
  const meta = [];
  if (app.publisher) meta.push(`Par ${app.publisher}`);
  if (app.version) meta.push(`Version ${app.version}`);
  if (app.fileSize) meta.push(formatSize(app.fileSize));
  if (app.remote && app.updatedAt) meta.push(`Mise à jour le ${formatDate(app.updatedAt)}`);
  if (showInstalled && app.updateAvailable && app.installedVersion) meta.push(`Version installée : ${app.installedVersion}`);
  return meta;
}

function stageHead(app, meta, withEditLink) {
  return h('div', { class: 'stage__head' },
    appIcon(app, 'stage__icon'),
    h('div', { class: 'stage__titles' },
      h('h1', { class: 'stage__title' }, app.name),
      h('div', { class: 'stage__meta' },
        meta.map((text) => h('span', null, text)),
        withEditLink && state.user?.isAdmin && app.remote && !state.offline
          ? h('button', { class: 'link-btn', type: 'button', onclick: () => editApp(app.id) }, 'Modifier la fiche')
          : null)));
}

// Le bouton « Obtenir » de la boutique, ou le lien vers la bibliothèque si l'appli y est déjà.
function getButton(app, size = 'small') {
  const sizeClass = size === 'big' ? 'btn--play' : size === 'tall' ? 'btn--tall' : 'btn--small';
  if (app.owned) {
    return h('button', {
      class: `btn ${size === 'big' ? 'btn--tall' : sizeClass}`,
      type: 'button',
      onclick: (event) => {
        event.stopPropagation();
        selectApp(app.id);
      },
    }, 'Dans ta bibliothèque');
  }
  return h('button', {
    class: `btn btn--primary ${sizeClass}`,
    type: 'button',
    disabled: state.pending.has(app.id) || state.offline,
    onclick: (event) => {
      event.stopPropagation();
      obtainApp(app.id);
    },
  }, 'Obtenir');
}

/* --- Boutique --- */

function shopPage() {
  const search = h('input', { id: 'shop-search', type: 'search', placeholder: 'Rechercher dans la boutique', 'aria-label': 'Rechercher dans la boutique', spellcheck: 'false' });
  search.value = state.shopQuery;
  search.addEventListener('input', () => {
    state.shopQuery = search.value;
    renderShopResults();
  });
  const results = h('div', { id: 'shop-results' });
  fillShopResults(results);
  return h('section', { class: 'page page--shop' },
    h('header', { class: 'shop-head' },
      h('div', null,
        h('h1', { class: 'page__title' }, 'Boutique'),
        h('p', { class: 'page__intro' }, 'Les applis de Nexora-Team. Ajoute celles qui te plaisent à ta bibliothèque, puis installe-les en un clic.')),
      h('label', { class: 'search search--shop' }, icon('search'), search)),
    results);
}

function renderShopResults() {
  const el = $('#shop-results');
  if (el) fillShopResults(el);
}

function fillShopResults(container) {
  const all = shopApps();
  if (!state.loaded) return container.replaceChildren(h('p', { class: 'muted' }, 'Chargement de la boutique…'));
  if (state.offline) {
    return container.replaceChildren(emptyCard('Boutique indisponible hors ligne', 'Reconnecte-toi à Internet pour voir et obtenir des applis. Tes applis installées restent dans ta bibliothèque.', [retryButton()]));
  }
  if (state.loadError && !all.length) return container.replaceChildren(emptyCard('Impossible d’afficher la boutique', state.loadError, [retryButton()]));
  if (!all.length) {
    return container.replaceChildren(emptyCard(
      'La boutique est vide pour l’instant',
      state.user?.isAdmin ? 'Publie ta première appli : elle apparaîtra ici pour tout le monde.' : 'Les applis de Nexora-Team apparaîtront ici dès leur publication.',
      state.user?.isAdmin ? [h('button', { class: 'btn btn--primary btn--tall', type: 'button', onclick: () => navigate('publish') }, 'Publier une appli')] : [],
    ));
  }
  const query = state.shopQuery.trim().toLowerCase();
  const apps = all.filter((a) => !query || a.name.toLowerCase().includes(query) || (a.description || '').toLowerCase().includes(query));
  container.replaceChildren(
    query ? null : featuredCard(all[0]),
    h('h2', { class: 'section-title' }, query ? `Résultats pour « ${state.shopQuery.trim()} »` : 'Toutes les applis'),
    apps.length ? h('div', { class: 'shop-grid' }, apps.map(shopCard)) : h('p', { class: 'muted' }, 'Aucune appli ne correspond à ta recherche.'),
  );
}

function featuredCard(app) {
  return h('article', {
    class: 'featured glass',
    tabindex: 0,
    'aria-label': `${app.name}, à la une`,
    onclick: () => openShopApp(app.id),
    onkeydown: (event) => {
      if (event.key === 'Enter') openShopApp(app.id);
    },
  },
  skyLayer(hueFor(app.name)),
  appIcon(app, 'featured__icon'),
  h('div', { class: 'featured__text' },
    h('span', { class: 'chip' }, 'À la une'),
    h('h2', { class: 'featured__name' }, app.name),
    h('p', { class: 'featured__meta' }, `Par ${app.publisher || 'Nexora-Team'}, version ${app.version}`),
    app.description ? h('p', { class: 'featured__desc' }, app.description) : null,
    h('div', { class: 'featured__actions' }, getButton(app, 'tall'))));
}

function shopCard(app) {
  return h('article', {
    class: 'shop-card glass',
    tabindex: 0,
    'aria-label': app.name,
    onclick: () => openShopApp(app.id),
    onkeydown: (event) => {
      if (event.key === 'Enter') openShopApp(app.id);
    },
  },
  h('div', { class: 'shop-card__top' },
    appIcon(app, 'shop-card__icon'),
    h('div', { class: 'shop-card__titles' },
      h('h3', { class: 'shop-card__name' }, app.name),
      h('span', { class: 'shop-card__by' }, `Par ${app.publisher || 'Nexora-Team'}`))),
  h('p', { class: 'shop-card__desc' }, app.description || 'Pas encore de description.'),
  h('div', { class: 'shop-card__foot' },
    h('span', { class: 'shop-card__meta' }, `${formatSize(app.fileSize)}`),
    getButton(app, 'small')));
}

function shopAppPage(app) {
  if (!app || !app.remote) {
    state.page = 'shop';
    return shopPage();
  }
  const entering = state.lastStageId !== `shop:${app.id}`;
  state.lastStageId = `shop:${app.id}`;
  return h('section', { class: 'stage stage--shop', 'aria-label': app.name },
    skyLayer(hueFor(app.name)),
    h('button', { class: 'btn btn--small back-btn', type: 'button', onclick: () => navigate('shop') }, icon('back'), 'Boutique'),
    h('div', { class: `stage__panel glass${entering ? ' is-entering' : ''}` },
      stageHead(app, metaItems(app, { showInstalled: false }), false),
      app.description ? h('p', { class: 'stage__desc' }, app.description) : null,
      h('div', { class: 'stage__actions' }, getButton(app, 'big'))));
}

async function obtainApp(id) {
  const app = findApp(id);
  if (!app) return;
  state.pending.set(id, 'Ajout en cours…');
  rerenderApp(id);
  try {
    await nx.addToLibrary(id);
    toast(`${app.name} ajoutée à ta bibliothèque`);
    state.selectedId = id;
    state.page = 'library';
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.pending.delete(id);
    await refreshApps({ quiet: true });
    renderMain();
  }
}

/* --- Bibliothèque --- */

function libraryPage() {
  if (!state.loaded) return emptyStage('Chargement…', 'Récupération de tes applis.');
  if (state.loadError && !state.apps.length) {
    return emptyStage('Impossible d’afficher tes applis', state.loadError, [
      retryButton(),
      h('button', { class: 'btn btn--tall', type: 'button', onclick: () => navigate('settings') }, 'Paramètres'),
    ]);
  }
  const app = findApp(state.selectedId);
  if (!app || !(app.owned || app.installed)) {
    return emptyStage('Ta bibliothèque est vide', 'Ajoute des applis depuis la boutique : elles apparaîtront ici, prêtes à installer.', [
      h('button', { class: 'btn btn--primary btn--tall', type: 'button', onclick: () => navigate('shop') }, 'Ouvrir la boutique'),
    ]);
  }
  return appStage(app);
}

function appStage(app) {
  const entering = state.lastStageId !== `lib:${app.id}`;
  state.lastStageId = `lib:${app.id}`;
  let notice = null;
  if (!app.remote && !state.offline) notice = 'Cette appli n’est plus dans la boutique. Tu peux encore la lancer ou la désinstaller.';
  const pendingLabel = state.pending.get(app.id);
  const canFixLaunch = app.installed && app.packageType === 'installer' && !app.needsLocate && !pendingLabel && !state.progress.has(app.id);

  return h('section', { class: 'stage', 'aria-label': app.name },
    skyLayer(hueFor(app.name)),
    h('div', { class: `stage__panel glass${entering ? ' is-entering' : ''}` },
      stageHead(app, metaItems(app, { showInstalled: true }), true),
      app.description ? h('p', { class: 'stage__desc' }, app.description) : null,
      notice ? h('p', { class: 'stage__notice' }, notice) : null,
      h('div', { class: 'stage__actions' }, stageActions(app)),
      pendingLabel ? h('p', { class: 'stage__status' }, pendingLabel) : null,
      canFixLaunch
        ? h('div', { class: 'stage__hint' },
          h('button', { class: 'link-btn link-btn--muted', type: 'button', onclick: () => locateApp(app.id) }, 'Le bouton Lancer n’ouvre pas la bonne appli ? Indique son .exe'))
        : null));
}

function stageActions(app) {
  const progress = state.progress.get(app.id);
  if (progress?.phase === 'setup') return [setupBlock(app)];
  if (progress || app.downloading) return [progressBlock(app, progress)];

  const busy = state.pending.has(app.id) || app.busy;
  const canDownload = app.remote && !state.offline;
  const actions = [];

  if (!app.installed) {
    actions.push(h('button', { class: 'btn btn--primary btn--play', type: 'button', disabled: busy || !canDownload, onclick: () => installApp(app.id) }, 'Installer'));
    if (app.remote && app.owned && !state.offline) {
      actions.push(h('button', { class: 'btn btn--ghost btn--tall', type: 'button', disabled: busy, onclick: () => removeFromLibrary(app.id) }, icon('minus'), 'Retirer de la bibliothèque'));
    }
    return actions;
  }

  if (app.needsLocate) {
    actions.push(h('button', { class: 'btn btn--primary btn--play', type: 'button', disabled: busy, onclick: () => locateApp(app.id) }, 'Localiser l’appli'));
  } else if (app.updateAvailable && canDownload) {
    actions.push(h('button', { class: 'btn btn--primary btn--play', type: 'button', disabled: busy || app.running, onclick: () => installApp(app.id) }, 'Mettre à jour'));
    actions.push(h('button', { class: 'btn btn--tall', type: 'button', disabled: busy || app.running, onclick: () => launchApp(app.id) }, 'Lancer cette version'));
  } else if (app.running) {
    actions.push(h('button', { class: 'btn btn--primary btn--play is-running', type: 'button', disabled: true }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), 'En cours'));
  } else {
    actions.push(h('button', { class: 'btn btn--primary btn--play', type: 'button', disabled: busy, onclick: () => launchApp(app.id) }, 'Lancer'));
  }
  actions.push(h('button', { class: 'btn btn--ghost btn--tall', type: 'button', disabled: busy, onclick: () => openFolder(app.id) }, icon('folder'), 'Ouvrir le dossier'));
  actions.push(h('button', { class: 'btn btn--ghost btn--tall', type: 'button', disabled: busy || app.running, onclick: () => uninstallApp(app.id) }, icon('trash'), 'Désinstaller'));
  return actions;
}

function progressText(received, total) {
  return `Téléchargement ${percent(received, total)}\u202f%, ${formatSize(received)} sur ${formatSize(total)}`;
}

function progressBlock(app, progress) {
  const received = progress?.received || 0;
  const total = progress?.total || app.fileSize || 0;
  const value = percent(received, total);
  const bar = h('div', { class: 'progress__bar', dataset: { barFor: app.id } });
  bar.style.width = `${value}%`;
  return h('div', { class: 'progress' },
    h('div', { class: 'progress__head' },
      h('span', { dataset: { labelFor: app.id } }, progressText(received, total)),
      h('button', { class: 'btn btn--small', type: 'button', onclick: () => nx.cancelDownload(app.id) }, 'Annuler')),
    h('div', {
      class: 'progress__track',
      role: 'progressbar',
      'aria-label': `Téléchargement de ${app.name}`,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': value,
      dataset: { trackFor: app.id },
    }, bar));
}

function setupBlock(app) {
  return h('div', { class: 'setup', role: 'status' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('div', null,
      h('strong', null, 'Installation en cours'),
      h('span', null, `L’installateur de ${app.name} est ouvert : suis ses étapes, le launcher s’occupe du reste.`)));
}

function onDownloadProgress({ appId, received, total }) {
  const previous = state.progress.get(appId);
  if (previous?.phase === 'setup') return;
  state.progress.set(appId, { received, total, phase: 'download' });
  const value = percent(received, total);
  const bar = byData('bar-for', appId);
  if (bar) bar.style.width = `${value}%`;
  byData('track-for', appId)?.setAttribute('aria-valuenow', String(value));
  const label = byData('label-for', appId);
  if (label) label.textContent = progressText(received, total);
  const status = byData('status-for', appId);
  if (status) {
    status.textContent = `Téléchargement ${value}\u202f%`;
    status.classList.add('is-accent');
  }
}

// Une appli suivie sur GitHub se met à jour toute seule : le launcher l'installe quand elle n'est pas ouverte.
function onAppAutoUpdate({ appId, name, phase, version, error }) {
  if (!state.user) return;
  if (phase === 'start') {
    toast(`Mise à jour automatique de ${name}…`);
    return;
  }
  state.progress.delete(appId);
  if (phase === 'done') toast(`${name} est à jour${version ? `, version ${version}` : ''}`);
  else toast(`Mise à jour de ${name} impossible : ${error}`, 'error');
  refreshApps({ quiet: true });
}

function onInstallPhase({ appId, phase }) {
  state.progress.set(appId, { ...(state.progress.get(appId) || {}), phase });
  rerenderApp(appId);
}

/* --- Actions --- */

async function installApp(id) {
  const app = findApp(id);
  if (!app) return;
  const wasUpdate = app.installed;
  state.progress.set(id, { received: 0, total: app.fileSize, phase: 'download' });
  rerenderApp(id);
  try {
    const result = await nx.installApp(id);
    if (result?.needsLocate) toast(`${app.name} est installée. Clique sur « Localiser l’appli » pour indiquer son .exe.`);
    else toast(wasUpdate ? `${app.name} est à jour` : `${app.name} installée`);
  } catch (err) {
    toast(err.message, /annulé/i.test(err.message) ? 'info' : 'error');
  } finally {
    state.progress.delete(id);
    await refreshApps({ quiet: true });
  }
}

async function launchApp(id) {
  const app = findApp(id);
  if (!app) return;
  state.pending.set(id, 'Lancement…');
  rerenderApp(id);
  try {
    await nx.launchApp(id);
    app.running = true;
    toast(`${app.name} lancée`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.pending.delete(id);
    rerenderApp(id);
  }
}

async function uninstallApp(id) {
  const app = findApp(id);
  if (!app) return;
  const viaInstaller = app.packageType === 'installer';
  const ok = await confirmDialog({
    title: `Désinstaller ${app.name} ?`,
    body: viaInstaller
      ? 'Le programme de désinstallation de l’appli va s’ouvrir. Elle reste dans ta bibliothèque : tu pourras la réinstaller.'
      : 'L’appli sera supprimée de ce PC. Elle reste dans ta bibliothèque : tu pourras la réinstaller.',
    confirm: 'Désinstaller',
    danger: true,
  });
  if (!ok) return;
  state.pending.set(id, 'Désinstallation en cours…');
  rerenderApp(id);
  try {
    await nx.uninstallApp(id);
    toast(`${app.name} désinstallée`);
  } catch (err) {
    toast(err.message, /annulé/i.test(err.message) ? 'info' : 'error');
  } finally {
    state.pending.delete(id);
    await refreshApps({ quiet: true });
  }
}

async function removeFromLibrary(id) {
  const app = findApp(id);
  if (!app) return;
  state.pending.set(id, 'Retrait en cours…');
  rerenderApp(id);
  try {
    await nx.removeFromLibrary(id);
    toast(`${app.name} retirée de ta bibliothèque`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.pending.delete(id);
    await refreshApps({ quiet: true });
  }
}

async function locateApp(id) {
  try {
    const done = await nx.locateApp(id);
    if (done) {
      toast('C’est noté : Lancer ouvrira désormais ce .exe.');
      await refreshApps({ quiet: true });
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openFolder(id) {
  try {
    await nx.openAppFolder(id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function onAppExited({ appId }) {
  const app = findApp(appId);
  if (!app) return;
  app.running = false;
  rerenderApp(appId);
}

/* ---------- Publier une appli (équipe) ---------- */

let fieldCount = 0;

function field(label, control, hint) {
  if (!control.id) control.id = `champ-${++fieldCount}`;
  return h('div', { class: 'field' },
    h('label', { for: control.id }, label),
    control,
    hint ? h('span', { class: 'field__hint' }, hint) : null);
}

function editApp(id) {
  const app = findApp(id);
  if (!app) return;
  state.publish = {
    ...freshPublish(),
    editingId: id,
    packageType: app.packageType || 'app',
    draft: { name: app.name, version: app.version, description: app.description || '', githubRepo: app.githubRepo || '' },
  };
  navigate('publish');
}

function cancelEdit() {
  state.publish = freshPublish();
  renderMain();
}

function submitLabel() {
  return state.publish.editingId ? 'Mettre à jour l’appli' : 'Publier l’appli';
}

function publishPage() {
  const p = state.publish;
  const editing = p.editingId ? findApp(p.editingId) : null;
  if (p.editingId && !editing) state.publish = freshPublish();
  const draft = state.publish.draft;

  const nameInput = h('input', { class: 'input', id: 'pub-name', maxlength: 60, autocomplete: 'off', spellcheck: 'false' });
  nameInput.value = draft.name;
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; });

  const versionInput = h('input', { class: 'input', id: 'pub-version', maxlength: 32, autocomplete: 'off', spellcheck: 'false', placeholder: '1.0.0' });
  versionInput.value = draft.version;
  versionInput.addEventListener('input', () => { draft.version = versionInput.value; });

  const descriptionInput = h('textarea', { class: 'input', id: 'pub-description', maxlength: 2000, rows: 4, placeholder: 'Ce que fait l’appli, en une ou deux phrases.' });
  descriptionInput.value = draft.description;
  descriptionInput.addEventListener('input', () => { draft.description = descriptionInput.value; });

  const githubInput = h('input', { class: 'input', id: 'pub-github', maxlength: 200, autocomplete: 'off', spellcheck: 'false', placeholder: 'proprietaire/depot' });
  githubInput.value = draft.githubRepo || '';
  githubInput.addEventListener('input', () => { draft.githubRepo = githubInput.value; });

  const form = h('form', { class: 'publish-form glass', id: 'publish-form', novalidate: true, onsubmit: onPublishSubmit },
    field('Nom de l’appli', nameInput),
    field('Version', versionInput, editing ? `Version actuelle : ${editing.version}` : 'Laisse vide pour reprendre la version de la release GitHub.'),
    field('Description', descriptionInput),
    field('Dépôt GitHub (facultatif)', githubInput, 'Le launcher met l’appli à jour tout seul dès qu’une nouvelle release y est publiée. Exemple : proprietaire/depot, ou colle l’adresse du dépôt.'),
    fileField('exe'),
    typeChoice(),
    fileField('icon'),
    h('p', { class: 'form-error', id: 'pub-error', role: 'alert', hidden: !state.publish.error }, state.publish.error),
    uploadBlock(),
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn btn--primary btn--tall', type: 'submit', id: 'pub-submit' }, submitLabel()),
      editing ? h('button', { class: 'btn btn--tall', type: 'button', onclick: cancelEdit }, 'Annuler la modification') : null));

  if (state.publish.uploading) applyPublishBusy(form, true);

  return h('section', { class: 'page' },
    h('h1', { class: 'page__title' }, editing ? `Modifier ${editing.name}` : 'Publier une appli'),
    h('p', { class: 'page__intro' }, editing
      ? 'Envoie un nouveau .exe pour proposer une mise à jour, ou change seulement le texte et l’icône.'
      : 'L’appli est publiée sous le nom Nexora-Team et apparaît dans la boutique de tout le monde.'),
    h('div', { class: 'publish' },
      form,
      h('div', { class: 'published glass' },
        h('h2', { class: 'section-title' }, 'Tes applis publiées'),
        h('div', { id: 'published-list' }, publishedList()))));
}

function typeChoice() {
  const p = state.publish;
  const option = (value, title, text) => h('button', {
    class: 'choice__item',
    type: 'button',
    role: 'radio',
    'aria-checked': String(p.packageType === value),
    disabled: p.uploading,
    onclick: () => {
      p.packageType = value;
      renderTypeChoice();
    },
  }, h('span', { class: 'choice__title' }, title), h('span', { class: 'choice__text' }, text));
  return h('div', { class: 'field', id: 'type-field' },
    h('span', { class: 'field__label', id: 'type-label' }, 'Type de fichier'),
    h('div', { class: 'choice', role: 'radiogroup', 'aria-labelledby': 'type-label' },
      option('app', 'Appli autonome', 'Un .exe qui se lance directement.'),
      option('installer', 'Installateur', 'Un setup qui installe l’appli. Le launcher lance ensuite l’appli installée.')));
}

function renderTypeChoice() {
  const el = $('#type-field');
  if (el) el.replaceWith(typeChoice());
}

function fileField(kind) {
  const wrap = h('div', { class: 'field', id: `file-${kind}` });
  fillFileField(wrap, kind);
  return wrap;
}

function fillFileField(wrap, kind) {
  const p = state.publish;
  const file = p[kind];
  const editing = p.editingId ? findApp(p.editingId) : null;
  const isExe = kind === 'exe';
  const label = isExe ? (editing ? 'Nouveau fichier .exe (facultatif)' : 'Fichier .exe (inutile avec un dépôt GitHub)') : 'Icône (facultative)';
  const buttonLabel = isExe
    ? (file ? 'Changer de fichier' : 'Choisir le .exe')
    : (file || editing?.iconUrl ? 'Changer d’image' : 'Choisir une image');
  let description;
  if (file) description = `${file.name}, ${formatSize(file.size)}`;
  else if (isExe) description = editing ? `Actuel : ${formatSize(editing.fileSize)}` : `Aucun fichier choisi (${state.config.maxUploadMb} Mo maximum)`;
  else description = 'PNG, JPG ou WEBP, carrée de préférence';

  let preview = null;
  if (!isExe) {
    const src = file?.preview || editing?.iconUrl;
    preview = src
      ? h('img', { class: 'file-pick__preview', src, alt: '' })
      : h('span', { class: 'file-pick__preview file-pick__preview--empty', 'aria-hidden': 'true' });
  }

  wrap.replaceChildren(
    h('span', { class: 'field__label' }, label),
    h('div', { class: 'file-pick' },
      preview,
      h('button', { class: 'btn', type: 'button', disabled: p.uploading, onclick: () => pickFile(kind) }, buttonLabel),
      h('span', { class: `file-pick__name${file ? ' is-set' : ''}` }, description),
      file && !p.uploading
        ? h('button', { class: 'link-btn', type: 'button', onclick: () => { p[kind] = null; fillFileField(wrap, kind); } }, 'Retirer')
        : null));
}

async function pickFile(kind) {
  try {
    const file = await nx.pickFile(kind);
    if (!file) return;
    state.publish[kind] = file;
    const wrap = $(`#file-${kind}`);
    if (wrap) fillFileField(wrap, kind);
    if (kind === 'exe' && typeof file.looksLikeInstaller === 'boolean') {
      state.publish.packageType = file.looksLikeInstaller ? 'installer' : 'app'; // détecté d'après le fichier, modifiable
      renderTypeChoice();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

function uploadText(sent, total) {
  return total ? `Envoi ${percent(sent, total)}\u202f%, ${formatSize(sent)} sur ${formatSize(total)}` : 'Préparation de l’envoi…';
}

function uploadBlock() {
  const p = state.publish;
  const bar = h('div', { class: 'progress__bar', id: 'pub-progress-bar' });
  bar.style.width = `${percent(p.sent, p.total)}%`;
  return h('div', { class: 'upload progress', id: 'pub-progress', hidden: !p.uploading },
    h('div', { class: 'progress__head' }, h('span', { id: 'pub-progress-label' }, uploadText(p.sent, p.total))),
    h('div', { class: 'progress__track', role: 'progressbar', 'aria-label': 'Envoi du fichier' }, bar));
}

function onUploadProgress({ sent, total }) {
  const p = state.publish;
  p.sent = sent;
  p.total = total;
  const bar = $('#pub-progress-bar');
  if (bar) bar.style.width = `${percent(sent, total)}%`;
  const label = $('#pub-progress-label');
  if (label) label.textContent = uploadText(sent, total);
}

function applyPublishBusy(form, busy) {
  for (const el of form.querySelectorAll('input, textarea, button')) el.disabled = busy;
  const progress = form.querySelector('#pub-progress');
  if (progress) progress.hidden = !busy;
  const submit = form.querySelector('#pub-submit');
  if (submit) submit.textContent = busy ? 'Envoi en cours…' : submitLabel();
}

function showPublishError(message) {
  state.publish.error = message;
  const el = $('#pub-error');
  if (el) {
    el.textContent = message;
    el.hidden = !message;
  }
}

async function onPublishSubmit(event) {
  event.preventDefault();
  const p = state.publish;
  if (p.uploading) return;
  const name = $('#pub-name').value.trim();
  const version = $('#pub-version').value.trim();
  const description = $('#pub-description').value.trim();
  const githubRepo = $('#pub-github').value.trim();

  if (!name) return showPublishError('Donne un nom à ton appli.');
  if (!version && !githubRepo) return showPublishError('Indique la version, par exemple 1.0.0.');
  if (!p.editingId && !p.exe && !githubRepo) return showPublishError('Choisis le fichier .exe de ton appli, ou indique son dépôt GitHub.');
  const maxMb = state.config.maxUploadMb;
  if (p.exe && maxMb && p.exe.size > maxMb * 1024 * 1024) {
    return showPublishError(`Ce fichier dépasse la limite de ${maxMb} Mo de ton projet Supabase.`);
  }

  showPublishError('');
  p.uploading = true;
  p.sent = 0;
  p.total = 0;
  applyPublishBusy($('#publish-form'), true);
  onUploadProgress({ sent: 0, total: 0 });

  try {
    await nx.publishApp({
      appId: p.editingId,
      name,
      version,
      description,
      packageType: p.packageType,
      githubRepo,
      exePath: p.exe?.path,
      iconPath: p.icon?.path,
    });
    toast(p.editingId ? `${name} mise à jour` : `${name} publiée`);
    state.publish = freshPublish();
    await refreshApps({ quiet: true });
    if (state.page === 'publish') renderMain();
  } catch (err) {
    p.uploading = false;
    const currentForm = $('#publish-form');
    if (currentForm) applyPublishBusy(currentForm, false);
    showPublishError(err.message);
    for (const kind of ['exe', 'icon']) {
      const wrap = $(`#file-${kind}`);
      if (wrap) fillFileField(wrap, kind);
    }
    renderTypeChoice();
  }
}

function publishedList() {
  const apps = shopApps();
  if (!apps.length) return h('p', { class: 'muted' }, 'Rien de publié pour l’instant.');
  return h('ul', { class: 'pub-list' }, apps.map((app) => h('li', { class: 'pub-item' },
    appIcon(app, 'pub-item__icon'),
    h('div', { class: 'pub-item__text' },
      h('span', { class: 'pub-item__name' }, app.name),
      h('span', { class: 'pub-item__meta' }, `Version ${app.version}, ${app.packageType === 'installer' ? 'installateur' : 'appli autonome'}, ${downloadsLabel(app.downloads)}${app.githubRepo ? ', suit GitHub' : ''}`),
      h('span', { class: 'pub-item__actions' },
        h('button', { class: 'link-btn', type: 'button', onclick: () => editApp(app.id) }, 'Modifier'),
        h('button', { class: 'link-btn link-btn--danger', type: 'button', onclick: () => deleteApp(app.id) }, 'Supprimer'))))));
}

function renderPublishedList() {
  const el = $('#published-list');
  if (el) el.replaceChildren(publishedList());
}

async function deleteApp(id) {
  const app = findApp(id);
  if (!app) return;
  const ok = await confirmDialog({
    title: `Supprimer ${app.name} ?`,
    body: 'Elle disparaît de la boutique et des bibliothèques. Les copies déjà installées restent sur les PC.',
    confirm: 'Supprimer l’appli',
    danger: true,
  });
  if (!ok) return;
  try {
    await nx.deleteApp(id);
    toast(`${app.name} supprimée de la boutique`);
    if (state.publish.editingId === id) state.publish = freshPublish();
    await refreshApps({ quiet: true });
    if (state.page === 'publish') renderMain();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Amis ---------- */

function timeAgo(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 2) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? 'hier' : `il y a ${days} jours`;
  return `le ${formatDate(iso)}`;
}

function friendStatus(friend) {
  if (friend.online && friend.playing) return { text: `Joue à ${friend.playing}`, online: true };
  if (friend.online) return { text: 'En ligne', online: true };
  return { text: friend.lastSeen ? `Hors ligne, vu ${timeAgo(friend.lastSeen)}` : 'Hors ligne', online: false };
}

async function refreshFriends() {
  if (!state.user || state.offline) return;
  const f = state.friends;
  f.lastLoad = Date.now();
  try {
    const { friends, requests } = await nx.friendsOverview();
    if (!state.user || f !== state.friends) return;
    f.list = friends;
    f.requests = requests;
    f.error = '';
  } catch (err) {
    f.error = err.message;
  }
  f.loaded = true;
  renderNav();
  renderFriendsBody();
}

// Ne redessine que les listes : la recherche en cours n'est pas interrompue.
function renderFriendsBody() {
  if (state.page !== 'friends') return;
  const tabs = $('#friends-tabs');
  if (tabs) tabs.replaceWith(friendsTabs());
  const f = state.friends;
  if (f.tab === 'add' && $('#player-search')) {
    $('#search-results')?.replaceChildren(searchResults() || '');
    $('#suggestions')?.replaceChildren(suggestionsList());
    return;
  }
  if (f.tab === 'friends' && $('#friends-lists')) {
    $('#friends-lists').replaceChildren(...friendsLists());
    return;
  }
  $('#friends-body')?.replaceChildren(friendsBody());
}

function setFriendsTab(tab) {
  state.friends.tab = tab;
  $('#friends-body')?.replaceChildren(friendsBody());
  $('#friends-tabs')?.replaceWith(friendsTabs());
  if (tab === 'add') {
    loadSuggestions();
    setTimeout(() => $('#player-search')?.focus(), 30);
  }
}

function friendsTabs() {
  const f = state.friends;
  const incoming = f.requests.filter((r) => r.direction === 'incoming').length;
  const tab = (id, label, count) => h('button', {
    class: 'tab',
    type: 'button',
    role: 'tab',
    'aria-selected': String(f.tab === id),
    onclick: () => setFriendsTab(id),
  }, label, count ? h('span', { class: 'tab__count' }, String(count)) : null);
  return h('div', { class: 'tabs friends-tabs', id: 'friends-tabs', role: 'tablist', 'aria-label': 'Amis' },
    tab('friends', 'Mes amis', f.list.length),
    tab('requests', 'Demandes', incoming),
    tab('add', 'Ajouter des amis'));
}

function friendsPage() {
  if (state.offline) {
    return h('section', { class: 'page' },
      h('h1', { class: 'page__title' }, 'Amis'),
      emptyCard('Amis indisponibles hors ligne', 'Reconnecte-toi à Internet pour voir tes amis et leurs demandes.', [retryButton()]));
  }
  if (state.friends.tab === 'add' && !state.friends.suggestions) loadSuggestions();
  return h('section', { class: 'page page--friends' },
    h('h1', { class: 'page__title' }, 'Amis'),
    h('p', { class: 'page__intro' }, 'Ajoute tes potes pour voir quand ils sont en ligne et à quoi ils jouent. Seuls tes amis voient ton statut.'),
    friendsTabs(),
    h('div', { id: 'friends-body' }, friendsBody()));
}

function friendsBody() {
  const f = state.friends;
  if (f.tab === 'add') return addTab();
  if (!f.loaded) return h('p', { class: 'muted' }, 'Chargement de tes amis…');
  if (f.error && !f.list.length && !f.requests.length) {
    return emptyCard('Impossible d’afficher tes amis', f.error, [h('button', { class: 'btn btn--primary btn--tall', type: 'button', onclick: () => refreshFriends() }, 'Réessayer')]);
  }
  if (f.tab === 'requests') return requestsTab();
  return friendsTab();
}

function personRow(person, { status, online, statusClass = '', actions = [] }) {
  return h('li', { class: 'person' },
    h('span', { class: 'person__avatar' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(person.username)),
      online === undefined ? null : h('span', { class: `presence${online ? ' is-online' : ''}`, 'aria-hidden': 'true' })),
    h('span', { class: 'person__text' },
      h('span', { class: 'person__name' }, person.username),
      status ? h('span', { class: `person__status ${statusClass}` }, status) : null),
    h('span', { class: 'person__actions' }, actions));
}

function friendsTab() {
  const f = state.friends;
  if (!f.list.length) {
    return emptyCard('Pas encore d’amis', 'Cherche tes potes par leur pseudo, ou pioche dans les suggestions.', [
      h('button', { class: 'btn btn--primary btn--tall', type: 'button', onclick: () => setFriendsTab('add') }, 'Ajouter des amis'),
    ]);
  }
  const filterInput = h('input', { id: 'friends-filter', type: 'search', placeholder: 'Chercher parmi tes amis', 'aria-label': 'Chercher parmi tes amis', spellcheck: 'false' });
  filterInput.value = f.filter;
  filterInput.addEventListener('input', () => {
    f.filter = filterInput.value;
    $('#friends-lists').replaceChildren(...friendsLists());
  });
  return h('div', { class: 'friends' },
    h('label', { class: 'search search--page' }, icon('search'), filterInput),
    h('div', { id: 'friends-lists' }, friendsLists()));
}

function friendsLists() {
  const f = state.friends;
  const query = f.filter.trim().toLowerCase();
  const list = f.list.filter((friend) => !query || friend.username.toLowerCase().includes(query));
  if (!list.length) return [h('p', { class: 'muted' }, 'Aucun ami ne correspond.')];
  const row = (friend) => {
    const status = friendStatus(friend);
    return personRow(friend, {
      status: status.text,
      online: status.online,
      statusClass: status.online ? 'is-online' : '',
      actions: [h('button', { class: 'link-btn link-btn--muted', type: 'button', disabled: f.busy.has(friend.id), onclick: () => removeFriend(friend) }, 'Retirer')],
    });
  };
  const online = list.filter((friend) => friend.online);
  const offline = list.filter((friend) => !friend.online);
  return [
    online.length ? h('h2', { class: 'section-title section-title--small' }, `En ligne, ${online.length}`) : null,
    online.length ? h('ul', { class: 'people glass' }, online.map(row)) : null,
    offline.length ? h('h2', { class: 'section-title section-title--small' }, `Hors ligne, ${offline.length}`) : null,
    offline.length ? h('ul', { class: 'people glass' }, offline.map(row)) : null,
  ].filter(Boolean);
}

function requestsTab() {
  const f = state.friends;
  const incoming = f.requests.filter((r) => r.direction === 'incoming');
  const outgoing = f.requests.filter((r) => r.direction === 'outgoing');
  if (!incoming.length && !outgoing.length) {
    return emptyCard('Aucune demande en attente', 'Les demandes d’ami que tu reçois et celles que tu envoies apparaissent ici.', [
      h('button', { class: 'btn btn--primary btn--tall', type: 'button', onclick: () => setFriendsTab('add') }, 'Ajouter des amis'),
    ]);
  }
  const busy = (r) => f.busy.has(r.id);
  return h('div', { class: 'friends' },
    incoming.length ? h('h2', { class: 'section-title section-title--small' }, `Reçues, ${incoming.length}`) : null,
    incoming.length ? h('ul', { class: 'people glass' }, incoming.map((r) => personRow(r, {
      status: `Demande reçue ${timeAgo(r.createdAt)}`,
      actions: [
        h('button', { class: 'btn btn--primary btn--small', type: 'button', disabled: busy(r), onclick: () => respondRequest(r, true) }, 'Accepter'),
        h('button', { class: 'btn btn--small', type: 'button', disabled: busy(r), onclick: () => respondRequest(r, false) }, 'Refuser'),
      ],
    }))) : null,
    outgoing.length ? h('h2', { class: 'section-title section-title--small' }, `Envoyées, ${outgoing.length}`) : null,
    outgoing.length ? h('ul', { class: 'people glass' }, outgoing.map((r) => personRow(r, {
      status: `Envoyée ${timeAgo(r.createdAt)}, en attente`,
      actions: [h('button', { class: 'btn btn--small', type: 'button', disabled: busy(r), onclick: () => cancelRequest(r) }, 'Annuler')],
    }))) : null);
}

// Le bouton qui correspond au lien avec ce joueur.
function relationAction(player) {
  const busy = state.friends.busy.has(player.id);
  if (player.relation === 'friend') return h('span', { class: 'person__tag' }, 'Ami');
  if (player.relation === 'outgoing') return h('span', { class: 'person__tag' }, 'Demande envoyée');
  const label = player.relation === 'incoming' ? 'Accepter sa demande' : 'Ajouter';
  return h('button', { class: 'btn btn--primary btn--small', type: 'button', disabled: busy, onclick: () => addFriend(player) }, label);
}

let searchTimer = null;

function addTab() {
  const f = state.friends;
  const input = h('input', { id: 'player-search', type: 'search', placeholder: 'Pseudo du joueur', 'aria-label': 'Chercher un joueur par son pseudo', spellcheck: 'false', maxlength: 40 });
  input.value = f.query;
  input.addEventListener('input', () => {
    f.query = input.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
  });
  return h('div', { class: 'friends' },
    h('label', { class: 'search search--page' }, icon('search'), input),
    h('div', { id: 'search-results' }, searchResults()),
    h('h2', { class: 'section-title section-title--small' }, 'Suggestions'),
    h('div', { id: 'suggestions' }, suggestionsList()));
}

function searchResults() {
  const f = state.friends;
  const query = f.query.trim();
  if (query.length < 2) return h('p', { class: 'muted' }, 'Tape au moins 2 lettres du pseudo de ton pote.');
  if (!f.results) return h('p', { class: 'muted' }, 'Recherche…');
  if (!f.results.length) return h('p', { class: 'muted' }, `Aucun joueur ne s’appelle « ${query} ».`);
  return h('ul', { class: 'people glass' }, f.results.map((player) => personRow(player, { actions: [relationAction(player)] })));
}

function suggestionsList() {
  const f = state.friends;
  if (!f.suggestions) return h('p', { class: 'muted' }, 'Chargement des suggestions…');
  const list = f.suggestions.filter((player) => player.relation === 'none' || player.justChanged);
  if (!list.length) return h('p', { class: 'muted' }, 'Pas de suggestion pour l’instant.');
  return h('ul', { class: 'people glass' }, list.map((player) => personRow(player, {
    status: player.mutual ? (player.mutual === 1 ? '1 ami en commun' : `${player.mutual} amis en commun`) : 'Membre de Nexora',
    actions: [relationAction(player)],
  })));
}

async function runSearch() {
  const f = state.friends;
  const query = f.query.trim();
  f.results = null;
  if (query.length >= 2) {
    $('#search-results')?.replaceChildren(searchResults());
    try {
      const results = await nx.searchPlayers(query);
      if (f.query.trim() !== query) return; // le joueur a continué à taper
      f.results = results;
    } catch (err) {
      f.results = [];
      toast(err.message, 'error');
    }
  }
  $('#search-results')?.replaceChildren(searchResults());
}

async function loadSuggestions() {
  try {
    state.friends.suggestions = await nx.friendSuggestions();
  } catch (err) {
    state.friends.suggestions = [];
    toast(err.message, 'error');
  }
  $('#suggestions')?.replaceChildren(suggestionsList());
}

// Met à jour le lien avec ce joueur dans la recherche et les suggestions.
function setRelation(userId, relation) {
  const f = state.friends;
  for (const player of [...(f.results || []), ...(f.suggestions || [])]) {
    if (player.id === userId) {
      player.relation = relation;
      player.justChanged = true; // reste affiché dans les suggestions avec son nouveau statut
    }
  }
}

async function friendAction(userId, task) {
  const f = state.friends;
  f.busy.add(userId);
  renderFriendsBody();
  try {
    await task();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    f.busy.delete(userId);
    await refreshFriends();
  }
}

function addFriend(player) {
  return friendAction(player.id, async () => {
    const relation = await nx.sendFriendRequest(player.id);
    setRelation(player.id, relation);
    toast(relation === 'friend' ? `${player.username} et toi êtes maintenant amis` : `Demande envoyée à ${player.username}`);
  });
}

function respondRequest(request, accept) {
  return friendAction(request.id, async () => {
    await nx.respondFriendRequest(request.id, accept);
    setRelation(request.id, accept ? 'friend' : 'none');
    toast(accept ? `${request.username} et toi êtes maintenant amis` : 'Demande refusée');
  });
}

function cancelRequest(request) {
  return friendAction(request.id, async () => {
    await nx.removeFriend(request.id);
    setRelation(request.id, 'none');
    toast('Demande annulée');
  });
}

async function removeFriend(friend) {
  const ok = await confirmDialog({
    title: `Retirer ${friend.username} ?`,
    body: 'Vous ne verrez plus quand l’autre est en ligne. Tu pourras lui renvoyer une demande plus tard.',
    confirm: 'Retirer',
    danger: true,
  });
  if (!ok) return;
  await friendAction(friend.id, async () => {
    await nx.removeFriend(friend.id);
    setRelation(friend.id, 'none');
    toast(`${friend.username} retiré de tes amis`);
  });
}

/* ---------- Mises à jour du launcher ---------- */

function updateText(u) {
  switch (u.state) {
    case 'dev': return 'Mises à jour automatiques désactivées en mode développement (npm start).';
    case 'checking': return 'Recherche d’une nouvelle version…';
    case 'latest': return 'Tu as la dernière version.';
    case 'downloading': return `Téléchargement de la version ${u.version} : ${u.percent} %`;
    case 'ready': return `La version ${u.version} est prête. Redémarre le launcher pour l’installer.`;
    case 'error': return u.error;
    default: return 'Le launcher cherche les nouvelles versions au démarrage, puis toutes les 4 heures.';
  }
}

function onUpdateState(u) {
  state.update = u;
  renderUpdateCard();
  const line = $('#update-line');
  if (line) {
    line.textContent = updateText(u);
    line.classList.toggle('is-error', u.state === 'error');
  }
  const actions = $('#update-actions');
  if (actions) actions.replaceChildren(...updateButtons());
}

function updateButtons() {
  const u = state.update;
  if (u.state === 'ready') return [h('button', { class: 'btn btn--primary', type: 'button', onclick: installUpdate }, 'Redémarrer et mettre à jour')];
  if (u.state === 'dev') return [];
  return [h('button', {
    class: 'btn',
    type: 'button',
    disabled: u.state === 'checking' || u.state === 'downloading',
    onclick: () => nx.checkUpdate().then(onUpdateState).catch((err) => toast(err.message, 'error')),
  }, 'Rechercher une mise à jour')];
}

// La carte en bas du menu : visible seulement quand une nouvelle version arrive.
function renderUpdateCard() {
  const card = $('#update-card');
  const u = state.update;
  if (u.state !== 'downloading' && u.state !== 'ready') {
    card.hidden = true;
    card.replaceChildren();
    return;
  }
  const bar = h('div', { class: 'progress__bar' });
  bar.style.width = `${u.state === 'ready' ? 100 : u.percent}%`;
  card.replaceChildren(
    h('strong', { class: 'update-card__title' }, u.state === 'ready' ? `Version ${u.version} prête` : `Version ${u.version} en route`),
    u.state === 'ready'
      ? h('button', { class: 'btn btn--primary btn--small', type: 'button', onclick: installUpdate }, 'Redémarrer pour mettre à jour')
      : h('div', { class: 'progress__track', role: 'progressbar', 'aria-label': 'Téléchargement de la mise à jour', 'aria-valuenow': u.percent }, bar));
  card.hidden = false;
}

async function installUpdate() {
  if (state.progress.size || state.pending.size) {
    toast('Attends la fin des installations en cours avant de redémarrer.', 'error');
    return;
  }
  try {
    await nx.installUpdate();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Paramètres ---------- */

function lockAppsRow() {
  const input = h('input', { type: 'checkbox', class: 'switch__input', role: 'switch', 'aria-label': 'Réserver mes applis au launcher' });
  input.checked = Boolean(state.config.lockApps);
  input.addEventListener('change', async () => {
    input.disabled = true;
    try {
      state.config.lockApps = await nx.setLockApps(input.checked);
      toast(input.checked ? 'Tes applis ne s’ouvrent plus que depuis le launcher' : 'Tes applis peuvent de nouveau s’ouvrir sans le launcher');
    } catch (err) {
      input.checked = !input.checked;
      toast(err.message, 'error');
    } finally {
      input.disabled = false;
    }
  });
  return h('label', { class: 'settings__row settings__row--toggle' },
    h('span', { class: 'settings__text' },
      h('span', { class: 'settings__label' }, 'Réserver mes applis au launcher'),
      h('span', { class: 'settings__hint' }, 'Un double-clic sur le .exe d’une appli affiche « Il faut aller dans le Nexora Launcher, puis cliquer sur Lancer ». Seul le bouton Lancer l’ouvre.')),
    h('span', { class: 'switch' }, input, h('span', { class: 'switch__track', 'aria-hidden': 'true' })));
}

function autoUpdateRow() {
  const input = h('input', { type: 'checkbox', class: 'switch__input', role: 'switch', 'aria-label': 'Mettre à jour mes applis automatiquement' });
  input.checked = Boolean(state.config.autoUpdateApps);
  input.addEventListener('change', async () => {
    try {
      state.config.autoUpdateApps = await nx.setAutoUpdateApps(input.checked);
      toast(input.checked ? 'Tes applis se mettront à jour toutes seules' : 'Mises à jour automatiques des applis désactivées');
    } catch (err) {
      input.checked = !input.checked;
      toast(err.message, 'error');
    }
  });
  return h('label', { class: 'settings__row settings__row--toggle' },
    h('span', { class: 'settings__text' },
      h('span', { class: 'settings__label' }, 'Mettre à jour mes applis automatiquement'),
      h('span', { class: 'settings__hint' }, 'Quand une nouvelle version sort sur GitHub, le launcher l’installe sans que tu aies à cliquer, tant que l’appli n’est pas ouverte.')),
    h('span', { class: 'switch' }, input, h('span', { class: 'switch__track', 'aria-hidden': 'true' })));
}

function settingsPage() {
  const user = state.user;
  return h('section', { class: 'page' },
    h('h1', { class: 'page__title' }, 'Paramètres'),
    h('div', { class: 'settings' },
      h('section', { class: 'settings__group glass' },
        h('h2', { class: 'section-title' }, 'Mises à jour'),
        h('div', { class: 'settings__row' },
          h('div', { class: 'account-card' },
            h('span', { class: 'account-card__name' }, `Nexora-Launcher ${state.config.version}`),
            h('span', { class: `update-line${state.update.state === 'error' ? ' is-error' : ''}`, id: 'update-line' }, updateText(state.update))),
          h('span', { class: 'update-actions', id: 'update-actions' }, updateButtons())),
        autoUpdateRow(),
        lockAppsRow()),
      h('section', { class: 'settings__group glass' },
        h('h2', { class: 'section-title' }, 'Serveur'),
        h('p', { class: 'muted' }, 'Les comptes, la boutique et les fichiers sont hébergés sur Supabase.'),
        h('span', { class: 'path' }, state.config.serverHost)),
      h('section', { class: 'settings__group glass' },
        h('h2', { class: 'section-title' }, 'Applis installées'),
        h('div', { class: 'settings__row' },
          h('span', { class: 'path' }, state.config.appsDir),
          h('button', { class: 'btn', type: 'button', onclick: () => nx.openAppsFolder().catch((err) => toast(err.message, 'error')) }, icon('folder'), 'Ouvrir le dossier'))),
      h('section', { class: 'settings__group glass' },
        h('h2', { class: 'section-title' }, 'Compte'),
        h('div', { class: 'settings__row' },
          h('div', { class: 'account-card' },
            h('span', { class: 'account-card__name' }, user.username, user.isAdmin ? h('span', { class: 'badge' }, 'Nexora-Team') : null),
            h('span', { class: 'account-card__mail' }, user.email)),
          h('button', { class: 'btn', type: 'button', onclick: onLogout }, 'Se déconnecter'))),
      h('p', { class: 'about' }, `Nexora-Launcher ${state.config.version}`)));
}

/* ---------- Démarrage ---------- */

function wire() {
  $('#tab-login').addEventListener('click', () => setAuthMode('login'));
  $('#tab-register').addEventListener('click', () => setAuthMode('register'));
  $('#login-form').addEventListener('submit', onLogin);
  $('#register-form').addEventListener('submit', onRegister);

  $('#nav-shop').addEventListener('click', () => navigate('shop'));
  $('#nav-library').addEventListener('click', () => navigate('library'));
  $('#nav-friends').addEventListener('click', () => {
    navigate('friends');
    refreshFriends();
  });
  $('#nav-publish').addEventListener('click', () => navigate(state.page === 'publish' ? 'library' : 'publish'));
  $('#nav-settings').addEventListener('click', () => navigate(state.page === 'settings' ? 'library' : 'settings'));
  $('#search').addEventListener('input', (event) => {
    state.query = event.target.value;
    renderSidebar();
  });
  $('#refresh').addEventListener('click', () => refreshApps());
  $('#logout').addEventListener('click', onLogout);

  $('#confirm-cancel').addEventListener('click', () => $('#confirm').close('cancel'));
  $('#confirm-ok').addEventListener('click', () => $('#confirm').close('ok'));

  window.addEventListener('focus', () => {
    if (state.user && Date.now() - state.lastRefresh > 30_000) refreshApps({ quiet: true });
    if (state.user) refreshFriends();
  });
  // Les amis qui se connectent ou lancent un jeu : plus souvent quand la page Amis est ouverte.
  setInterval(() => {
    if (state.user && (state.page === 'friends' || Date.now() - (state.friends.lastLoad || 0) > 60_000)) refreshFriends();
  }, 20_000);

  nx.onDownloadProgress(onDownloadProgress);
  nx.onInstallPhase(onInstallPhase);
  nx.onUploadProgress(onUploadProgress);
  nx.onAppExited(onAppExited);
  nx.onUpdateState(onUpdateState);
  nx.onAppAutoUpdate(onAppAutoUpdate);
  nx.onSessionExpired(() => {
    if (state.user) showAuth('Ta session a expiré. Reconnecte-toi.');
  });
}

async function boot() {
  wire();
  state.config = await nx.getConfig();
  nx.getUpdate().then(onUpdateState).catch(() => {});
  if (!state.config.configured) {
    showAuth(state.config.configError);
    $('#login-submit').disabled = true;
    $('#register-submit').disabled = true;
    return;
  }
  try {
    const restored = await nx.restoreSession();
    if (restored) {
      enterShell(restored.user, restored.offline);
      return;
    }
    showAuth();
  } catch (err) {
    showAuth(err.message);
  }
}

boot();
