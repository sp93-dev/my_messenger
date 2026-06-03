// ===================== ХРАНИЛИЩЕ =====================
const DB = {
  users: 'msg_users',
  session: 'msg_session',
  chats: 'msg_chats',
  messages: 'msg_messages',
  contacts: 'msg_contacts',
  presence: 'msg_presence',
  prefs: 'msg_prefs',
  stickers: 'msg_stickers',
  comments: 'msg_comments',
  typing: 'msg_typing',         // { [chatId]: { [userId]: lastTypingTs } }
  drafts: 'msg_drafts',         // { [userId]: { [chatId]: text } }
  stories: 'msg_stories',       // [{ id, userId, type, content, timestamp, viewedBy:[] }]
};
const STORY_TTL_MS = 24 * 60 * 60 * 1000;

const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let users = load(DB.users, []);
let chats = load(DB.chats, []);
let messages = load(DB.messages, []).filter(m => !m.deleted);
save(DB.messages, messages);
let contactsAll = load(DB.contacts, {});
let presence = load(DB.presence, {});
let prefs = load(DB.prefs, {});
let stickersAll = load(DB.stickers, {});
let comments = load(DB.comments, []);
let typing = load(DB.typing, {});
let drafts = load(DB.drafts, {});
let stories = load(DB.stories, []);
let session = load(DB.session, null);
let currentChatId = null;
let pendingSelfDestruct = false;
let pendingReplyTo = null;     // id сообщения, на которое отвечаем
let pendingEditId = null;      // id сообщения, которое редактируем

// ===================== REAL-TIME =====================
const channel = new BroadcastChannel('messenger_channel');
channel.onmessage = () => {
  reloadAllFromStorage();
  if (session) renderChats();
  if (currentChatId) renderMessages();
  refreshChatHeaderPresence();
  maybeNotify();
};
window.addEventListener('storage', () => {
  reloadAllFromStorage();
  if (session) renderChats();
  if (currentChatId) renderMessages();
  refreshChatHeaderPresence();
});
function reloadAllFromStorage() {
  users = load(DB.users, []);
  chats = load(DB.chats, []);
  messages = load(DB.messages, []).filter(m => !m.deleted);
  contactsAll = load(DB.contacts, {});
  presence = load(DB.presence, {});
  prefs = load(DB.prefs, {});
  stickersAll = load(DB.stickers, {});
  comments = load(DB.comments, []);
  typing = load(DB.typing, {});
  drafts = load(DB.drafts, {});
  stories = load(DB.stories, []);
}
const broadcast = () => channel.postMessage({ t: Date.now() });

// ===================== ХЕЛПЕРЫ =====================
const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const me = () => users.find(u => u.id === session);
const realUser = (id) => users.find(u => u.id === id);
const realName = (u) => u && (u.name || u.username);
const colorFor = (id) => 'color-' + ((id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 7) + 1);
const initials = (name) => (name || '?').trim().slice(0, 2).toUpperCase();
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function displayUser(otherId) {
  const real = realUser(otherId);
  if (!real) return { id: otherId, username: 'unknown', name: 'Неизвестный', avatar: null };
  const my = session ? (contactsAll[session] || {}) : {};
  const override = my[otherId] || {};
  return {
    id: real.id,
    username: real.username,
    name: override.name || real.name || real.username,
    avatar: override.avatar || real.avatar,
    bio: real.bio,
    status: real.status,
  };
}
function setAvatar(el, userLike) {
  const isLarge = el.classList.contains('avatar-large');
  el.className = 'avatar' + (isLarge ? ' avatar-large' : '') + ' ' + colorFor(userLike.id);
  if (userLike.avatar) { el.style.backgroundImage = `url(${userLike.avatar})`; el.textContent = ''; }
  else { el.style.backgroundImage = ''; el.textContent = initials(userLike.name || userLike.username); }
}
function setChatAvatar(el, chat) {
  if (chat.type === 'group' || chat.type === 'channel') {
    const isLarge = el.classList.contains('avatar-large');
    el.className = 'avatar' + (isLarge ? ' avatar-large' : '') + ' ' + colorFor(chat.id);
    if (chat.avatar) { el.style.backgroundImage = `url(${chat.avatar})`; el.textContent = ''; }
    else { el.style.backgroundImage = ''; el.textContent = chat.type === 'channel' ? '📢' : '👥'; }
    return;
  }
  const otherId = chat.members.find(m => m !== session);
  setAvatar(el, displayUser(otherId));
}
function formatTime(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}
function fileToDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
function blobToDataURL(b) { return fileToDataURL(b); }
function fmtDuration(s) { const m = Math.floor(s/60), sec = s%60; return `${m}:${sec.toString().padStart(2,'0')}`; }

// ===================== ТОСТЫ =====================
function toast(message, opts = {}) {
  const { type = 'info', duration = 3200, action = null } = typeof opts === 'string' ? { type: opts } : opts;
  const container = $('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const icons = { success: '✓', error: '⚠', info: 'ℹ' };
  el.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-text"></span>`;
  el.querySelector('.toast-text').textContent = message;
  let removed = false;
  const remove = () => {
    if (removed) return; removed = true;
    el.classList.add('hiding');
    setTimeout(() => el.remove(), 250);
  };
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.onclick = () => { action.onClick(); remove(); };
    el.appendChild(btn);
  }
  el.onclick = (e) => { if (!e.target.closest('.toast-action')) remove(); };
  container.appendChild(el);
  setTimeout(remove, duration);
  return el;
}

// ===================== ОНЛАЙН + TYPING =====================
const ONLINE_THRESHOLD = 15000;
const SELF_DESTRUCT_MS = 5000;
const TYPING_THRESHOLD = 5000;

function isOnline(userId) {
  const u = realUser(userId);
  const p = prefs[userId] || {};
  if (p.hideLastSeen) return false;
  return presence[userId] && (Date.now() - presence[userId] < ONLINE_THRESHOLD);
}
function lastSeenText(userId) {
  const p = prefs[userId] || {};
  if (p.hideLastSeen) return 'был(а) давно';
  if (!presence[userId]) return 'был(а) недавно';
  const diff = Date.now() - presence[userId];
  if (diff < ONLINE_THRESHOLD) return 'в сети';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'был(а) только что';
  if (m < 60) return `был(а) ${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `был(а) ${h} ч назад`;
  return 'был(а) в сети ' + formatTime(presence[userId]);
}
function pulsePresence() {
  if (!session) return;
  presence = load(DB.presence, {});
  presence[session] = Date.now();
  save(DB.presence, presence);
  broadcast();
}
setInterval(() => { if (session) pulsePresence(); }, 5000);
window.addEventListener('beforeunload', () => {
  if (session) {
    presence = load(DB.presence, {});
    presence[session] = Date.now() - ONLINE_THRESHOLD;
    save(DB.presence, presence);
  }
});

function markTyping() {
  if (!session || !currentChatId) return;
  typing = load(DB.typing, {});
  typing[currentChatId] = typing[currentChatId] || {};
  typing[currentChatId][session] = Date.now();
  save(DB.typing, typing);
  broadcast();
}
function typingUsersIn(chatId) {
  const chatTyping = (typing[chatId] || {});
  const now = Date.now();
  return Object.entries(chatTyping)
    .filter(([uid, ts]) => uid !== session && now - ts < TYPING_THRESHOLD)
    .map(([uid]) => displayUser(uid).name);
}

// ===================== ТЕМА И АКЦЕНТ =====================
const DESIGN_PRESETS = {
  'dark':    { name: 'Классика',   icon: '🌙', isDark: true, accent: '#5288c1', vars: null },
  'light':   { name: 'Светлая',    icon: '☀️', isDark: false, accent: '#3b82f6', vars: null },
  'ocean':   {
    name: 'Океан', icon: '🌊', isDark: true, accent: '#06b6d4',
    vars: {
      '--bg-primary': '#06192a', '--bg-secondary': '#0d2740', '--bg-tertiary': '#173d59',
      '--bg-elevated': '#1d4768', '--bg-input': '#173d59', '--bg-msg-in': '#1d4768',
      '--bg-msg-out': '#0e7490', '--bg-active': 'rgba(6,182,212,0.2)', '--bg-hover': 'rgba(255,255,255,0.05)',
      '--border': 'rgba(6,182,212,0.12)', '--border-strong': 'rgba(6,182,212,0.25)',
      '--accent': '#06b6d4', '--accent-hover': '#22d3ee', '--accent-soft': 'rgba(6,182,212,0.18)',
      '--sender': '#7dd3fc',
      '--chat-bg': 'radial-gradient(ellipse at 25% 15%, rgba(6,182,212,0.12) 0%, transparent 55%), radial-gradient(ellipse at 80% 80%, rgba(34,211,238,0.08) 0%, transparent 50%), #06192a',
    }
  },
  'sunset':  {
    name: 'Закат', icon: '🌅', isDark: true, accent: '#f97316',
    vars: {
      '--bg-primary': '#1c0e08', '--bg-secondary': '#2d1b14', '--bg-tertiary': '#3f2419',
      '--bg-elevated': '#4a2c1f', '--bg-input': '#3f2419', '--bg-msg-in': '#4a2c1f',
      '--bg-msg-out': '#9a3412', '--bg-active': 'rgba(249,115,22,0.2)', '--bg-hover': 'rgba(255,255,255,0.05)',
      '--border': 'rgba(249,115,22,0.12)', '--border-strong': 'rgba(249,115,22,0.25)',
      '--accent': '#f97316', '--accent-hover': '#fb923c', '--accent-soft': 'rgba(249,115,22,0.2)',
      '--sender': '#fdba74',
      '--chat-bg': 'radial-gradient(ellipse at 25% 15%, rgba(249,115,22,0.14) 0%, transparent 55%), radial-gradient(ellipse at 80% 80%, rgba(244,63,94,0.1) 0%, transparent 50%), #1c0e08',
    }
  },
  'forest':  {
    name: 'Лес', icon: '🌲', isDark: true, accent: '#22c55e',
    vars: {
      '--bg-primary': '#0a1d12', '--bg-secondary': '#0f2a1c', '--bg-tertiary': '#173a2a',
      '--bg-elevated': '#1d4734', '--bg-input': '#173a2a', '--bg-msg-in': '#1d4734',
      '--bg-msg-out': '#15803d', '--bg-active': 'rgba(34,197,94,0.18)', '--bg-hover': 'rgba(255,255,255,0.05)',
      '--border': 'rgba(34,197,94,0.12)', '--border-strong': 'rgba(34,197,94,0.25)',
      '--accent': '#22c55e', '--accent-hover': '#4ade80', '--accent-soft': 'rgba(34,197,94,0.2)',
      '--sender': '#86efac',
      '--chat-bg': 'radial-gradient(ellipse at 25% 15%, rgba(34,197,94,0.12) 0%, transparent 55%), radial-gradient(ellipse at 80% 80%, rgba(132,204,22,0.08) 0%, transparent 50%), #0a1d12',
    }
  },
  'mono':    {
    name: 'Моно', icon: '⚪', isDark: false, accent: '#0f172a',
    vars: {
      '--bg-primary': '#fafafa', '--bg-secondary': '#ffffff', '--bg-tertiary': '#f4f4f5',
      '--bg-elevated': '#ffffff', '--bg-input': '#f4f4f5', '--bg-msg-in': '#f4f4f5',
      '--bg-msg-out': '#e4e4e7', '--bg-active': 'rgba(15,23,42,0.08)', '--bg-hover': 'rgba(15,23,42,0.04)',
      '--border': 'rgba(15,23,42,0.08)', '--border-strong': 'rgba(15,23,42,0.18)',
      '--text-primary': '#18181b', '--text-secondary': '#52525b', '--text-muted': '#a1a1aa',
      '--accent': '#18181b', '--accent-hover': '#3f3f46', '--accent-soft': 'rgba(15,23,42,0.06)',
      '--sender': '#3f3f46',
      '--chat-bg': '#fafafa',
    }
  },
  'vibrant': {
    name: 'Яркая', icon: '🌈', isDark: true, accent: '#a855f7',
    vars: {
      '--bg-primary': '#0c0726', '--bg-secondary': '#171041', '--bg-tertiary': '#22195c',
      '--bg-elevated': '#2d2275', '--bg-input': '#22195c', '--bg-msg-in': '#2d2275',
      '--bg-msg-out': '#7c3aed', '--bg-active': 'rgba(168,85,247,0.2)', '--bg-hover': 'rgba(255,255,255,0.06)',
      '--border': 'rgba(168,85,247,0.15)', '--border-strong': 'rgba(168,85,247,0.3)',
      '--accent': '#a855f7', '--accent-hover': '#c084fc', '--accent-soft': 'rgba(168,85,247,0.22)',
      '--sender': '#d8b4fe',
      '--chat-bg': 'radial-gradient(ellipse at 25% 15%, rgba(168,85,247,0.18) 0%, transparent 55%), radial-gradient(ellipse at 80% 80%, rgba(236,72,153,0.12) 0%, transparent 50%), #0c0726',
    }
  },
  'auto':    { name: 'Авто', icon: '🖥', dynamic: true, accent: '#5288c1', vars: null },
};

function applyTheme(themeId) {
  let preset = DESIGN_PRESETS[themeId];
  if (!preset) preset = DESIGN_PRESETS['dark'];
  let baseTheme;
  if (preset.dynamic) baseTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  else baseTheme = preset.isDark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', baseTheme);
  // Сбрасываем все переменные тем (CSS значение по умолчанию)
  const allKnownVars = ['--bg-primary','--bg-secondary','--bg-tertiary','--bg-elevated','--bg-input','--bg-msg-in','--bg-msg-out','--bg-active','--bg-hover','--border','--border-strong','--text-primary','--text-secondary','--text-muted','--accent','--accent-hover','--accent-soft','--sender','--chat-bg'];
  for (const v of allKnownVars) document.documentElement.style.removeProperty(v);
  // Применяем переменные пресета
  if (preset.vars) {
    for (const [k, v] of Object.entries(preset.vars)) {
      document.documentElement.style.setProperty(k, v);
    }
  }
  // Подкрашиваем кнопку send-shadow под новый акцент
  // (через переменную CSS — но shadow зашит, нормально)
  // Подсветим активную карточку темы
  document.querySelectorAll('[data-theme-btn]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeBtn === themeId);
  });
  document.querySelectorAll('.theme-card').forEach(c => {
    c.classList.toggle('active', c.dataset.theme === themeId);
  });
}

function renderThemeGrid() {
  const grid = $('theme-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const cur = getUserPrefs().theme || 'dark';
  for (const [id, p] of Object.entries(DESIGN_PRESETS)) {
    const accent = p.accent;
    const bg = p.dynamic ? 'linear-gradient(135deg, #0b1218 50%, #f6f8fb 50%)' : (p.vars?.['--bg-primary'] || (p.isDark ? '#0b1218' : '#ffffff'));
    const msgBg = p.dynamic ? '#5288c1' : (p.vars?.['--bg-msg-out'] || accent);
    const card = document.createElement('div');
    card.className = 'theme-card' + (id === cur ? ' active' : '');
    card.dataset.theme = id;
    card.innerHTML = `
      <div class="theme-preview">
        <div class="theme-preview-bg" style="background: ${bg};"></div>
        <div class="theme-preview-bubble" style="background: ${msgBg};"></div>
        <div class="theme-preview-accent" style="background: ${accent};"></div>
        <span class="theme-card-icon">${p.icon}</span>
      </div>
      <div class="theme-card-name">${p.name}</div>`;
    card.onclick = () => setTheme(id);
    grid.appendChild(card);
  }
}
function applyAccent(color) {
  if (!color) return;
  document.documentElement.style.setProperty('--accent', color);
  // вычислим hover-вариант (чуть светлее)
  document.documentElement.style.setProperty('--accent-hover', color);
  document.querySelectorAll('[data-accent]').forEach(s => s.classList.toggle('active', s.dataset.accent === color));
}
function getUserPrefs() {
  if (!session) return { theme: 'dark' };
  prefs = load(DB.prefs, {});
  return prefs[session] || {};
}
function setUserPref(key, value) {
  if (!session) return;
  prefs = load(DB.prefs, {});
  prefs[session] = { ...(prefs[session] || {}), [key]: value };
  save(DB.prefs, prefs);
  broadcast();
}
function setTheme(theme) { applyTheme(theme); setUserPref('theme', theme); renderThemeGrid(); }

// слушаем системную тему для авто-режима
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getUserPrefs().theme === 'auto') applyTheme('auto');
  });
}

// ===================== АВТОРИЗАЦИЯ =====================
$('show-register').onclick = (e) => { e.preventDefault(); switchAuth('register'); };
$('show-login').onclick = (e) => { e.preventDefault(); switchAuth('login'); };
function switchAuth(which) {
  $('login-form').classList.toggle('active', which === 'login');
  $('register-form').classList.toggle('active', which === 'register');
  $('login-error').textContent = ''; $('register-error').textContent = '';
}
$('btn-register').onclick = () => {
  const name = $('reg-name').value.trim();
  const username = $('reg-username').value.trim();
  const p1 = $('reg-password').value;
  const p2 = $('reg-password2').value;
  const err = $('register-error');
  err.textContent = '';
  if (!name) return err.textContent = 'Введите имя.';
  if (!username || /\s/.test(username) || username.length < 3) return err.textContent = 'Юзернейм минимум 3 символа без пробелов.';
  if (!/^[a-zA-Z0-9_.]+$/.test(username)) return err.textContent = 'Юзернейм: только латиница, цифры, _ и .';
  if (p1.length < 4) return err.textContent = 'Пароль минимум 4 символа.';
  if (p1 !== p2) return err.textContent = 'Пароли не совпадают.';
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) return err.textContent = 'Юзернейм уже занят.';
  const user = { id: uid(), name, username, password: p1, avatar: null, bio: '', status: '', createdAt: Date.now() };
  users.push(user); save(DB.users, users);
  session = user.id; save(DB.session, session);
  broadcast(); enterApp();
};
$('btn-login').onclick = () => {
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  const err = $('login-error'); err.textContent = '';
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user || user.password !== password) return err.textContent = 'Неверный юзернейм или пароль.';
  session = user.id; save(DB.session, session);
  enterApp();
};
$('btn-logout').onclick = () => {
  if (session) {
    presence[session] = Date.now() - ONLINE_THRESHOLD; save(DB.presence, presence); broadcast();
  }
  session = null; currentChatId = null;
  save(DB.session, null);
  applyTheme('dark');
  $('main-screen').classList.remove('active');
  $('auth-screen').classList.add('active');
  $('login-username').value = ''; $('login-password').value = '';
};

function enterApp() {
  // PIN-блокировка
  const p = getUserPrefs();
  if (p.pin) {
    $('pin-lock').style.display = 'flex';
    $('pin-lock-input').value = '';
    setTimeout(() => $('pin-lock-input').focus(), 50);
    return;
  }
  finishEnter();
}
function finishEnter() {
  $('pin-lock').style.display = 'none';
  $('auth-screen').classList.remove('active');
  $('main-screen').classList.add('active');
  const p = getUserPrefs();
  applyTheme(p.theme || 'dark');
  if (p.notifications) tryNotifPermission();
  pulsePresence();
  refreshMe();
  renderChats();
  closeChat();
}

// PIN unlock
$('pin-lock-input').addEventListener('input', (e) => {
  const pin = e.target.value;
  const p = getUserPrefs();
  $('pin-lock-error').textContent = '';
  if (pin.length === (p.pin || '').length && pin === p.pin) finishEnter();
  else if (pin.length >= (p.pin || '').length) {
    $('pin-lock-error').textContent = 'Неверный PIN';
    setTimeout(() => { e.target.value = ''; $('pin-lock-error').textContent = ''; }, 700);
  }
});

function refreshMe() {
  const u = me();
  if (!u) return;
  $('my-name-mini').textContent = realName(u);
  $('my-handle-mini').textContent = '@' + u.username;
  setAvatar($('my-avatar-mini'), { id: u.id, name: realName(u), avatar: u.avatar });
}

// ===================== ЧАТ-ЛИСТ =====================
function chatBlockedFor(chat) {
  if (chat.type !== 'dm') return false;
  const otherId = chat.members.find(m => m !== session);
  const myPrefs = prefs[session] || {};
  return (myPrefs.blocked || []).includes(otherId);
}
function isArchived(chat) {
  return (chat.archivedBy || []).includes(session);
}
function getMyChats(includeArchived = false) {
  return chats
    .filter(c => c.members.includes(session))
    .filter(c => includeArchived || !isArchived(c))
    .filter(c => !chatBlockedFor(c))
    .map(c => {
      const last = messages
        .filter(m => m.chatId === c.id && !(m.scheduledFor && m.scheduledFor > Date.now()))
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      return { ...c, lastMsg: last };
    })
    .sort((a, b) => (b.lastMsg?.timestamp || b.createdAt) - (a.lastMsg?.timestamp || a.createdAt));
}
function chatTitle(chat) {
  if (chat.type === 'group' || chat.type === 'channel') return chat.name;
  return displayUser(chat.members.find(m => m !== session)).name;
}
function isChannelOwner(c) { return c && c.type === 'channel' && c.ownerId === session; }
function isSubscribed(c) { return c && c.type === 'channel' && (c.members || []).includes(session); }

function lastMessagePreview(msg) {
  if (!msg) return 'Нет сообщений';
  const tag = msg.senderId === session ? 'Вы: ' : '';
  if (msg.selfDestruct) return tag + '🔥 одноразовое';
  if (msg.type === 'image') return tag + '📷 Фото';
  if (msg.type === 'video') return tag + '🎬 Видео';
  if (msg.type === 'sticker') return tag + '🎨 Стикер';
  if (msg.type === 'voice') return tag + '🎤 Голосовое';
  if (msg.type === 'videomsg') return tag + '📹 Видеосообщение';
  if (msg.type === 'poll') return tag + '📊 ' + (msg.poll?.question || 'Опрос');
  return tag + (msg.content && msg.content.length > 40 ? msg.content.slice(0, 40) + '…' : (msg.content || ''));
}

function renderChats() {
  const list = $('chat-list');
  const query = $('search-input').value.trim().toLowerCase();
  const myChats = getMyChats().filter(c => !query || chatTitle(c).toLowerCase().includes(query));
  if (myChats.length === 0) {
    list.innerHTML = `<div class="chat-item-empty">${query ? 'Ничего не найдено' : 'Пока нет чатов'}</div>`;
    return;
  }
  list.innerHTML = '';
  for (const chat of myChats) {
    const div = document.createElement('div');
    div.className = 'chat-item' + (chat.id === currentChatId ? ' active' : '');
    let onlineHtml = '';
    if (chat.type === 'dm') {
      const otherId = chat.members.find(m => m !== session);
      if (isOnline(otherId)) onlineHtml = '<div class="online-dot show"></div>';
    }
    const prefix = chat.type === 'channel' ? '📢 ' : (chat.type === 'group' ? '' : '');
    const typers = typingUsersIn(chat.id);
    const preview = typers.length
      ? `<span class="typing-indicator">${typers.join(', ')} печатает…</span>`
      : escapeHtml(lastMessagePreview(chat.lastMsg));
    div.innerHTML = `
      <div class="avatar-wrap">
        <div class="avatar"></div>
        ${onlineHtml}
      </div>
      <div class="chat-item-info">
        <div class="chat-item-top">
          <div class="chat-item-name">${prefix}<span></span></div>
          <div class="chat-item-time">${chat.lastMsg ? formatTime(chat.lastMsg.timestamp) : ''}</div>
        </div>
        <div class="chat-item-last">${preview}</div>
      </div>`;
    setChatAvatar(div.querySelector('.avatar'), chat);
    div.querySelector('.chat-item-name span').textContent = chatTitle(chat);
    div.onclick = () => openChat(chat.id);
    list.appendChild(div);
  }
}
$('search-input').oninput = renderChats;

// ===================== ОТКРЫТИЕ ЧАТА =====================
function openChat(id) {
  // сохраним черновик предыдущего
  if (currentChatId && currentChatId !== id) saveDraft();

  currentChatId = id;
  const chat = chats.find(c => c.id === id);
  if (!chat) return closeChat();
  $('chat-empty').style.display = 'none';
  $('chat-view').style.display = 'flex';
  $('chat-header-name').textContent = chatTitle(chat);
  const header = $('chat-header');
  $('btn-subscribe').style.display = 'none';
  $('btn-edit-contact').style.display = 'none';
  $('chat-online-dot').classList.remove('show');
  removeChannelClosed();
  cancelReply(); cancelEdit();

  if (chat.type === 'group') {
    $('chat-header-sub').textContent = `Группа · ${chat.members.length} участников`;
    $('chat-header-sub').classList.remove('online');
    header.classList.add('no-click');
    document.querySelector('.composer').style.display = '';
  } else if (chat.type === 'channel') {
    const subs = (chat.members || []).length;
    const subscribed = isSubscribed(chat);
    const owner = isChannelOwner(chat);
    $('chat-header-sub').textContent = `Канал · ${subs} подписчик(ов)` + (owner ? ' · Ваш' : '');
    $('chat-header-sub').classList.remove('online');
    header.classList.add('no-click');
    if (!owner) {
      $('btn-subscribe').style.display = '';
      $('btn-subscribe').textContent = subscribed ? 'Отписаться' : 'Подписаться';
      $('btn-subscribe').classList.toggle('subscribed', subscribed);
    }
    document.querySelector('.composer').style.display = owner ? '' : 'none';
    if (!owner) showChannelClosed(subscribed ? 'Здесь постит только владелец. Комментируйте посты!' : 'Подпишитесь, чтобы читать канал.');
  } else {
    header.classList.remove('no-click');
    $('btn-edit-contact').style.display = '';
    document.querySelector('.composer').style.display = '';
    refreshChatHeaderPresence();
  }
  setChatAvatar($('chat-avatar'), chat);
  renderPinned();
  renderMessages();
  renderChats();
  restoreDraft();
  if (chat.type !== 'channel' || isChannelOwner(chat)) $('message-input').focus();
}

function showChannelClosed(text) {
  let el = $('channel-closed');
  if (!el) {
    el = document.createElement('div'); el.id = 'channel-closed'; el.className = 'composer-disabled';
    document.querySelector('.chat-view').appendChild(el);
  }
  el.textContent = text;
}
function removeChannelClosed() { const el = $('channel-closed'); if (el) el.remove(); }

function refreshChatHeaderPresence() {
  if (!currentChatId) return;
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat || chat.type !== 'dm') return;
  const otherId = chat.members.find(m => m !== session);
  const sub = $('chat-header-sub');
  const dot = $('chat-online-dot');
  const typers = typingUsersIn(chat.id);
  if (typers.length) {
    sub.innerHTML = `<span class="typing-indicator">${escapeHtml(typers.join(', '))} печатает…</span>`;
    sub.classList.remove('online');
  } else if (isOnline(otherId)) {
    sub.textContent = 'в сети';
    sub.classList.add('online');
    dot.classList.add('show');
  } else {
    sub.textContent = lastSeenText(otherId);
    sub.classList.remove('online');
    dot.classList.remove('show');
  }
}
setInterval(() => {
  presence = load(DB.presence, {}); typing = load(DB.typing, {});
  if (currentChatId) refreshChatHeaderPresence();
  if (session) renderChats();
}, 3000);

function closeChat() {
  if (currentChatId) saveDraft();
  currentChatId = null;
  $('chat-empty').style.display = 'flex';
  $('chat-view').style.display = 'none';
  $('btn-edit-contact').style.display = 'none';
}

// ===================== ЗАКРЕПЛЁННОЕ =====================
function renderPinned() {
  const bar = $('pinned-bar');
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat || !chat.pinnedId) { bar.style.display = 'none'; return; }
  const m = messages.find(x => x.id === chat.pinnedId);
  if (!m) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  let preview = m.type === 'text' ? m.content : (lastMessagePreview(m));
  $('pinned-text').textContent = preview.slice(0, 100);
  bar.onclick = (e) => {
    if (e.target.id === 'pinned-unpin') return;
    const el = document.querySelector(`.msg[data-msg-id="${m.id}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.outline = '2px solid var(--accent)'; setTimeout(() => el.style.outline = '', 1500); }
  };
}
$('pinned-unpin').onclick = (e) => {
  e.stopPropagation();
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat) return;
  delete chat.pinnedId;
  save(DB.chats, chats); broadcast();
  renderPinned();
};

// ===================== СООБЩЕНИЯ =====================
function renderMessages() {
  if (!currentChatId) return;
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat) return closeChat();
  const list = messages
    .filter(m => m.chatId === currentChatId)
    .filter(m => !(m.scheduledFor && m.scheduledFor > Date.now() && m.senderId !== session))
    .sort((a, b) => a.timestamp - b.timestamp);
  // отметим прочтение чужих сообщений
  let readChanged = false;
  for (const m of list) {
    if (m.senderId !== session) {
      m.readBy = m.readBy || [];
      if (!m.readBy.includes(session)) { m.readBy.push(session); readChanged = true; }
    }
  }
  if (readChanged) { save(DB.messages, messages); broadcast(); }

  const box = $('messages');
  box.innerHTML = '';
  let lastDay = '';
  for (const m of list) {
    const day = new Date(m.timestamp).toDateString();
    if (day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'msg-day';
      const d = new Date(m.timestamp);
      const today = new Date(); const yest = new Date(); yest.setDate(today.getDate() - 1);
      sep.textContent = d.toDateString() === today.toDateString() ? 'Сегодня'
        : d.toDateString() === yest.toDateString() ? 'Вчера'
        : d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' });
      box.appendChild(sep);
      lastDay = day;
    }
    box.appendChild(renderMessageEl(m, chat));
  }

  // Заглушка для пустого канала
  if (chat.type === 'channel' && list.length === 0) {
    box.innerHTML = `<div class="channel-empty">
      <div class="big">📢</div>
      <div>${isChannelOwner(chat) ? 'Это ваш канал — опубликуйте первый пост!' : 'Здесь пока пусто'}</div>
    </div>`;
  }
  // Обработчики
  box.querySelectorAll('img[data-media]').forEach(el => { el.onclick = () => openMedia(el.src, 'img'); });
  box.querySelectorAll('.msg').forEach(el => attachContextMenu(el));
  box.querySelectorAll('.reaction-pill').forEach(el => {
    el.onclick = (e) => { e.stopPropagation(); toggleReaction(el.closest('.msg').dataset.msgId, el.dataset.react); };
  });
  box.querySelectorAll('[data-comments]').forEach(el => {
    el.onclick = (e) => { e.stopPropagation(); openComments(el.dataset.comments); };
  });
  box.querySelectorAll('[data-vote]').forEach(el => {
    el.onclick = () => votePoll(el.dataset.msgId, parseInt(el.dataset.vote, 10));
  });
  box.querySelectorAll('[data-like]').forEach(el => {
    el.onclick = () => toggleLike(el.dataset.like);
  });
  box.querySelectorAll('.msg-hashtag').forEach(el => {
    el.onclick = () => { openGlobalSearch(el.dataset.tag); };
  });
  box.querySelectorAll('.reply-quote').forEach(el => {
    el.onclick = () => {
      const target = box.querySelector(`.msg[data-msg-id="${el.dataset.replyId}"]`);
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.style.outline = '2px solid var(--accent)'; setTimeout(() => target.style.outline = '', 1500); }
    };
  });

  // Прочтение одноразовых
  for (const m of list) {
    if (m.selfDestruct && m.senderId !== session && !(m.readBy || []).includes(session)) {
      markMessageRead(m.id);
    }
    // подсчёт просмотров для каналов
    if (chat.type === 'channel' && m.senderId !== session) {
      m.views = m.views || [];
      if (!m.views.includes(session)) {
        m.views.push(session); save(DB.messages, messages); broadcast();
      }
    }
  }
  box.scrollTop = box.scrollHeight;
}

function renderMessageEl(m, chat) {
  const div = document.createElement('div');
  const mine = m.senderId === session;
  const inChannel = chat.type === 'channel';
  let classes = 'msg ' + (inChannel ? 'in post' : (mine ? 'out' : 'in'));
  if (m.selfDestruct) classes += ' self-destruct';
  if (m.type === 'sticker' && !inChannel) classes += ' sticker';
  if (m.type === 'voice') classes += ' voice';
  if (m.cmd === 'me') classes += ' cmd-me';
  if (inChannel && chat.pinnedId === m.id) classes += ' pinned-post';
  div.className = classes;
  div.dataset.msgId = m.id;

  let html = '';

  // Цитата (ответ)
  if (m.replyTo) {
    const orig = messages.find(x => x.id === m.replyTo);
    if (orig) {
      const author = displayUser(orig.senderId);
      const snippet = orig.type === 'text' ? orig.content : lastMessagePreview(orig);
      html += `<div class="reply-quote" data-reply-id="${orig.id}">
        <div class="quote-author">${escapeHtml(author.name)}</div>
        <div class="quote-text">${escapeHtml(snippet.slice(0, 80))}</div>
      </div>`;
    }
  }

  if (chat.type === 'group' && !mine && m.type !== 'sticker') {
    html += `<div class="msg-sender">${escapeHtml(displayUser(m.senderId).name)}</div>`;
  }
  const badges = [];
  if (m.selfDestruct) badges.push('🔥');
  if (m.scheduledFor && m.scheduledFor > Date.now() && mine) badges.push('⏱ ' + formatTime(m.scheduledFor));
  if ((m.starredBy || []).includes(session)) badges.push('⭐');
  if (badges.length) html += `<div class="msg-badges">${badges.map(escapeHtml).join(' ')}</div>`;

  if (m.type === 'text') {
    html += `<div>${renderText(m.content)}</div>`;
  } else if (m.type === 'image') {
    html += `<img src="${m.content}" data-media>`;
    if (m.caption) html += `<div>${renderText(m.caption)}</div>`;
  } else if (m.type === 'video') {
    html += `<video src="${m.content}" controls data-media></video>`;
  } else if (m.type === 'sticker') {
    html += `<img src="${m.content}" alt="Стикер">`;
  } else if (m.type === 'voice') {
    html += `<audio src="${m.content}" controls></audio>`;
  } else if (m.type === 'videomsg') {
    html += `<video src="${m.content}" class="videomsg" controls playsinline></video>`;
  } else if (m.type === 'poll') {
    html += renderPoll(m);
  } else if (m.type === 'file') {
    const ext = (m.fileName || '').split('.').pop().toUpperCase().slice(0, 4) || 'FILE';
    html += `<div class="file-card" data-file="${m.id}">
      <div class="file-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </div>
      <div class="file-meta">
        <div class="file-name">${escapeHtml(m.fileName || 'Файл')}</div>
        <div class="file-size">${fmtFileSize(m.fileSize || 0)} · ${escapeHtml(ext)}</div>
      </div>
    </div>`;
  } else if (m.type === 'location') {
    const lat = m.lat, lng = m.lng;
    const bbox = `${lng - 0.01},${lat - 0.005},${lng + 0.01},${lat + 0.005}`;
    html += `<div class="location-card" data-loc="${lat},${lng}">
      <iframe src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}" loading="lazy"></iframe>
      <div class="location-info">
        <div style="font-size:13px;font-weight:500">📍 Местоположение</div>
        <div class="location-coords">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
      </div>
    </div>`;
  } else if (m.type === 'game-ttt') {
    html += renderTTT(m);
  } else if (m.type === 'album') {
    const imgs = m.album || [];
    const shown = imgs.slice(0, 4);
    const extra = imgs.length - 4;
    const cls = imgs.length === 1 ? 'n1' : imgs.length === 2 ? 'n2' : imgs.length === 3 ? 'n3' : imgs.length === 4 ? 'n4' : 'nmany';
    html += `<div class="album-grid ${cls}">`;
    shown.forEach((src, i) => {
      const moreCls = (i === 3 && extra > 0) ? 'album-more' : '';
      const moreAttr = (i === 3 && extra > 0) ? ` data-more="${extra}"` : '';
      html += `<div class="${moreCls}"${moreAttr}><img src="${src}" data-album="${m.id}" data-idx="${i}"></div>`;
    });
    html += `</div>`;
    if (m.caption) html += `<div>${renderText(m.caption)}</div>`;
  }

  // Каналы: статистика
  if (inChannel) {
    const likes = (m.likes || []).length;
    const liked = (m.likes || []).includes(session);
    const cmt = comments.filter(c => c.postId === m.id).length;
    const views = (m.views || []).length;
    html += `<div class="post-stats">
      <button class="post-like-btn ${liked ? 'liked' : ''}" data-like="${m.id}">❤️ ${likes}</button>
      <button class="post-comments-btn" data-comments="${m.id}">💬 ${cmt}</button>
      <span>👁 ${views}</span>
    </div>`;
  }

  // Время + edited
  let timeMark = new Date(m.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  let editedMark = m.editedAt ? `<span class="edited-mark">изм.</span>` : '';
  // Галочки прочтения
  let checks = '';
  if (mine && chat.type !== 'channel') {
    const readers = (m.readBy || []).filter(x => x !== session);
    const totalRecipients = chat.members.length - 1;
    if (readers.length >= totalRecipients) checks = `<span class="msg-checks read">✓✓</span>`;
    else checks = `<span class="msg-checks">✓</span>`;
  }
  html += `<span class="msg-time">${editedMark}${timeMark}${checks}</span>`;

  if (m.selfDestruct) {
    if (m.readAt) {
      const left = Math.max(0, Math.ceil((SELF_DESTRUCT_MS - (Date.now() - m.readAt)) / 1000));
      html += `<div class="msg-burning">сгорит через ${left} сек</div>`;
    } else if (mine) html += `<div class="msg-burning">исчезнет после прочтения</div>`;
    else html += `<div class="msg-burning">одноразовое</div>`;
  }

  // Реакции
  if (m.reactions && Object.keys(m.reactions).length) {
    const pills = Object.entries(m.reactions)
      .filter(([_, arr]) => arr && arr.length)
      .map(([emoji, arr]) => `<span class="reaction-pill ${arr.includes(session) ? 'mine' : ''}" data-react="${escapeHtml(emoji)}">${emoji}<span class="count">${arr.length}</span></span>`)
      .join('');
    if (pills) html += `<div class="reactions">${pills}</div>`;
  }

  div.innerHTML = html;
  return div;
}

function renderText(text) {
  let s = escapeHtml(text);
  // Markdown: спойлеры первыми (||text||)
  s = s.replace(/\|\|([^|]+?)\|\|/g, '<span class="md-spoiler" onclick="this.classList.add(\'revealed\')">$1</span>');
  // Жирный *text* (не цеплять одиночные *)
  s = s.replace(/\*([^*\n]+?)\*/g, '<span class="md-bold">$1</span>');
  // Курсив _text_
  s = s.replace(/(^|\s)_([^_\n]+?)_(?=\s|$|[.,!?;:])/g, '$1<span class="md-italic">$2</span>');
  // Зачёркнутый ~~text~~
  s = s.replace(/~~([^~\n]+?)~~/g, '<span class="md-strike">$1</span>');
  // Код `text`
  s = s.replace(/`([^`\n]+?)`/g, '<span class="md-code">$1</span>');
  // Хэштеги #tag
  s = s.replace(/#([\p{L}\d_]+)/gu, (_, tag) => `<span class="msg-hashtag" data-tag="${escapeHtml('#' + tag)}">#${tag}</span>`);
  // Упоминания @username
  s = s.replace(/@([a-zA-Z0-9_.]{3,})/g, (full, uname) => {
    const u = users.find(x => x.username.toLowerCase() === uname.toLowerCase());
    if (!u) return full;
    return `<span class="msg-mention" data-mention="${escapeHtml(u.username)}">@${escapeHtml(uname)}</span>`;
  });
  // Ссылки http(s):// и www.
  s = s.replace(/(\bhttps?:\/\/[^\s<]+|\bwww\.[^\s<]+)/g, (url) => {
    const href = url.startsWith('http') ? url : 'https://' + url;
    return `<a class="msg-link" href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
  return s;
}

function renderPoll(m) {
  const poll = m.poll;
  if (!poll) return '';
  const totalVotes = poll.options.reduce((s, o) => s + (o.votes || []).length, 0);
  const isQuiz = poll.quiz;
  const iVoted = poll.options.some(o => (o.votes || []).includes(session));
  const icon = isQuiz ? '🧠' : '📊';
  let html = `<div class="poll"><div class="poll-question">${icon} ${escapeHtml(poll.question)}</div>
    <div class="poll-meta">${isQuiz ? 'Викторина · ' : ''}${totalVotes} голос(ов)${poll.multi && !isQuiz ? ' · можно несколько' : ''}</div>`;
  poll.options.forEach((opt, i) => {
    const votes = (opt.votes || []).length;
    const pct = totalVotes ? Math.round(votes * 100 / totalVotes) : 0;
    const voted = (opt.votes || []).includes(session);
    let cls = voted ? 'voted' : '';
    let badge = '';
    // В викторине после голосования показываем правильный/неправильный
    if (isQuiz && iVoted) {
      if (i === poll.correct) { cls = 'quiz-correct'; badge = '<span class="poll-quiz-badge">✓ верно</span>'; }
      else if (voted) cls = 'quiz-wrong';
    }
    html += `<div class="poll-opt ${cls}" data-vote="${i}" data-msg-id="${m.id}">
      <div class="poll-opt-bar" style="width:${pct}%"></div>
      <span>${voted ? '✓' : '○'}</span>
      <span class="opt-text">${escapeHtml(opt.text)}${badge}</span>
      <span class="opt-pct">${pct}% (${votes})</span>
    </div>`;
  });
  if (isQuiz && iVoted) {
    const right = poll.options[poll.correct] && (poll.options[poll.correct].votes || []).includes(session);
    html += `<div class="poll-meta" style="margin-top:4px;color:${right ? 'var(--online)' : 'var(--danger)'}">${right ? '🎉 Вы ответили правильно!' : '❌ Неверно'}</div>`;
  }
  html += `</div>`;
  return html;
}

function votePoll(msgId, optIdx) {
  const fresh = load(DB.messages, []);
  const m = fresh.find(x => x.id === msgId);
  if (!m || m.type !== 'poll') return;
  if (!m.poll.multi) m.poll.options.forEach(o => o.votes = (o.votes || []).filter(v => v !== session));
  const opt = m.poll.options[optIdx];
  opt.votes = opt.votes || [];
  const i = opt.votes.indexOf(session);
  if (i === -1) opt.votes.push(session);
  else opt.votes.splice(i, 1);
  save(DB.messages, fresh); messages = fresh;
  broadcast(); renderMessages();
}

function toggleLike(msgId) {
  const fresh = load(DB.messages, []);
  const m = fresh.find(x => x.id === msgId);
  if (!m) return;
  m.likes = m.likes || [];
  const i = m.likes.indexOf(session);
  if (i === -1) m.likes.push(session); else m.likes.splice(i, 1);
  save(DB.messages, fresh); messages = fresh;
  broadcast(); renderMessages();
}

function markMessageRead(msgId) {
  const msg = messages.find(x => x.id === msgId);
  if (!msg) return;
  msg.readBy = msg.readBy || [];
  if (msg.readBy.includes(session)) return;
  msg.readBy.push(session);
  if (!msg.readAt && msg.selfDestruct) msg.readAt = Date.now();
  save(DB.messages, messages); broadcast();
}

function sendMessage(payload) {
  if (!currentChatId) return;
  // ЕДИНОЕ место для отправки и редактирования
  if (pendingEditId) {
    const m = messages.find(x => x.id === pendingEditId);
    if (m && m.senderId === session) {
      Object.assign(m, payload, { editedAt: Date.now() });
      save(DB.messages, messages);
      broadcast(); renderMessages(); renderChats();
    }
    pendingEditId = null; cancelEdit();
    return;
  }
  const msg = {
    id: uid(), chatId: currentChatId, senderId: session, timestamp: Date.now(),
    selfDestruct: !!pendingSelfDestruct, readBy: [session], reactions: {},
    replyTo: pendingReplyTo || undefined,
    ...payload,
  };
  messages.push(msg); save(DB.messages, messages);
  pendingSelfDestruct = false; refreshComposerToggles();
  pendingReplyTo = null; cancelReply();
  broadcast(); renderMessages(); renderChats();
}

$('btn-send').onclick = doSend;
$('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    const enterSends = getUISetting('enterSend', true);
    if (enterSends) { e.preventDefault(); doSend(); }
  }
});
$('message-input').addEventListener('input', () => { markTyping(); saveDraft(); });
function doSend() {
  let text = $('message-input').value.trim();
  if (!text || !currentChatId) return;
  // команды
  const cmdMatch = text.match(/^\/(me|shrug|tableflip)\s*(.*)$/);
  if (cmdMatch) {
    const cmd = cmdMatch[1]; const rest = cmdMatch[2];
    if (cmd === 'me') { sendMessage({ type: 'text', content: `* ${realName(me())} ${rest}`, cmd: 'me' }); }
    else if (cmd === 'shrug') { sendMessage({ type: 'text', content: `${rest} ¯\\_(ツ)_/¯`.trim() }); }
    else if (cmd === 'tableflip') { sendMessage({ type: 'text', content: `${rest} (╯°□°)╯︵ ┻━┻`.trim() }); }
  } else {
    sendMessage({ type: 'text', content: text });
  }
  $('message-input').value = '';
  clearDraft();
  closeEmojiPicker();
}

// ===================== ЧЕРНОВИКИ =====================
function draftKey() { return session && currentChatId ? `${session}|${currentChatId}` : null; }
function saveDraft() {
  const k = draftKey(); if (!k) return;
  const v = $('message-input').value;
  drafts = load(DB.drafts, {}); drafts[session] = drafts[session] || {};
  if (v) drafts[session][currentChatId] = v; else delete drafts[session][currentChatId];
  save(DB.drafts, drafts);
}
function restoreDraft() {
  if (!session || !currentChatId) return;
  drafts = load(DB.drafts, {});
  const v = (drafts[session] || {})[currentChatId] || '';
  $('message-input').value = v;
}
function clearDraft() {
  if (!session || !currentChatId) return;
  drafts = load(DB.drafts, {});
  if (drafts[session]) delete drafts[session][currentChatId];
  save(DB.drafts, drafts);
}

// ===================== ВЛОЖЕНИЯ =====================
$('btn-attach').onclick = () => $('file-input').click();
$('file-input').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || !currentChatId) return;
  if (file.size > 4 * 1024 * 1024) { toast('Файл слишком большой (макс 4 МБ)', 'error'); return; }
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  try {
    const dataUrl = await fileToDataURL(file);
    if (isImage) sendMessage({ type: 'image', content: dataUrl });
    else if (isVideo) sendMessage({ type: 'video', content: dataUrl });
    else sendMessage({
      type: 'file', content: dataUrl,
      fileName: file.name, fileSize: file.size, fileMime: file.type || 'application/octet-stream'
    });
  } catch { toast('Не удалось прочитать файл', 'error'); }
};
function fmtFileSize(b) {
  if (b < 1024) return b + ' Б';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' КБ';
  return (b/1024/1024).toFixed(2) + ' МБ';
}

function openMedia(src, kind) {
  const mc = $('media-content');
  mc.onclick = null;
  mc.innerHTML = kind === 'video' ? `<video src="${src}" controls autoplay></video>` : `<img src="${src}">`;
  $('media-viewer').classList.add('open');
}
$('media-close').onclick = () => { $('media-viewer').classList.remove('open'); $('media-content').innerHTML = ''; $('media-content').onclick = null; };
$('media-viewer').onclick = (e) => { if (e.target.id === 'media-viewer') $('media-close').click(); };

// ===================== ЭМОДЗИ + СТИКЕРЫ =====================
const EMOJIS = ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🥳','🤩','🥺','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥱','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿','👹','👺','🤡','💩','👻','💀','☠️','👽','👾','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋','🤝','🙏','✍️','💪','🦵','🦶','👂','👃','🧠','👀','👁️','👅','👄','💋','🔥','💯','💥','💫','💦','💨','🎉','🎊','🎈','🎁','🎂','🍰','🍕','🍔','🍟','🌮','☕','🍺','🍷','🍻','🥂','🍾','⚽','🏀','🏈','⚾','🎾','🎮','🕹️','🎯','🎲','🎸'];
EMOJIS.forEach(em => {
  const s = document.createElement('span'); s.textContent = em;
  s.onclick = () => { $('message-input').value += em; $('message-input').focus(); };
  $('emoji-grid').appendChild(s);
});
function renderStickerGrid() {
  const grid = $('sticker-grid'); grid.innerHTML = '';
  const list = (stickersAll[session] || []);
  if (!list.length) { grid.innerHTML = '<div class="sticker-empty">Загрузите стикеры в профиле</div>'; return; }
  for (const st of list) {
    const img = document.createElement('img'); img.src = st.dataUrl;
    img.onclick = () => { sendMessage({ type: 'sticker', content: st.dataUrl }); closeEmojiPicker(); };
    grid.appendChild(img);
  }
}
document.querySelectorAll('.emoji-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.emoji-tab').forEach(t => t.classList.toggle('active', t === tab));
    const isE = tab.dataset.tab === 'emojis';
    $('emoji-grid').style.display = isE ? 'grid' : 'none';
    $('sticker-grid').style.display = isE ? 'none' : 'grid';
    if (!isE) renderStickerGrid();
  };
});
const picker = $('emoji-picker');
$('btn-emoji').onclick = (e) => { e.stopPropagation(); picker.classList.toggle('open'); closeSchedule(); };
document.addEventListener('click', (e) => { if (!picker.contains(e.target) && e.target !== $('btn-emoji')) closeEmojiPicker(); });
function closeEmojiPicker() { picker.classList.remove('open'); }

// ===================== ОДНОРАЗОВЫЕ =====================
$('btn-self-destruct').onclick = () => { pendingSelfDestruct = !pendingSelfDestruct; refreshComposerToggles(); };
function refreshComposerToggles() {
  $('btn-self-destruct').classList.toggle('active', pendingSelfDestruct);
  const hint = $('composer-hint');
  if (pendingSelfDestruct) { $('composer-hint-text').textContent = '🔥 Следующее сообщение исчезнет после прочтения'; hint.classList.add('show'); }
  else hint.classList.remove('show');
}
$('composer-hint-cancel').onclick = () => { pendingSelfDestruct = false; refreshComposerToggles(); };

// ===================== ОТЛОЖЕННЫЕ =====================
const schedulePopup = $('schedule-popup');
$('btn-schedule').onclick = (e) => {
  e.stopPropagation(); closeEmojiPicker();
  const d = new Date(Date.now() + 10 * 60 * 1000); const pad = (n) => n.toString().padStart(2, '0');
  $('schedule-datetime').value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  schedulePopup.classList.toggle('open');
};
function closeSchedule() { schedulePopup.classList.remove('open'); }
document.addEventListener('click', (e) => { if (!schedulePopup.contains(e.target) && e.target !== $('btn-schedule')) closeSchedule(); });
$('btn-schedule-confirm').onclick = () => {
  const text = $('message-input').value.trim(); const when = $('schedule-datetime').value;
  if (!text || !currentChatId) { toast('Введите текст сообщения', 'error'); return; }
  const sendAt = new Date(when).getTime();
  if (isNaN(sendAt) || sendAt < Date.now() + 5000) { toast('Время должно быть в будущем', 'error'); return; }
  messages.push({
    id: uid(), chatId: currentChatId, senderId: session, type: 'text', content: text,
    timestamp: sendAt, scheduledFor: sendAt, selfDestruct: !!pendingSelfDestruct, readBy: [session], reactions: {},
  });
  save(DB.messages, messages); pendingSelfDestruct = false; refreshComposerToggles();
  $('message-input').value = ''; closeSchedule();
  broadcast(); renderMessages(); renderChats();
};

// ===================== ГЛОБАЛЬНЫЙ ТИКЕР =====================
setInterval(() => {
  let changed = false;
  const fresh = load(DB.messages, []);
  for (const m of fresh) {
    if (m.scheduledFor && m.scheduledFor <= Date.now() && m.senderId === session) { delete m.scheduledFor; changed = true; }
  }
  for (let i = fresh.length - 1; i >= 0; i--) {
    const m = fresh[i];
    if (m.selfDestruct && m.readAt && (Date.now() - m.readAt) >= SELF_DESTRUCT_MS) { fresh.splice(i, 1); changed = true; }
  }
  if (changed) { save(DB.messages, fresh); messages = fresh; broadcast(); if (currentChatId) renderMessages(); if (session) renderChats(); }
  if (currentChatId) {
    document.querySelectorAll('.msg .msg-burning').forEach(el => {
      const ms = el.closest('.msg'); if (!ms) return;
      const m = messages.find(x => x.id === ms.dataset.msgId);
      if (!m || !m.readAt) return;
      const left = Math.max(0, Math.ceil((SELF_DESTRUCT_MS - (Date.now() - m.readAt)) / 1000));
      el.textContent = `сгорит через ${left} сек`;
    });
  }
}, 1000);

// ===================== РЕАКЦИИ =====================
function toggleReaction(msgId, emoji) {
  const fresh = load(DB.messages, []);
  const m = fresh.find(x => x.id === msgId); if (!m) return;
  m.reactions = m.reactions || {};
  m.reactions[emoji] = m.reactions[emoji] || [];
  const i = m.reactions[emoji].indexOf(session);
  if (i === -1) m.reactions[emoji].push(session); else m.reactions[emoji].splice(i, 1);
  if (!m.reactions[emoji].length) delete m.reactions[emoji];
  save(DB.messages, fresh); messages = fresh;
  broadcast(); renderMessages();
}

// ===================== КОНТЕКСТНОЕ МЕНЮ =====================
const ctxMenu = $('msg-menu');
let ctxTargetId = null;
function attachContextMenu(el) {
  const open = (e) => {
    e.preventDefault();
    const msgId = el.dataset.msgId;
    const m = messages.find(mm => mm.id === msgId); if (!m) return;
    ctxTargetId = msgId;
    const mine = m.senderId === session;
    $('ctx-edit').style.display = (mine && m.type === 'text') ? '' : 'none';
    $('ctx-delete').style.display = mine ? '' : 'none';
    $('ctx-copy').style.display = m.type === 'text' ? '' : 'none';
    const x = ('touches' in e ? e.touches[0].clientX : e.clientX);
    const y = ('touches' in e ? e.touches[0].clientY : e.clientY);
    ctxMenu.style.left = Math.min(x, window.innerWidth - 260) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - 320) + 'px';
    ctxMenu.classList.add('open');
  };
  el.addEventListener('contextmenu', open);
  let pt; el.addEventListener('touchstart', (e) => { pt = setTimeout(() => open(e), 500); });
  el.addEventListener('touchend', () => clearTimeout(pt));
  el.addEventListener('touchmove', () => clearTimeout(pt));
}
document.addEventListener('click', (e) => { if (!ctxMenu.contains(e.target)) ctxMenu.classList.remove('open'); });

$('ctx-delete').onclick = () => {
  if (!ctxTargetId) return;
  const idx = messages.findIndex(m => m.id === ctxTargetId); if (idx === -1) return;
  const removed = messages[idx];
  const removedIdx = idx;
  messages.splice(idx, 1); save(DB.messages, messages);
  ctxMenu.classList.remove('open'); ctxTargetId = null;
  broadcast(); renderMessages(); renderChats();
  // Undo
  toast('Сообщение удалено', {
    type: 'info', duration: 5000,
    action: {
      label: 'Отменить',
      onClick: () => {
        const fresh = load(DB.messages, []);
        if (!fresh.find(m => m.id === removed.id)) {
          fresh.splice(Math.min(removedIdx, fresh.length), 0, removed);
          save(DB.messages, fresh); messages = fresh;
          broadcast(); renderMessages(); renderChats();
          toast('Восстановлено', 'success');
        }
      }
    }
  });
};
$('ctx-reply').onclick = () => {
  if (!ctxTargetId) return;
  pendingReplyTo = ctxTargetId; ctxMenu.classList.remove('open');
  const m = messages.find(x => x.id === pendingReplyTo);
  const author = displayUser(m.senderId);
  $('reply-author').textContent = '↩ Ответ: ' + author.name;
  $('reply-snippet').textContent = m.type === 'text' ? m.content : lastMessagePreview(m);
  $('reply-preview').style.display = 'flex';
  $('message-input').focus();
};
$('reply-cancel').onclick = cancelReply;
function cancelReply() { pendingReplyTo = null; $('reply-preview').style.display = 'none'; }

$('ctx-edit').onclick = () => {
  if (!ctxTargetId) return;
  const m = messages.find(x => x.id === ctxTargetId);
  if (!m || m.senderId !== session || m.type !== 'text') return;
  pendingEditId = ctxTargetId; ctxMenu.classList.remove('open');
  $('message-input').value = m.content;
  $('composer-hint-text').textContent = '✎ Редактируем сообщение';
  $('composer-hint').classList.add('show');
  $('message-input').focus();
};
function cancelEdit() { pendingEditId = null; $('composer-hint').classList.remove('show'); $('message-input').value = ''; }

$('ctx-pin').onclick = () => {
  if (!ctxTargetId || !currentChatId) return;
  const chat = chats.find(c => c.id === currentChatId);
  chat.pinnedId = chat.pinnedId === ctxTargetId ? null : ctxTargetId;
  save(DB.chats, chats);
  ctxMenu.classList.remove('open');
  broadcast(); renderPinned(); renderMessages();
};
$('ctx-forward').onclick = () => {
  if (!ctxTargetId) return;
  forwardSourceId = ctxTargetId; ctxMenu.classList.remove('open');
  $('forward-search').value = ''; renderForwardList(); openModal('forward-modal');
};
$('ctx-star').onclick = () => {
  if (!ctxTargetId) return;
  const m = messages.find(x => x.id === ctxTargetId); if (!m) return;
  m.starredBy = m.starredBy || [];
  const i = m.starredBy.indexOf(session);
  if (i === -1) m.starredBy.push(session); else m.starredBy.splice(i, 1);
  save(DB.messages, messages); ctxMenu.classList.remove('open');
  broadcast(); renderMessages();
};
$('ctx-copy').onclick = async () => {
  if (!ctxTargetId) return;
  const m = messages.find(x => x.id === ctxTargetId);
  if (m && m.content) { try { await navigator.clipboard.writeText(m.content); toast('Скопировано', 'success'); } catch { toast('Не удалось скопировать', 'error'); } }
  ctxMenu.classList.remove('open');
};
document.querySelectorAll('#reaction-row span').forEach(s => {
  s.onclick = () => { if (ctxTargetId) { toggleReaction(ctxTargetId, s.dataset.emoji); ctxMenu.classList.remove('open'); ctxTargetId = null; } };
});

// ===================== ПЕРЕСЫЛКА =====================
let forwardSourceId = null;
$('forward-search').oninput = renderForwardList;
function renderForwardList() {
  const list = $('forward-list');
  const q = $('forward-search').value.trim().toLowerCase();
  const myChats = getMyChats(true).filter(c => !q || chatTitle(c).toLowerCase().includes(q));
  list.innerHTML = '';
  for (const c of myChats) {
    if (c.type === 'channel' && c.ownerId !== session) continue; // в чужие каналы нельзя
    const div = document.createElement('div'); div.className = 'user-list-item';
    div.innerHTML = `<div class="avatar-wrap"><div class="avatar"></div></div><div class="user-list-item-name"></div>`;
    setChatAvatar(div.querySelector('.avatar'), c);
    div.querySelector('.user-list-item-name').textContent = chatTitle(c);
    div.onclick = () => {
      const orig = messages.find(m => m.id === forwardSourceId); if (!orig) return;
      messages.push({
        id: uid(), chatId: c.id, senderId: session, timestamp: Date.now(),
        type: orig.type, content: orig.content, caption: orig.caption,
        forwardedFrom: orig.senderId, readBy: [session], reactions: {},
      });
      save(DB.messages, messages); broadcast();
      closeModal('forward-modal');
      forwardSourceId = null;
      openChat(c.id);
    };
    list.appendChild(div);
  }
}

// ===================== МОДАЛКИ =====================
function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }
document.querySelectorAll('.modal-close').forEach(btn => { btn.onclick = () => closeModal(btn.dataset.close); });
document.querySelectorAll('.modal').forEach(modal => modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); }));

// ===================== ПРОФИЛЬ =====================
$('btn-profile').onclick = () => {
  const u = me(); if (!u) return;
  const p = getUserPrefs();
  $('profile-name').value = realName(u);
  $('profile-username').value = u.username;
  $('profile-password').value = '';
  $('profile-bio').value = u.bio || '';
  $('profile-status').value = u.status || '';
  $('profile-error').textContent = '';
  $('toggle-hide-last-seen').checked = !!p.hideLastSeen;
  $('toggle-notifications').checked = !!p.notifications;
  $('toggle-sound').checked = !!p.sound;
  setAvatar($('profile-avatar'), { id: u.id, name: realName(u), avatar: u.avatar });
  applyTheme(p.theme || 'dark');
  renderThemeGrid();
  renderStickerLibrary();
  // VIP-баннер
  const isVip = !!u.isVip;
  $('vip-banner').classList.toggle('active', isVip);
  $('vip-banner-title').textContent = isVip ? '👑 Вы VIP' : 'VIP-подписка';
  $('vip-banner-sub').textContent = isVip ? 'Все премиум-фичи активны' : 'Эксклюзивные фичи скоро';
  openModal('profile-modal');
};

$('profile-avatar-input').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { $('profile-error').textContent = 'Макс 2 МБ.'; return; }
  const u = me(); u.avatar = await fileToDataURL(file);
  save(DB.users, users);
  setAvatar($('profile-avatar'), { id: u.id, name: realName(u), avatar: u.avatar });
  refreshMe(); renderChats(); if (currentChatId) renderMessages(); broadcast();
};
$('btn-remove-avatar').onclick = () => {
  const u = me(); u.avatar = null; save(DB.users, users);
  setAvatar($('profile-avatar'), { id: u.id, name: realName(u), avatar: u.avatar });
  refreshMe(); renderChats(); broadcast();
};
$('toggle-hide-last-seen').onchange = (e) => setUserPref('hideLastSeen', e.target.checked);
$('toggle-notifications').onchange = (e) => {
  setUserPref('notifications', e.target.checked);
  if (e.target.checked) tryNotifPermission();
};
$('toggle-sound').onchange = (e) => setUserPref('sound', e.target.checked);

$('btn-save-profile').onclick = () => {
  const u = me();
  const newName = $('profile-name').value.trim();
  const newUsername = $('profile-username').value.trim();
  const newPassword = $('profile-password').value;
  const bio = $('profile-bio').value.trim();
  const status = $('profile-status').value.trim();
  const err = $('profile-error'); err.textContent = '';
  if (!newName) return err.textContent = 'Введите имя.';
  if (!newUsername || /\s/.test(newUsername) || newUsername.length < 3) return err.textContent = 'Юзернейм минимум 3 символа.';
  if (!/^[a-zA-Z0-9_.]+$/.test(newUsername)) return err.textContent = 'Юзернейм: латиница/цифры/_/.';
  if (newUsername.toLowerCase() !== u.username.toLowerCase() && users.find(x => x.username.toLowerCase() === newUsername.toLowerCase())) return err.textContent = 'Юзернейм занят.';
  if (newPassword && newPassword.length < 4) return err.textContent = 'Пароль минимум 4 символа.';
  u.name = newName; u.username = newUsername; u.bio = bio; u.status = status;
  if (newPassword) u.password = newPassword;
  save(DB.users, users);
  refreshMe(); renderChats(); if (currentChatId) openChat(currentChatId);
  broadcast(); closeModal('profile-modal');
  toast('Профиль сохранён', 'success');
};

// ===================== СТИКЕРЫ =====================
function getMyStickers() { stickersAll = load(DB.stickers, {}); return stickersAll[session] || []; }
function saveMyStickers(arr) { stickersAll = load(DB.stickers, {}); stickersAll[session] = arr; save(DB.stickers, stickersAll); }
function renderStickerLibrary() {
  const lib = $('sticker-library'); lib.innerHTML = '';
  const list = getMyStickers();
  if (!list.length) { lib.innerHTML = '<div class="sticker-empty" style="grid-column:1/-1">Стикеров ещё нет</div>'; return; }
  for (const st of list) {
    const tile = document.createElement('div'); tile.className = 'sticker-tile';
    tile.innerHTML = `<img src="${st.dataUrl}"><div class="sticker-delete" data-id="${st.id}">✕</div>`;
    tile.querySelector('.sticker-delete').onclick = (e) => {
      e.stopPropagation();
      saveMyStickers(getMyStickers().filter(x => x.id !== e.currentTarget.dataset.id));
      renderStickerLibrary();
    };
    lib.appendChild(tile);
  }
}
$('add-sticker-input').onchange = async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  const cur = getMyStickers();
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    if (f.size > 500 * 1024) { toast(`"${f.name}" больше 500 КБ`, 'error'); continue; }
    cur.push({ id: uid(), dataUrl: await fileToDataURL(f) });
  }
  saveMyStickers(cur); renderStickerLibrary();
};

// ===================== РЕДАКТИРОВАНИЕ КОНТАКТА =====================
let editingContactId = null;
$('chat-header').onclick = (e) => {
  if (!currentChatId) return;
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat || chat.type !== 'dm') return;
  if (e.target.id === 'btn-edit-contact') return;
  openContactEditor();
};
$('btn-edit-contact').onclick = (e) => { e.stopPropagation(); openContactEditor(); };
function openContactEditor() {
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat || chat.type !== 'dm') return;
  const otherId = chat.members.find(m => m !== session);
  editingContactId = otherId;
  const d = displayUser(otherId); const real = realUser(otherId);
  $('contact-name').value = d.name; $('contact-name').placeholder = realName(real);
  $('contact-error').textContent = '';
  setAvatar($('contact-avatar'), d);
  openModal('contact-modal');
}
$('contact-avatar-input').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || !editingContactId) return;
  if (file.size > 2 * 1024 * 1024) { $('contact-error').textContent = 'Макс 2 МБ.'; return; }
  setContactOverride(editingContactId, { avatar: await fileToDataURL(file) });
  setAvatar($('contact-avatar'), displayUser(editingContactId));
};
$('btn-reset-contact-avatar').onclick = () => {
  if (!editingContactId) return;
  setContactOverride(editingContactId, { avatar: null }, true);
  setAvatar($('contact-avatar'), displayUser(editingContactId));
};
$('btn-save-contact').onclick = () => {
  if (!editingContactId) return;
  const name = $('contact-name').value.trim(); const real = realUser(editingContactId);
  if (!name || name === realName(real)) setContactOverride(editingContactId, { name: null }, true);
  else setContactOverride(editingContactId, { name });
  closeModal('contact-modal'); if (currentChatId) openChat(currentChatId); renderChats();
};
$('btn-reset-contact-all').onclick = () => {
  if (!editingContactId) return;
  contactsAll = load(DB.contacts, {});
  if (contactsAll[session]) { delete contactsAll[session][editingContactId]; save(DB.contacts, contactsAll); }
  closeModal('contact-modal'); if (currentChatId) openChat(currentChatId); renderChats();
};
function setContactOverride(otherId, patch, removeFalsy = false) {
  contactsAll = load(DB.contacts, {});
  contactsAll[session] = contactsAll[session] || {};
  const cur = contactsAll[session][otherId] || {};
  const next = { ...cur, ...patch };
  if (removeFalsy) for (const k of Object.keys(patch)) if (patch[k] == null) delete next[k];
  if (!Object.keys(next).length) delete contactsAll[session][otherId];
  else contactsAll[session][otherId] = next;
  save(DB.contacts, contactsAll);
}

// ===================== НОВЫЙ DM =====================
$('btn-new-chat').onclick = () => { $('new-chat-search').value = ''; renderNewChatUsers(); openModal('new-chat-modal'); };
$('new-chat-search').oninput = renderNewChatUsers;
function renderNewChatUsers() {
  const q = $('new-chat-search').value.trim().toLowerCase();
  const list = $('new-chat-users');
  const myPrefs = prefs[session] || {};
  const blocked = myPrefs.blocked || [];
  const others = users
    .filter(u => u.id !== session && !blocked.includes(u.id))
    .map(u => ({ real: u, d: displayUser(u.id) }))
    .filter(({ real, d }) => !q || real.username.toLowerCase().includes(q) || d.name.toLowerCase().includes(q));
  if (!others.length) { list.innerHTML = `<div class="user-list-empty">Нет пользователей.</div>`; return; }
  list.innerHTML = '';
  for (const { real, d } of others) {
    const div = document.createElement('div'); div.className = 'user-list-item';
    div.innerHTML = `<div class="avatar-wrap"><div class="avatar"></div></div><div class="user-list-item-name"></div>`;
    setAvatar(div.querySelector('.avatar'), d);
    div.querySelector('.user-list-item-name').innerHTML =
      `${escapeHtml(d.name)}<div style="font-size:12px;color:var(--text-muted)">@${escapeHtml(real.username)}</div>`;
    div.onclick = () => {
      const existing = chats.find(c => c.type === 'dm' && c.members.length === 2 && c.members.includes(session) && c.members.includes(real.id));
      if (existing) { closeModal('new-chat-modal'); openChat(existing.id); return; }
      const chat = { id: uid(), type: 'dm', name: null, members: [session, real.id], createdAt: Date.now() };
      chats.push(chat); save(DB.chats, chats); broadcast();
      closeModal('new-chat-modal'); renderChats(); openChat(chat.id);
    };
    list.appendChild(div);
  }
}

// ===================== НОВАЯ ГРУППА =====================
$('btn-new-group').onclick = () => { $('group-name').value = ''; $('group-error').textContent = ''; renderNewGroupUsers(); openModal('new-group-modal'); };
function renderNewGroupUsers() {
  const list = $('new-group-users');
  const myPrefs = prefs[session] || {};
  const blocked = myPrefs.blocked || [];
  const others = users.filter(u => u.id !== session && !blocked.includes(u.id));
  if (!others.length) { list.innerHTML = `<div class="user-list-empty">Нет пользователей.</div>`; return; }
  list.innerHTML = '';
  for (const u of others) {
    const d = displayUser(u.id);
    const div = document.createElement('div'); div.className = 'user-list-item';
    div.innerHTML = `<div class="avatar-wrap"><div class="avatar"></div></div><div class="user-list-item-name"></div><input type="checkbox" data-uid="${u.id}">`;
    setAvatar(div.querySelector('.avatar'), d);
    div.querySelector('.user-list-item-name').innerHTML =
      `${escapeHtml(d.name)}<div style="font-size:12px;color:var(--text-muted)">@${escapeHtml(u.username)}</div>`;
    div.onclick = (e) => { if (e.target.tagName !== 'INPUT') { const cb = div.querySelector('input'); cb.checked = !cb.checked; } };
    list.appendChild(div);
  }
}
$('btn-create-group').onclick = () => {
  const name = $('group-name').value.trim(); const err = $('group-error'); err.textContent = '';
  if (!name) return err.textContent = 'Введите название.';
  const checked = [...$('new-group-users').querySelectorAll('input:checked')].map(cb => cb.dataset.uid);
  if (!checked.length) return err.textContent = 'Выберите участников.';
  const chat = { id: uid(), type: 'group', name, members: [session, ...checked], createdAt: Date.now() };
  chats.push(chat); save(DB.chats, chats); broadcast();
  closeModal('new-group-modal'); renderChats(); openChat(chat.id);
};

// ===================== ЗАПИСЬ =====================
let mediaRecorder = null, recordedChunks = [], recordStream = null, recordStart = 0, recordType = null, recordTimerInt = null;
async function startRecording(type) {
  if (!currentChatId || mediaRecorder) return;
  try {
    recordStream = await navigator.mediaDevices.getUserMedia(type === 'voice' ? { audio: true } : { audio: true, video: { width: 320, height: 320 } });
  } catch (err) { toast('Нет доступа к устройству записи', 'error'); return; }
  recordedChunks = []; recordType = type;
  try { mediaRecorder = new MediaRecorder(recordStream, { mimeType: type === 'voice' ? 'audio/webm' : 'video/webm' }); }
  catch { mediaRecorder = new MediaRecorder(recordStream); }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
    const dur = Math.round((Date.now() - recordStart) / 1000);
    if (blob.size > 4 * 1024 * 1024) toast('Запись больше 4 МБ', 'error');
    else { try { sendMessage({ type: recordType, content: await blobToDataURL(blob), duration: dur }); } catch { toast('Ошибка записи', 'error'); } }
    cleanupRecording();
  };
  mediaRecorder.start(); recordStart = Date.now();
  $('recording-bar').classList.add('show');
  $('recording-type').textContent = type === 'voice' ? '🎤 Запись голоса' : '📹 Запись видео';
  $('recording-timer').textContent = '0:00';
  $('btn-voice').classList.toggle('recording', type === 'voice');
  $('btn-video-msg').classList.toggle('recording', type === 'videomsg');
  recordTimerInt = setInterval(() => {
    const s = Math.floor((Date.now() - recordStart) / 1000);
    $('recording-timer').textContent = fmtDuration(s);
    if (s >= 120) stopRecording(true);
  }, 250);
}
function stopRecording(send) {
  if (!mediaRecorder) return;
  if (!send) mediaRecorder.onstop = () => cleanupRecording();
  try { mediaRecorder.stop(); } catch {}
}
function cleanupRecording() {
  if (recordTimerInt) { clearInterval(recordTimerInt); recordTimerInt = null; }
  if (recordStream) { recordStream.getTracks().forEach(t => t.stop()); recordStream = null; }
  mediaRecorder = null; recordedChunks = []; recordType = null;
  $('recording-bar').classList.remove('show');
  $('btn-voice').classList.remove('recording'); $('btn-video-msg').classList.remove('recording');
}
$('btn-voice').onclick = () => { mediaRecorder ? stopRecording(true) : startRecording('voice'); };
$('btn-video-msg').onclick = () => { mediaRecorder ? stopRecording(true) : startRecording('videomsg'); };
$('btn-stop-record').onclick = () => stopRecording(true);
$('btn-cancel-record').onclick = () => stopRecording(false);

// ===================== КАНАЛЫ =====================
$('btn-channels').onclick = () => { $('channels-search').value = ''; renderChannelsList(); openModal('channels-modal'); };
$('channels-search').oninput = renderChannelsList;
function renderChannelsList() {
  const list = $('channels-list');
  const q = $('channels-search').value.trim().toLowerCase();
  const cs = chats.filter(c => c.type === 'channel').filter(c => !q || c.name.toLowerCase().includes(q));
  if (!cs.length) { list.innerHTML = `<div class="user-list-empty">Каналов нет</div>`; return; }
  list.innerHTML = '';
  for (const c of cs) {
    const subscribed = (c.members || []).includes(session); const owner = c.ownerId === session;
    const div = document.createElement('div'); div.className = 'user-list-item';
    div.innerHTML = `<div class="avatar-wrap"><div class="avatar"></div></div>
      <div class="channel-info"><div class="channel-info-name"></div><div class="channel-info-sub"></div></div>
      <button class="channel-action ${subscribed ? 'subscribed' : ''}" data-cid="${c.id}">${owner ? 'Открыть' : (subscribed ? 'Отписаться' : 'Подписаться')}</button>`;
    setChatAvatar(div.querySelector('.avatar'), c);
    div.querySelector('.channel-info-name').textContent = c.name;
    div.querySelector('.channel-info-sub').textContent = `${(c.members || []).length} подписчик(ов)` + (c.description ? ' · ' + c.description : '');
    div.querySelector('.channel-action').onclick = (e) => {
      e.stopPropagation();
      if (owner) { closeModal('channels-modal'); openChat(c.id); return; }
      toggleSubscribe(c.id); renderChannelsList();
    };
    div.onclick = () => { closeModal('channels-modal'); openChat(c.id); };
    list.appendChild(div);
  }
}
function toggleSubscribe(channelId) {
  const ch = chats.find(c => c.id === channelId && c.type === 'channel'); if (!ch) return;
  ch.members = ch.members || [];
  const i = ch.members.indexOf(session);
  if (i === -1) ch.members.push(session); else ch.members.splice(i, 1);
  save(DB.chats, chats); broadcast();
  renderChats(); if (currentChatId === channelId) openChat(channelId);
}
$('btn-subscribe').onclick = (e) => { e.stopPropagation(); if (currentChatId) toggleSubscribe(currentChatId); };

let newChannelAvatarData = null;
$('btn-open-create-channel').onclick = () => {
  closeModal('channels-modal');
  $('new-channel-name').value = ''; $('new-channel-desc').value = ''; $('create-channel-error').textContent = '';
  newChannelAvatarData = null;
  const av = $('new-channel-avatar'); av.className = 'avatar avatar-large color-2'; av.style.backgroundImage = ''; av.textContent = '📢';
  openModal('create-channel-modal');
};
$('new-channel-avatar-input').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || file.size > 2 * 1024 * 1024) return;
  newChannelAvatarData = await fileToDataURL(file);
  const av = $('new-channel-avatar'); av.style.backgroundImage = `url(${newChannelAvatarData})`; av.textContent = '';
};
$('btn-do-create-channel').onclick = () => {
  const name = $('new-channel-name').value.trim(); const desc = $('new-channel-desc').value.trim();
  const err = $('create-channel-error'); err.textContent = '';
  if (!name) return err.textContent = 'Название.';
  const chat = { id: uid(), type: 'channel', name, description: desc || null, ownerId: session, avatar: newChannelAvatarData, members: [session], createdAt: Date.now() };
  chats.push(chat); save(DB.chats, chats); broadcast();
  closeModal('create-channel-modal'); renderChats(); openChat(chat.id);
};

// ===================== КОММЕНТАРИИ =====================
let currentCommentPostId = null;
function openComments(postId) {
  currentCommentPostId = postId; comments = load(DB.comments, []); renderCommentsList();
  const post = messages.find(m => m.id === postId);
  const preview = $('post-preview');
  if (post) {
    const author = displayUser(post.senderId);
    let inner = `<strong>${escapeHtml(author.name)}</strong>: `;
    if (post.type === 'text') inner += escapeHtml(post.content.slice(0, 100));
    else inner += lastMessagePreview(post);
    preview.innerHTML = inner;
  }
  $('comment-input').value = ''; openModal('comments-modal');
  setTimeout(() => $('comment-input').focus(), 50);
}
function renderCommentsList() {
  const list = $('comments-list'); comments = load(DB.comments, []);
  const my = comments.filter(c => c.postId === currentCommentPostId).sort((a, b) => a.timestamp - b.timestamp);
  if (!my.length) { list.innerHTML = `<div class="comments-empty">Будьте первым!</div>`; return; }
  list.innerHTML = '';
  for (const c of my) {
    const div = document.createElement('div'); div.className = 'comment-item';
    const author = displayUser(c.userId);
    div.innerHTML = `<div class="avatar"></div><div class="comment-bubble"><div class="comment-author"></div><div class="comment-body"></div><div class="comment-time">${formatTime(c.timestamp)}</div></div>`;
    setAvatar(div.querySelector('.avatar'), author);
    div.querySelector('.comment-author').textContent = author.name;
    div.querySelector('.comment-body').textContent = c.content;
    list.appendChild(div);
  }
  list.scrollTop = list.scrollHeight;
}
$('btn-send-comment').onclick = sendComment;
$('comment-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComment(); } });
function sendComment() {
  if (!currentCommentPostId) return;
  const text = $('comment-input').value.trim(); if (!text) return;
  comments = load(DB.comments, []);
  comments.push({ id: uid(), postId: currentCommentPostId, userId: session, content: text, timestamp: Date.now() });
  save(DB.comments, comments); broadcast();
  $('comment-input').value = ''; renderCommentsList();
  if (currentChatId) renderMessages();
}

// ===================== ОПРОСЫ =====================
$('btn-poll').onclick = () => {
  $('poll-question').value = ''; $('poll-multi').checked = false; $('poll-error').textContent = '';
  $('poll-options').innerHTML = `<input type="text" class="poll-option-input" placeholder="Вариант 1"><input type="text" class="poll-option-input" placeholder="Вариант 2">`;
  openModal('poll-modal');
};
$('btn-add-poll-option').onclick = () => {
  const opts = $('poll-options').querySelectorAll('input').length;
  if (opts >= 10) return;
  const inp = document.createElement('input');
  inp.className = 'poll-option-input'; inp.type = 'text'; inp.placeholder = `Вариант ${opts + 1}`;
  $('poll-options').appendChild(inp);
};
$('btn-create-poll').onclick = () => {
  const q = $('poll-question').value.trim();
  const opts = [...$('poll-options').querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
  if (!q || opts.length < 2) { $('poll-error').textContent = 'Вопрос и минимум 2 варианта.'; return; }
  sendMessage({ type: 'poll', poll: { question: q, multi: $('poll-multi').checked, options: opts.map(t => ({ text: t, votes: [] })) }, content: '' });
  closeModal('poll-modal');
};

// ===================== ГЛОБАЛЬНЫЙ ПОИСК =====================
$('btn-search-global').onclick = () => { $('global-search-input').value = ''; renderSearchResults(); openModal('search-modal'); setTimeout(() => $('global-search-input').focus(), 50); };
$('global-search-input').oninput = renderSearchResults;
function openGlobalSearch(text) {
  $('global-search-input').value = text; renderSearchResults(); openModal('search-modal');
}
function renderSearchResults() {
  const q = $('global-search-input').value.trim().toLowerCase();
  const list = $('search-results');
  if (!q) { list.innerHTML = `<div class="search-empty">Введите запрос — поищем по всем чатам.</div>`; return; }
  const found = messages
    .filter(m => m.type === 'text' && m.content && m.content.toLowerCase().includes(q))
    .filter(m => {
      const chat = chats.find(c => c.id === m.chatId);
      return chat && chat.members.includes(session);
    })
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 100);
  if (!found.length) { list.innerHTML = `<div class="search-empty">Ничего не найдено</div>`; return; }
  list.innerHTML = '';
  for (const m of found) {
    const chat = chats.find(c => c.id === m.chatId);
    const author = displayUser(m.senderId);
    const div = document.createElement('div'); div.className = 'search-result';
    const highlighted = escapeHtml(m.content).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), s => `<mark>${s}</mark>`);
    div.innerHTML = `<div class="sr-chat">📍 ${escapeHtml(chatTitle(chat))} · ${formatTime(m.timestamp)}</div>
      <div class="sr-author">${escapeHtml(author.name)}</div>
      <div class="sr-text">${highlighted}</div>`;
    div.onclick = () => { closeModal('search-modal'); openChat(chat.id); setTimeout(() => {
      const el = document.querySelector(`.msg[data-msg-id="${m.id}"]`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.outline = '2px solid var(--accent)'; setTimeout(() => el.style.outline = '', 1500); }
    }, 200); };
    list.appendChild(div);
  }
}

// ===================== ИЗБРАННОЕ =====================
$('btn-starred').onclick = () => { renderStarred(); openModal('starred-modal'); };
function renderStarred() {
  const list = $('starred-results');
  const starred = messages.filter(m => (m.starredBy || []).includes(session)).sort((a, b) => b.timestamp - a.timestamp);
  if (!starred.length) { list.innerHTML = `<div class="search-empty">Помечайте сообщения через контекстное меню → ⭐</div>`; return; }
  list.innerHTML = '';
  for (const m of starred) {
    const chat = chats.find(c => c.id === m.chatId); if (!chat) continue;
    const author = displayUser(m.senderId);
    const div = document.createElement('div'); div.className = 'search-result';
    div.innerHTML = `<div class="sr-chat">⭐ ${escapeHtml(chatTitle(chat))}</div>
      <div class="sr-author">${escapeHtml(author.name)} · ${formatTime(m.timestamp)}</div>
      <div class="sr-text">${escapeHtml((m.content || lastMessagePreview(m)).slice(0, 200))}</div>`;
    div.onclick = () => { closeModal('starred-modal'); openChat(chat.id); };
    list.appendChild(div);
  }
}

// ===================== АРХИВ =====================
$('btn-archive').onclick = () => { renderArchive(); openModal('archive-modal'); };
function renderArchive() {
  const list = $('archive-list');
  const archived = chats.filter(c => c.members.includes(session) && isArchived(c));
  if (!archived.length) { list.innerHTML = `<div class="user-list-empty">Архив пуст. Архивируйте чат свайпом… (или из меню — реализуем по запросу).</div>`; return; }
  list.innerHTML = '';
  for (const c of archived) {
    const div = document.createElement('div'); div.className = 'user-list-item';
    div.innerHTML = `<div class="avatar-wrap"><div class="avatar"></div></div><div class="user-list-item-name"></div><button class="channel-action">Вернуть</button>`;
    setChatAvatar(div.querySelector('.avatar'), c);
    div.querySelector('.user-list-item-name').textContent = chatTitle(c);
    div.querySelector('button').onclick = (e) => { e.stopPropagation(); c.archivedBy = (c.archivedBy || []).filter(x => x !== session); save(DB.chats, chats); broadcast(); renderArchive(); renderChats(); };
    list.appendChild(div);
  }
}

// ===================== ЧЁРНЫЙ СПИСОК =====================
$('btn-manage-blocked').onclick = () => { renderBlocked(); openModal('blocked-modal'); };
function renderBlocked() {
  const list = $('blocked-list');
  const myPrefs = prefs[session] || {};
  const blocked = (myPrefs.blocked || []);
  const blockedUsers = blocked.map(id => realUser(id)).filter(Boolean);
  // также показываем не-заблокированных, чтобы можно было заблокировать
  const others = users.filter(u => u.id !== session && !blocked.includes(u.id));
  list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Заблокированные</div>';
  if (!blockedUsers.length) list.innerHTML += '<div class="user-list-empty">Никого нет</div>';
  for (const u of blockedUsers) {
    const div = document.createElement('div'); div.className = 'user-list-item';
    div.innerHTML = `<div class="avatar-wrap"><div class="avatar"></div></div><div class="user-list-item-name">${escapeHtml(realName(u))}</div><button class="channel-action">Разблокировать</button>`;
    setAvatar(div.querySelector('.avatar'), u);
    div.querySelector('button').onclick = () => { setUserPref('blocked', blocked.filter(x => x !== u.id)); renderBlocked(); renderChats(); };
    list.appendChild(div);
  }
  list.insertAdjacentHTML('beforeend', '<div style="font-size:12px;color:var(--text-muted);margin:12px 0 8px">Все пользователи</div>');
  for (const u of others) {
    const div = document.createElement('div'); div.className = 'user-list-item';
    div.innerHTML = `<div class="avatar-wrap"><div class="avatar"></div></div><div class="user-list-item-name">${escapeHtml(realName(u))}</div><button class="channel-action" style="background:var(--danger)">Заблокировать</button>`;
    setAvatar(div.querySelector('.avatar'), u);
    div.querySelector('button').onclick = () => { setUserPref('blocked', [...(prefs[session]?.blocked || []), u.id]); renderBlocked(); renderChats(); };
    list.appendChild(div);
  }
}

// ===================== PIN =====================
$('btn-set-pin').onclick = () => { $('new-pin').value = ''; $('pin-error').textContent = ''; openModal('pin-modal'); };
$('btn-save-pin').onclick = () => {
  const v = $('new-pin').value;
  if (v && !/^\d{4,8}$/.test(v)) { $('pin-error').textContent = '4–8 цифр'; return; }
  setUserPref('pin', v || null);
  closeModal('pin-modal');
};

// ===================== УВЕДОМЛЕНИЯ =====================
async function tryNotifPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') await Notification.requestPermission();
}
let lastSeenMsgTs = Date.now();
function maybeNotify() {
  const p = getUserPrefs();
  const fresh = load(DB.messages, []);
  const newOnes = fresh.filter(m =>
    m.timestamp > lastSeenMsgTs && m.senderId !== session &&
    !(m.scheduledFor && m.scheduledFor > Date.now())
  );
  lastSeenMsgTs = Date.now();
  if (!newOnes.length) return;
  if (p.sound) try { beep(); } catch {}
  if (p.notifications && document.visibilityState !== 'visible' && Notification.permission === 'granted') {
    const m = newOnes[newOnes.length - 1];
    const chat = chats.find(c => c.id === m.chatId);
    if (chat && chat.members.includes(session)) {
      const author = displayUser(m.senderId);
      try { new Notification(`${chatTitle(chat)} · ${author.name}`, { body: lastMessagePreview(m) }); } catch {}
    }
  }
}
function beep() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.frequency.value = 700; o.type = 'sine';
  g.gain.value = 0.05; o.connect(g); g.connect(ctx.destination);
  o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 120);
}

// ===================== ЭКСПОРТ / ИМПОРТ =====================
$('btn-export-data').onclick = () => {
  const data = {};
  for (const k of Object.values(DB)) data[k] = JSON.parse(localStorage.getItem(k) || 'null');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `messenger-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Резервная копия сохранена', 'success');
};
$('import-data-input').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  if (!confirm('Импорт перезапишет ВСЕ данные. Продолжить?')) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    for (const k of Object.values(DB)) {
      if (data[k] === undefined) continue;
      if (data[k] === null) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(data[k]));
    }
    location.reload();
  } catch { toast('Не удалось импортировать данные', 'error'); }
};

// ===================== ИСТОРИИ (STORIES) =====================
function visibleStories() {
  const now = Date.now();
  return stories.filter(s => now - s.timestamp < STORY_TTL_MS);
}
function renderStoriesBar() {
  const bar = $('stories-bar');
  if (!bar || !session) return;
  bar.innerHTML = '';
  // Своя кнопка "+"
  const me_ = me();
  const my = visibleStories().filter(s => s.userId === session);
  const myAvatarHtml = `<div class="story-circle" id="my-story-add">
    <div class="story-circle-ring${my.length ? '' : ' viewed'}">
      <div class="avatar"></div>
      <div class="story-add-button"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
    </div>
    <div class="story-circle-name">Ваша история</div>
  </div>`;
  bar.insertAdjacentHTML('beforeend', myAvatarHtml);
  setAvatar(bar.querySelector('#my-story-add .avatar'), { id: me_.id, name: realName(me_), avatar: me_.avatar });
  bar.querySelector('#my-story-add').onclick = () => {
    if (my.length) openStoryViewer(session);
    else $('story-input').click();
  };

  // Stories других
  const grouped = {};
  for (const s of visibleStories()) {
    if (s.userId === session) continue;
    grouped[s.userId] = grouped[s.userId] || [];
    grouped[s.userId].push(s);
  }
  for (const userId of Object.keys(grouped)) {
    const allViewed = grouped[userId].every(s => (s.viewedBy || []).includes(session));
    const d = displayUser(userId);
    const div = document.createElement('div');
    div.className = 'story-circle';
    div.innerHTML = `<div class="story-circle-ring${allViewed ? ' viewed' : ''}">
      <div class="avatar"></div>
    </div><div class="story-circle-name">${escapeHtml(d.name)}</div>`;
    setAvatar(div.querySelector('.avatar'), d);
    div.onclick = () => openStoryViewer(userId);
    bar.appendChild(div);
  }
}
$('story-input').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) { toast('Файл больше 4 МБ', 'error'); return; }
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) { toast('Можно только фото или видео', 'error'); return; }
  const dataUrl = await fileToDataURL(file);
  stories.push({ id: uid(), userId: session, type: isImage ? 'image' : 'video', content: dataUrl, timestamp: Date.now(), viewedBy: [] });
  save(DB.stories, stories); broadcast();
  renderStoriesBar();
};

// Story viewer
let viewerUserId = null;
let viewerIndex = 0;
let viewerTimer = null;
function openStoryViewer(userId) {
  const list = visibleStories().filter(s => s.userId === userId).sort((a, b) => a.timestamp - b.timestamp);
  if (!list.length) return;
  viewerUserId = userId;
  viewerIndex = 0;
  $('story-viewer').classList.add('open');
  $('story-delete').style.display = userId === session ? '' : 'none';
  renderStoryFrame();
}
function renderStoryFrame() {
  const list = visibleStories().filter(s => s.userId === viewerUserId).sort((a, b) => a.timestamp - b.timestamp);
  if (!list.length || viewerIndex >= list.length) return closeStoryViewer();
  const s = list[viewerIndex];
  const author = displayUser(viewerUserId);
  setAvatar($('story-author-avatar'), author);
  $('story-author-name').textContent = author.name;
  const ago = Date.now() - s.timestamp;
  const h = Math.floor(ago / 3600000);
  const m = Math.floor((ago % 3600000) / 60000);
  $('story-author-time').textContent = h > 0 ? `${h} ч назад` : `${m} мин назад`;
  // прогресс-бары
  const prog = $('story-progress'); prog.innerHTML = '';
  for (let i = 0; i < list.length; i++) {
    const b = document.createElement('div');
    b.className = 'story-progress-bar' + (i < viewerIndex ? ' done' : '');
    b.innerHTML = '<div class="fill"></div>';
    prog.appendChild(b);
  }
  const content = $('story-content'); content.innerHTML = '';
  let duration = 5000;
  if (s.type === 'image') {
    content.innerHTML = `<img src="${s.content}">`;
  } else {
    content.innerHTML = `<video src="${s.content}" autoplay muted></video>`;
    const v = content.querySelector('video');
    v.onloadedmetadata = () => { duration = Math.min(v.duration * 1000, 15000); animateProgressBar(duration); };
  }
  if (s.type === 'image') animateProgressBar(duration);
  // отметить просмотренным
  if (!(s.viewedBy || []).includes(session)) {
    s.viewedBy = s.viewedBy || []; s.viewedBy.push(session);
    save(DB.stories, stories); broadcast();
  }
}
function animateProgressBar(duration) {
  if (viewerTimer) clearTimeout(viewerTimer);
  const bars = $('story-progress').querySelectorAll('.story-progress-bar');
  const cur = bars[viewerIndex];
  if (!cur) return;
  const fill = cur.querySelector('.fill');
  fill.style.transition = 'none';
  fill.style.width = '0';
  void fill.offsetWidth;
  fill.style.transition = `width ${duration}ms linear`;
  fill.style.width = '100%';
  viewerTimer = setTimeout(() => storyNext(), duration);
}
function storyNext() {
  const list = visibleStories().filter(s => s.userId === viewerUserId);
  if (viewerIndex + 1 >= list.length) closeStoryViewer();
  else { viewerIndex++; renderStoryFrame(); }
}
function storyPrev() {
  if (viewerIndex > 0) { viewerIndex--; renderStoryFrame(); }
}
function closeStoryViewer() {
  if (viewerTimer) { clearTimeout(viewerTimer); viewerTimer = null; }
  $('story-viewer').classList.remove('open');
  $('story-content').innerHTML = '';
  renderStoriesBar();
}
$('story-close').onclick = closeStoryViewer;
$('story-next').onclick = storyNext;
$('story-prev').onclick = storyPrev;
$('story-delete').onclick = () => {
  const list = visibleStories().filter(s => s.userId === viewerUserId).sort((a, b) => a.timestamp - b.timestamp);
  const cur = list[viewerIndex]; if (!cur) return;
  stories = stories.filter(s => s.id !== cur.id);
  save(DB.stories, stories); broadcast();
  renderStoriesBar();
  closeStoryViewer();
};

// Очистка устаревших историй раз в минуту
setInterval(() => {
  const fresh = load(DB.stories, []);
  const now = Date.now();
  const filtered = fresh.filter(s => now - s.timestamp < STORY_TTL_MS);
  if (filtered.length !== fresh.length) {
    save(DB.stories, filtered);
    stories = filtered; broadcast();
    if (session) renderStoriesBar();
  }
}, 60000);

// ===================== ПЛЮС-МЕНЮ КОМПОЗЕРА =====================
const plusMenu = $('plus-menu');
$('btn-plus-menu').onclick = (e) => {
  e.stopPropagation();
  closeEmojiPicker(); closeSchedule();
  plusMenu.classList.toggle('open');
  // обновим состояние "одноразовое" в плюс-меню
  $('plus-self-destruct').classList.toggle('active', pendingSelfDestruct);
};
document.addEventListener('click', (e) => {
  if (!plusMenu.contains(e.target) && e.target.closest('#btn-plus-menu') == null) {
    plusMenu.classList.remove('open');
  }
});
plusMenu.querySelectorAll('button').forEach(btn => {
  btn.onclick = () => {
    const act = btn.dataset.act;
    plusMenu.classList.remove('open');
    if (act === 'videomsg') $('btn-video-msg').click();
    else if (act === 'poll') $('btn-poll').click();
    else if (act === 'schedule') $('btn-schedule').click();
    else if (act === 'self-destruct') $('btn-self-destruct').click();
  };
});

// ===================== ЗАКРЕПЛЁННЫЕ ЧАТЫ + MUTE + UNREAD =====================
function isPinnedChat(chatId) { return (getUserPrefs().pinnedChats || []).includes(chatId); }
function isMutedChat(chatId) { return (getUserPrefs().mutedChats || []).includes(chatId); }
function getLastReadAt(chatId) { return (getUserPrefs().lastReadAt || {})[chatId] || 0; }
function setLastReadAt(chatId) {
  const p = prefs[session] || {};
  p.lastReadAt = p.lastReadAt || {};
  p.lastReadAt[chatId] = Date.now();
  prefs[session] = p;
  save(DB.prefs, prefs);
  broadcast();
}
function unreadCount(chat) {
  const last = getLastReadAt(chat.id);
  return messages.filter(m =>
    m.chatId === chat.id && m.senderId !== session && m.timestamp > last &&
    !(m.scheduledFor && m.scheduledFor > Date.now())
  ).length;
}
function totalUnread() {
  let t = 0;
  for (const c of chats) if (c.members.includes(session) && !isMutedChat(c.id)) t += unreadCount(c);
  return t;
}
function updateTitle() {
  const t = totalUnread();
  document.title = (t > 0 ? `(${t}) ` : '') + 'Мой любимый мессенджер';
}

// Контекстное меню чата (правый клик на элементе чат-листа)
const chatCtx = $('chat-ctx');
let chatCtxTargetId = null;
function attachChatCtx(el, chatId) {
  const open = (e) => {
    e.preventDefault();
    chatCtxTargetId = chatId;
    const pin = isPinnedChat(chatId), mute = isMutedChat(chatId);
    const chat = chats.find(c => c.id === chatId);
    const arch = chat && (chat.archivedBy || []).includes(session);
    $('chat-ctx-pin').querySelector('span').textContent = pin ? 'Открепить' : 'Закрепить';
    $('chat-ctx-mute').querySelector('span').textContent = mute ? 'Включить уведомления' : 'Mute';
    $('chat-ctx-archive').querySelector('span').textContent = arch ? 'Из архива' : 'В архив';
    const x = ('touches' in e ? e.touches[0].clientX : e.clientX);
    const y = ('touches' in e ? e.touches[0].clientY : e.clientY);
    chatCtx.style.left = Math.min(x, window.innerWidth - 220) + 'px';
    chatCtx.style.top = Math.min(y, window.innerHeight - 200) + 'px';
    chatCtx.classList.add('open');
  };
  el.addEventListener('contextmenu', open);
  let pt; el.addEventListener('touchstart', (e) => { pt = setTimeout(() => open(e), 500); });
  el.addEventListener('touchend', () => clearTimeout(pt));
  el.addEventListener('touchmove', () => clearTimeout(pt));
}
document.addEventListener('click', (e) => { if (!chatCtx.contains(e.target)) chatCtx.classList.remove('open'); });
$('chat-ctx-pin').onclick = () => {
  if (!chatCtxTargetId) return;
  const p = prefs[session] || {}; p.pinnedChats = p.pinnedChats || [];
  const i = p.pinnedChats.indexOf(chatCtxTargetId);
  if (i === -1) p.pinnedChats.push(chatCtxTargetId);
  else p.pinnedChats.splice(i, 1);
  prefs[session] = p; save(DB.prefs, prefs); broadcast();
  chatCtx.classList.remove('open'); renderChats();
};
$('chat-ctx-mute').onclick = () => {
  if (!chatCtxTargetId) return;
  const p = prefs[session] || {}; p.mutedChats = p.mutedChats || [];
  const i = p.mutedChats.indexOf(chatCtxTargetId);
  if (i === -1) p.mutedChats.push(chatCtxTargetId);
  else p.mutedChats.splice(i, 1);
  prefs[session] = p; save(DB.prefs, prefs); broadcast();
  chatCtx.classList.remove('open'); renderChats();
};
$('chat-ctx-archive').onclick = () => {
  if (!chatCtxTargetId) return;
  const chat = chats.find(c => c.id === chatCtxTargetId);
  if (!chat) return;
  chat.archivedBy = chat.archivedBy || [];
  const i = chat.archivedBy.indexOf(session);
  if (i === -1) chat.archivedBy.push(session); else chat.archivedBy.splice(i, 1);
  save(DB.chats, chats); broadcast();
  chatCtx.classList.remove('open'); renderChats();
};
$('chat-ctx-markread').onclick = () => {
  if (!chatCtxTargetId) return;
  setLastReadAt(chatCtxTargetId);
  chatCtx.classList.remove('open'); renderChats(); updateTitle();
};

// Переопределяем рендеринг чат-листа: сортировка с pinned сверху + бейджи + mute-иконка + ctx menu
const _origGetMyChats = getMyChats;
window.getMyChats = (includeArchived = false) => {
  const list = _origGetMyChats(includeArchived);
  // приоритет: pinned впереди (внутри — по времени)
  return list.sort((a, b) => {
    const ap = isPinnedChat(a.id), bp = isPinnedChat(b.id);
    if (ap && !bp) return -1;
    if (!ap && bp) return 1;
    return (b.lastMsg?.timestamp || b.createdAt) - (a.lastMsg?.timestamp || a.createdAt);
  });
};
// Перехватываем renderChats — после обычной отрисовки навешиваем бейджи и ctx-menu
const _origRenderChats = renderChats;
window.renderChats = function() {
  _origRenderChats();
  // дополним отрисованные элементы
  const items = document.querySelectorAll('.chat-list .chat-item');
  let idx = 0;
  const myChats = window.getMyChats();
  const query = $('search-input').value.trim().toLowerCase();
  const visible = myChats.filter(c => !query || chatTitle(c).toLowerCase().includes(query));
  for (const el of items) {
    const c = visible[idx++]; if (!c) break;
    attachChatCtx(el, c.id);
    // вставим pin-маркер + mute-иконку + бейдж непрочитанных
    const nameSpan = el.querySelector('.chat-item-name span');
    if (nameSpan && isPinnedChat(c.id)) {
      const pinPrefix = document.createElement('span');
      pinPrefix.className = 'chat-pin-marker';
      pinPrefix.textContent = '📌 ';
      el.querySelector('.chat-item-name').insertBefore(pinPrefix, el.querySelector('.chat-item-name').firstChild);
    }
    if (isMutedChat(c.id)) {
      const muteIcon = document.createElement('span');
      muteIcon.className = 'chat-mute-icon';
      muteIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>';
      el.querySelector('.chat-item-name').appendChild(muteIcon);
    }
    const cnt = unreadCount(c);
    if (cnt > 0) {
      const meta = document.createElement('div'); meta.className = 'chat-item-meta';
      const badge = document.createElement('span');
      badge.className = 'unread-badge' + (isMutedChat(c.id) ? ' muted-badge' : '');
      badge.textContent = cnt > 99 ? '99+' : cnt;
      meta.appendChild(badge);
      const oldMeta = el.querySelector('.chat-item-top .chat-item-time');
      if (oldMeta) oldMeta.replaceWith(meta);
    }
  }
  updateTitle();
};

// Пометить чат прочитанным при открытии
const _origOpenChat = openChat;
window.openChat = function(id) {
  _origOpenChat(id);
  setLastReadAt(id);
  updateTitle();
  setTimeout(() => updateScrollBtn(), 100);
};

// ===================== КНОПКА «ВНИЗ» =====================
function updateScrollBtn() {
  const box = $('messages');
  const btn = $('scroll-down-btn');
  if (!box || !btn || !currentChatId) { btn?.classList.remove('show'); return; }
  const distFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
  if (distFromBottom > 150) {
    btn.classList.add('show');
    // покажем число неучтённых сообщений (после lastReadAt, не своих)
    const last = getLastReadAt(currentChatId);
    const newOnes = messages.filter(m => m.chatId === currentChatId && m.senderId !== session && m.timestamp > last).length;
    const badge = $('scroll-badge');
    if (newOnes > 0) { badge.textContent = newOnes > 99 ? '99+' : newOnes; badge.classList.add('show'); }
    else badge.classList.remove('show');
  } else {
    btn.classList.remove('show');
  }
}
$('messages').addEventListener('scroll', updateScrollBtn);
$('scroll-down-btn').onclick = () => {
  const box = $('messages');
  box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  if (currentChatId) setLastReadAt(currentChatId);
};

// ===================== DRAG & DROP =====================
let dragCounter = 0;
const chatArea = document.querySelector('.chat-area');
const dropOverlay = $('drop-overlay');
window.addEventListener('dragover', (e) => { e.preventDefault(); });
chatArea.addEventListener('dragenter', (e) => {
  if (!currentChatId) return;
  e.preventDefault(); dragCounter++;
  dropOverlay.classList.add('show');
});
chatArea.addEventListener('dragleave', (e) => {
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('show'); }
});
chatArea.addEventListener('drop', async (e) => {
  e.preventDefault(); dragCounter = 0; dropOverlay.classList.remove('show');
  if (!currentChatId) return;
  const files = [...e.dataTransfer.files];
  for (const file of files) {
    if (file.size > 4 * 1024 * 1024) { toast(`"${file.name}" больше 4 МБ — пропущен`, 'error'); continue; }
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) { toast(`"${file.name}" — только фото/видео`, 'error'); continue; }
    try { sendMessage({ type: isImage ? 'image' : 'video', content: await fileToDataURL(file) }); } catch {}
  }
});

// ===================== ЭМОДЗИ-ПИКЕР ДЛЯ РЕАКЦИЙ =====================
const reactionEmojiGrid = $('reaction-emoji-grid');
EMOJIS.forEach(em => {
  const s = document.createElement('span');
  s.textContent = em;
  s.onclick = () => {
    if (reactionPickerTarget) {
      toggleReaction(reactionPickerTarget, em);
      $('reaction-emoji-picker').classList.remove('open');
      reactionPickerTarget = null;
    }
  };
  reactionEmojiGrid.appendChild(s);
});
let reactionPickerTarget = null;
$('reaction-more').onclick = (e) => {
  e.stopPropagation();
  if (!ctxTargetId) return;
  reactionPickerTarget = ctxTargetId;
  const picker = $('reaction-emoji-picker');
  const r = e.currentTarget.getBoundingClientRect();
  picker.style.left = Math.min(r.left, window.innerWidth - 340) + 'px';
  picker.style.top = Math.max(r.bottom + 6, 50) + 'px';
  if (r.top > window.innerHeight / 2) picker.style.top = (r.top - 290) + 'px';
  picker.classList.add('open');
  ctxMenu.classList.remove('open');
};
document.addEventListener('click', (e) => {
  if (!$('reaction-emoji-picker').contains(e.target) && e.target !== $('reaction-more')) {
    $('reaction-emoji-picker').classList.remove('open');
  }
});

// ===================== ПОДКЛЮЧЕНИЕ STORIES К enterApp =====================
const _origFinishEnter = finishEnter;
window.finishEnter = function() {
  _origFinishEnter();
  renderStoriesBar();
  updateTitle();
};

// renderMessages помечает чат прочитанным и обновляет кнопку «вниз»
const _origRenderMessages = renderMessages;
window.renderMessages = function() {
  _origRenderMessages();
  if (currentChatId) {
    setLastReadAt(currentChatId);
    setTimeout(() => updateScrollBtn(), 50);
  }
  updateTitle();
};

// Обновляем stories при reload-из-broadcast
const _origReload = reloadAllFromStorage;
window.reloadAllFromStorage = function() {
  _origReload();
  if (session) renderStoriesBar();
};

// ===================== LAST PREVIEWS / FILE / LOCATION / GAME =====================
const _origLastPreview = lastMessagePreview;
window.lastMessagePreview = function(msg) {
  if (!msg) return 'Нет сообщений';
  const tag = msg.senderId === session ? 'Вы: ' : '';
  if (msg.type === 'file') return tag + '📎 ' + (msg.fileName || 'Файл');
  if (msg.type === 'location') return tag + '📍 Местоположение';
  if (msg.type === 'game-ttt') return tag + '🎮 Крестики-нолики';
  return _origLastPreview(msg);
};

// Клики по карточке файла → скачать
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-file]');
  if (!card) return;
  const m = messages.find(x => x.id === card.dataset.file);
  if (!m) return;
  const a = document.createElement('a');
  a.href = m.content;
  a.download = m.fileName || 'file';
  a.click();
});
// Клики по локации → открыть OSM в новой вкладке
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-loc]');
  if (!card) return;
  const [lat, lng] = card.dataset.loc.split(',');
  window.open(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`, '_blank');
});

// ===================== ЛОКАЦИЯ =====================
function shareLocation() {
  if (!navigator.geolocation) { toast('Геолокация недоступна', 'error'); return; }
  if (!currentChatId) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      sendMessage({ type: 'location', lat: pos.coords.latitude, lng: pos.coords.longitude });
    },
    (err) => { toast('Не удалось определить местоположение', 'error'); },
    { enableHighAccuracy: false, timeout: 10000 }
  );
}

// ===================== КРЕСТИКИ-НОЛИКИ =====================
function checkTTT(board) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of lines) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  return board.includes('') ? null : 'draw';
}
function renderTTT(m) {
  const g = m.game || { board: ['','','','','','','','',''], turn: 'x', xUser: m.senderId, oUser: null };
  const result = checkTTT(g.board);
  const myMark = g.xUser === session ? 'x' : (g.oUser === session ? 'o' : null);
  const myTurn = result === null && myMark === g.turn;
  let cells = '';
  for (let i = 0; i < 9; i++) {
    const v = g.board[i];
    cells += `<div class="ttt-cell ${v}" data-game="${m.id}" data-cell="${i}">${v.toUpperCase()}</div>`;
  }
  let status = '';
  let statusClass = '';
  if (result === 'draw') { status = '🤝 Ничья'; statusClass = 'draw'; }
  else if (result === 'x' || result === 'o') {
    const winnerId = result === 'x' ? g.xUser : g.oUser;
    const winnerName = winnerId === session ? 'Вы' : displayUser(winnerId).name;
    status = `🏆 ${winnerName} выиграл${winnerId === session ? 'и' : ''}`;
    statusClass = winnerId === session ? 'win' : 'lose';
  } else if (!g.oUser && g.xUser !== session) {
    status = `Ход X (нажмите O чтобы присоединиться)`;
  } else if (myMark) {
    status = myTurn ? '⏰ Ваш ход' : `Ход ${g.turn.toUpperCase()}`;
  } else {
    status = `Игра между X и O`;
  }
  let html = `<div style="font-weight:600;font-size:14px;margin-bottom:4px">🎮 Крестики-нолики</div>
    <div class="ttt-board">${cells}</div>
    <div class="ttt-status ${statusClass}">${escapeHtml(status)}</div>`;
  if (result && (g.xUser === session || g.oUser === session)) {
    html += `<button class="ttt-restart" data-restart="${m.id}">Новая игра</button>`;
  }
  return html;
}
document.addEventListener('click', (e) => {
  const cell = e.target.closest('[data-cell]');
  if (cell) {
    const m = messages.find(x => x.id === cell.dataset.game); if (!m) return;
    const idx = parseInt(cell.dataset.cell, 10);
    const g = m.game; if (!g) return;
    if (checkTTT(g.board)) return;
    // если присоединение
    if (!g.oUser && g.xUser !== session && g.turn === 'o') {
      g.oUser = session;
    }
    const myMark = g.xUser === session ? 'x' : (g.oUser === session ? 'o' : null);
    if (!myMark || myMark !== g.turn || g.board[idx]) return;
    g.board[idx] = myMark;
    g.turn = myMark === 'x' ? 'o' : 'x';
    save(DB.messages, messages); broadcast();
    renderMessages();
  }
  const rs = e.target.closest('[data-restart]');
  if (rs) {
    const m = messages.find(x => x.id === rs.dataset.restart); if (!m) return;
    m.game = { board: ['','','','','','','','',''], turn: 'x', xUser: m.game.oUser || m.senderId, oUser: m.game.xUser };
    save(DB.messages, messages); broadcast(); renderMessages();
  }
});
function startTTT() {
  if (!currentChatId) return;
  sendMessage({
    type: 'game-ttt', content: '',
    game: { board: ['','','','','','','','',''], turn: 'x', xUser: session, oUser: null }
  });
}

// ===================== КОНФЕТТИ =====================
function launchConfetti() {
  const canvas = $('confetti-canvas');
  canvas.classList.add('show');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  const colors = ['#ff6b6b','#5288c1','#4ade80','#fbbf24','#a855f7','#ec4899'];
  const N = 140;
  const parts = [];
  for (let i = 0; i < N; i++) {
    parts.push({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * 200,
      vx: (Math.random() - 0.5) * 6,
      vy: 2 + Math.random() * 4,
      size: 6 + Math.random() * 6,
      color: colors[(Math.random() * colors.length) | 0],
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.3,
    });
  }
  let t0 = performance.now();
  function draw(t) {
    const dt = t - t0; t0 = t;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = 0;
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.08; p.angle += p.spin;
      if (p.y < canvas.height + 30) alive++;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size/2, -p.size/4, p.size, p.size/2);
      ctx.restore();
    }
    if (alive > 0) requestAnimationFrame(draw);
    else canvas.classList.remove('show');
  }
  requestAnimationFrame(draw);
}

// ===================== plus-menu additions =====================
const _origPlusMenuHandlers = plusMenu.querySelectorAll('button');
plusMenu.querySelectorAll('button').forEach(btn => {
  const oldOnclick = btn.onclick;
  btn.onclick = () => {
    const act = btn.dataset.act;
    plusMenu.classList.remove('open');
    if (act === 'location') shareLocation();
    else if (act === 'game-ttt') startTTT();
    else if (act === 'celebrate') { sendMessage({ type: 'text', content: '🎉 /celebrate' }); launchConfetti(); }
    else if (act === 'help') openModal('shortcuts-modal');
    else if (oldOnclick) oldOnclick();
  };
});

// Команда /celebrate в тексте → запускает конфетти у всех
const _origDoSend = doSend;
window.doSend = function() {
  const text = $('message-input').value.trim();
  if (text === '/celebrate') {
    sendMessage({ type: 'text', content: '🎉 /celebrate' });
    $('message-input').value = '';
    launchConfetti();
    return;
  }
  _origDoSend();
};
// При получении сообщения с "/celebrate" — запускаем конфетти
const _origChannelHandler = channel.onmessage;
channel.onmessage = function(e) {
  _origChannelHandler.call(this, e);
  const fresh = load(DB.messages, []);
  const last = fresh[fresh.length - 1];
  if (last && last.senderId !== session && last.type === 'text' && (last.content || '').includes('/celebrate')) {
    const chat = chats.find(c => c.id === last.chatId);
    if (chat && chat.members.includes(session)) launchConfetti();
  }
};

// ===================== ШОРТКАТЫ =====================
document.addEventListener('keydown', (e) => {
  if (!session) return;
  const inInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault(); $('btn-search-global').click();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault(); $('btn-new-chat').click();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
    e.preventDefault(); $('btn-emoji').click();
  } else if ((e.ctrlKey || e.metaKey) && e.key === '/') {
    e.preventDefault(); openModal('shortcuts-modal');
  } else if (e.key === 'Escape') {
    const openModal_ = document.querySelector('.modal.open');
    if (openModal_) openModal_.classList.remove('open');
    else if ($('story-viewer').classList.contains('open')) closeStoryViewer();
    else if ($('media-viewer').classList.contains('open')) $('media-close').click();
    else if (currentChatId && !inInput) closeChat();
  } else if (e.key === 'ArrowUp' && inInput && document.activeElement === $('message-input') && !$('message-input').value && currentChatId) {
    // редактируем последнее своё текстовое сообщение
    const mine = messages.filter(m => m.chatId === currentChatId && m.senderId === session && m.type === 'text').sort((a, b) => b.timestamp - a.timestamp)[0];
    if (mine) { ctxTargetId = mine.id; $('ctx-edit').click(); }
  }
});

// ===================== СВАЙП ДЛЯ ОТВЕТА =====================
let swipeStart = null, swipeEl = null;
document.addEventListener('touchstart', (e) => {
  const msg = e.target.closest('.msg');
  if (!msg || !msg.dataset.msgId) return;
  swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  swipeEl = msg;
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!swipeEl || !swipeStart) return;
  const dx = e.touches[0].clientX - swipeStart.x;
  const dy = e.touches[0].clientY - swipeStart.y;
  if (Math.abs(dy) > 20) { swipeStart = null; swipeEl.style.transform = ''; swipeEl = null; return; }
  if (dx > 0) {
    swipeEl.classList.add('swiping');
    swipeEl.style.transform = `translateX(${Math.min(dx, 80)}px)`;
  }
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!swipeEl) return;
  const m = swipeEl.style.transform.match(/translateX\((\d+)px\)/);
  const moved = m ? parseInt(m[1], 10) : 0;
  swipeEl.style.transform = '';
  swipeEl.classList.remove('swiping');
  if (moved > 50) {
    ctxTargetId = swipeEl.dataset.msgId;
    $('ctx-reply').click();
  }
  swipeStart = null; swipeEl = null;
});

// ===================== WEBRTC ЗВОНКИ =====================
// Сигналинг через BroadcastChannel (отдельный канал, чтобы не путать с обычным sync)
const callsChannel = new BroadcastChannel('messenger_calls');
let pc = null, localStream = null, callPeer = null, callKind = null, callIsCaller = false, callStartTime = 0, callTimerInt = null, isMuted = false;

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function showCallUI({ state, peer, kind }) {
  $('call-overlay').classList.add('show');
  $('call-state').textContent = state;
  const u = displayUser(peer);
  $('call-name').textContent = u.name;
  setAvatar($('call-avatar'), u);
  const remote = $('call-remote-video'); const local = $('call-local-video');
  if (kind === 'video') {
    remote.style.display = ''; local.style.display = '';
  } else {
    remote.style.display = 'none'; local.style.display = 'none';
  }
}
function hideCallUI() {
  $('call-overlay').classList.remove('show');
  $('call-remote-video').srcObject = null;
  $('call-local-video').srcObject = null;
  $('call-state').textContent = '';
  if (callTimerInt) { clearInterval(callTimerInt); callTimerInt = null; }
  $('call-meta').textContent = '';
}
function endCall(sendBye = true) {
  if (sendBye && callPeer) callsChannel.postMessage({ kind: 'bye', from: session, to: callPeer });
  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  callPeer = null; callKind = null; callIsCaller = false;
  isMuted = false; $('call-mute').classList.remove('active');
  hideCallUI();
}
async function startCall(peer, kind) {
  if (pc) return;
  callPeer = peer; callKind = kind; callIsCaller = true;
  showCallUI({ state: 'Вызов…', peer, kind });
  try {
    localStream = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { audio: true, video: true } : { audio: true });
    if (kind === 'video') $('call-local-video').srcObject = localStream;
  } catch (e) { toast('Нет доступа к ' + (kind === 'video' ? 'камере' : 'микрофону'), 'error'); endCall(false); return; }
  pc = new RTCPeerConnection(RTC_CONFIG);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = (e) => { $('call-remote-video').srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => { if (e.candidate) callsChannel.postMessage({ kind: 'ice', from: session, to: peer, candidate: e.candidate }); };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  callsChannel.postMessage({ kind: 'offer', from: session, to: peer, callKind: kind, sdp: offer });
}
async function answerCall() {
  showCallUI({ state: 'Подключение…', peer: callPeer, kind: callKind });
  try {
    localStream = await navigator.mediaDevices.getUserMedia(callKind === 'video' ? { audio: true, video: true } : { audio: true });
    if (callKind === 'video') $('call-local-video').srcObject = localStream;
  } catch (e) { toast('Нет доступа к устройству', 'error'); endCall(); return; }
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  callsChannel.postMessage({ kind: 'answer', from: session, to: callPeer, sdp: answer });
}
callsChannel.onmessage = async (e) => {
  const d = e.data;
  if (d.to !== session) return;
  if (d.kind === 'offer') {
    if (pc) { callsChannel.postMessage({ kind: 'busy', from: session, to: d.from }); return; }
    callPeer = d.from; callKind = d.callKind; callIsCaller = false;
    pc = new RTCPeerConnection(RTC_CONFIG);
    pc.ontrack = (ev) => { $('call-remote-video').srcObject = ev.streams[0]; };
    pc.onicecandidate = (ev) => { if (ev.candidate) callsChannel.postMessage({ kind: 'ice', from: session, to: callPeer, candidate: ev.candidate }); };
    await pc.setRemoteDescription(d.sdp);
    showCallUI({ state: 'Входящий вызов', peer: d.from, kind: d.callKind });
    $('call-answer').style.display = '';
  } else if (d.kind === 'answer') {
    if (!pc) return;
    await pc.setRemoteDescription(d.sdp);
    $('call-state').textContent = 'Идёт разговор';
    startCallTimer();
  } else if (d.kind === 'ice') {
    if (pc && d.candidate) { try { await pc.addIceCandidate(d.candidate); } catch {} }
  } else if (d.kind === 'bye') {
    endCall(false);
  } else if (d.kind === 'busy') {
    toast('Собеседник занят', 'info');
    endCall(false);
  }
};
function startCallTimer() {
  callStartTime = Date.now();
  callTimerInt = setInterval(() => {
    const s = Math.floor((Date.now() - callStartTime) / 1000);
    $('call-meta').textContent = fmtDuration(s);
  }, 1000);
}
$('call-answer').onclick = () => { $('call-answer').style.display = 'none'; answerCall(); $('call-state').textContent = 'Идёт разговор'; startCallTimer(); };
$('call-end').onclick = () => endCall(true);
$('call-mute').onclick = () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  $('call-mute').classList.toggle('active', isMuted);
};
$('btn-call-voice').onclick = () => {
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat || chat.type !== 'dm') return;
  startCall(chat.members.find(m => m !== session), 'voice');
};
$('btn-call-video').onclick = () => {
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat || chat.type !== 'dm') return;
  startCall(chat.members.find(m => m !== session), 'video');
};

// Показывать кнопки звонка только в DM
const _origOpenChat2 = openChat;
window.openChat = function(id) {
  _origOpenChat2(id);
  const chat = chats.find(c => c.id === id);
  const show = chat && chat.type === 'dm';
  $('btn-call-voice').style.display = show ? '' : 'none';
  $('btn-call-video').style.display = show ? '' : 'none';
};

// ===================== СТРОГО АНГЛИЙСКИЙ ЮЗЕРНЕЙМ =====================
function attachUsernameFilter(input, hintEl) {
  if (!input) return;
  input.addEventListener('input', (e) => {
    const before = e.target.value;
    const filtered = before.replace(/[^a-zA-Z0-9_.]/g, '');
    if (filtered !== before) {
      e.target.value = filtered;
      if (hintEl) {
        hintEl.textContent = 'Только английские буквы, цифры, _ и . — лишние удалены';
        hintEl.classList.add('error');
        clearTimeout(hintEl._t);
        hintEl._t = setTimeout(() => {
          hintEl.textContent = 'Только английские буквы, цифры, _ и .';
          hintEl.classList.remove('error');
        }, 2000);
      }
    }
  });
}
const _regUsername = $('reg-username');
const _profileUsername = $('profile-username');
attachUsernameFilter(_regUsername, _regUsername.nextElementSibling?.classList.contains('field-hint') ? _regUsername.nextElementSibling : null);
attachUsernameFilter(_profileUsername, _profileUsername.nextElementSibling?.classList.contains('field-hint') ? _profileUsername.nextElementSibling : null);

// ===================== АНИМАЦИЯ РЕАКЦИЙ =====================
// Перехватываем toggleReaction чтобы пометить новые пилюли классом .new
const _origToggleReaction = toggleReaction;
window.toggleReaction = function(msgId, emoji) {
  const before = messages.find(m => m.id === msgId);
  const wasMine = before && before.reactions && (before.reactions[emoji] || []).includes(session);
  _origToggleReaction(msgId, emoji);
  if (!wasMine) {
    // только что добавил реакцию — найдём пилюлю и проиграем pop
    setTimeout(() => {
      const msgEl = document.querySelector(`.msg[data-msg-id="${msgId}"]`);
      if (!msgEl) return;
      const pill = [...msgEl.querySelectorAll('.reaction-pill')].find(p => p.dataset.react === emoji);
      if (pill) {
        pill.classList.add('new');
        setTimeout(() => pill.classList.remove('new'), 600);
        // эффект "вспышки" над пилюлей
        const burst = document.createElement('span');
        burst.className = 'reaction-burst';
        burst.textContent = emoji;
        const r = pill.getBoundingClientRect();
        burst.style.left = (r.left + r.width / 2 - 16) + 'px';
        burst.style.top = (r.top - 10) + 'px';
        burst.style.position = 'fixed';
        document.body.appendChild(burst);
        setTimeout(() => burst.remove(), 700);
      }
    }, 30);
  }
};

// ===================== VIP =====================
$('vip-banner').onclick = () => openModal('vip-modal');
$('btn-become-vip').onclick = () => {
  // Заглушка: даём демо-режим VIP, чтобы было что показать
  const u = me(); if (!u) return;
  if (u.isVip) {
    if (confirm('Снять VIP-статус (для демо)?')) {
      u.isVip = false; save(DB.users, users);
      refreshMe(); renderChats(); broadcast();
      $('vip-banner').classList.remove('active');
      $('vip-banner-title').textContent = 'VIP-подписка';
      $('vip-banner-sub').textContent = 'Эксклюзивные фичи скоро';
      $('btn-become-vip').textContent = 'Стать VIP — скоро';
    }
    return;
  }
  if (confirm('Это демо-режим. Активировать пробный VIP-статус для тестов?')) {
    u.isVip = true; save(DB.users, users);
    refreshMe(); renderChats(); broadcast();
    $('vip-banner').classList.add('active');
    $('vip-banner-title').textContent = '👑 Вы VIP';
    $('vip-banner-sub').textContent = 'Все премиум-фичи активны';
    $('btn-become-vip').textContent = 'Отключить VIP (демо)';
    closeModal('vip-modal');
  }
};

// === VIP-метки рядом с именем (HTML-пилюля) ===
const _origDisplayUser = displayUser;
window.displayUser = function(id) {
  const d = _origDisplayUser(id);
  const real = realUser(id);
  if (real && real.isVip) {
    d.isVip = true;
    d.vipTag = (real.vipTag || '').slice(0, 12);
  }
  return d;
};
function vipBadgeHTML(d) {
  if (!d || !d.isVip) return '';
  let html = ' <span class="vip-badge">👑</span>';
  if (d.vipTag) html += `<span class="vip-tag">${escapeHtml(d.vipTag)}</span>`;
  return html;
}
function nameWithVipHTML(d) {
  if (!d) return '';
  return `${escapeHtml(d.name || '')}${vipBadgeHTML(d)}`;
}

// Перехват refreshMe — добавляем корону и приписку
const _origRefreshMe = refreshMe;
window.refreshMe = function() {
  _origRefreshMe();
  const u = me(); if (!u) return;
  $('my-name-mini').innerHTML = nameWithVipHTML({ id: u.id, name: realName(u), isVip: !!u.isVip, vipTag: (u.vipTag || '').slice(0, 12), isAdmin: !!u.isAdmin });
};

// Перехват renderChats — обновляем имена в списке чатов с VIP-меткой
const _origRenderChats2 = renderChats;
window.renderChats = function() {
  _origRenderChats2();
  document.querySelectorAll('.chat-list .chat-item').forEach(item => {
    const nameSpan = item.querySelector('.chat-item-name span');
    if (!nameSpan) return;
    // Узнаём чат по тексту — не идеально, но работает для нашей структуры
  });
  // Лучше — перерисуем заново с правильными именами
  const list = $('chat-list');
  const items = list.querySelectorAll('.chat-item');
  const visible = getMyChats().filter(c => {
    const q = $('search-input').value.trim().toLowerCase();
    return !q || chatTitle(c).toLowerCase().includes(q);
  });
  items.forEach((el, i) => {
    const c = visible[i]; if (!c) return;
    const nameSpan = el.querySelector('.chat-item-name span');
    if (!nameSpan) return;
    if (c.type === 'dm') {
      const d = displayUser(c.members.find(m => m !== session));
      nameSpan.innerHTML = nameWithVipHTML(d);
    }
  });
};

// Перехват openChat — обновляем имя в шапке (для DM) с VIP-меткой
const _origOpenChat3 = openChat;
window.openChat = function(id) {
  _origOpenChat3(id);
  const chat = chats.find(c => c.id === id);
  if (!chat || chat.type !== 'dm') return;
  const d = displayUser(chat.members.find(m => m !== session));
  $('chat-header-name').innerHTML = nameWithVipHTML(d);
};

// Перехват renderMessages — обновляем имя отправителя в групповых сообщениях
const _origRenderMessages2 = renderMessages;
window.renderMessages = function() {
  _origRenderMessages2();
  // переписываем msg-sender блоки с VIP-меткой
  if (!currentChatId) return;
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat || chat.type !== 'group') return;
  document.querySelectorAll('#messages .msg').forEach(el => {
    const senderEl = el.querySelector('.msg-sender');
    if (!senderEl) return;
    const id = el.dataset.msgId;
    const m = messages.find(x => x.id === id);
    if (!m) return;
    senderEl.innerHTML = nameWithVipHTML(displayUser(m.senderId));
  });
};

// Открытие профиля — показываем поле VIP-приписки, если VIP
const _origOpenProfile = $('btn-profile').onclick;
$('btn-profile').onclick = () => {
  _origOpenProfile();
  const u = me();
  const row = $('profile-vip-tag-row');
  if (u && u.isVip) {
    row.style.display = '';
    $('profile-vip-tag').value = (u.vipTag || '').slice(0, 12);
  } else {
    row.style.display = 'none';
  }
};
// Лайв-ограничение длины + срез всего что больше 12 символов
$('profile-vip-tag').addEventListener('input', (e) => {
  if (e.target.value.length > 12) e.target.value = e.target.value.slice(0, 12);
});

// Сохранение профиля — записываем vipTag
const _origSaveProfile = $('btn-save-profile').onclick;
$('btn-save-profile').onclick = function() {
  const u = me();
  if (u && u.isVip) {
    const tag = $('profile-vip-tag').value.slice(0, 12);
    u.vipTag = tag;
    save(DB.users, users);
    broadcast();
  }
  _origSaveProfile.call(this);
};

// При (де)активации VIP — управляем видимостью поля
const _origBecomeVip = $('btn-become-vip').onclick;
$('btn-become-vip').onclick = function() {
  _origBecomeVip.call(this);
  // подождём пока обработчик отработает
  setTimeout(() => {
    const u = me();
    const row = $('profile-vip-tag-row');
    if (!row) return;
    if (u && u.isVip) {
      row.style.display = '';
      $('profile-vip-tag').value = (u.vipTag || '').slice(0, 12);
    } else {
      row.style.display = 'none';
      u && delete u.vipTag;
      save(DB.users, users);
      broadcast();
    }
  }, 0);
};

// ===================== UI-НАСТРОЙКИ =====================
const UI_DEFAULTS = { hints: true, labels: false, animations: true, compact: false, enterSend: true, largeText: false };
function getUISettings() {
  const p = getUserPrefs();
  return { ...UI_DEFAULTS, ...(p.ui || {}) };
}
function getUISetting(key, fallback) {
  const ui = getUISettings();
  return key in ui ? ui[key] : fallback;
}
function setUISetting(key, value) {
  const p = prefs[session] || {};
  p.ui = { ...UI_DEFAULTS, ...(p.ui || {}), [key]: value };
  prefs[session] = p;
  save(DB.prefs, prefs);
  applyUISettings();
}
function applyUISettings() {
  const ui = getUISettings();
  document.body.classList.toggle('show-labels', !!ui.labels);
  document.body.classList.toggle('compact', !!ui.compact);
  document.body.classList.toggle('large-text', !!ui.largeText);
  document.body.classList.toggle('no-anim', !ui.animations);
  document.body.classList.toggle('hide-hints', !ui.hints);
}
function syncSettingsUI() {
  const ui = getUISettings();
  if ($('toggle-hints')) $('toggle-hints').checked = !!ui.hints;
  if ($('toggle-labels')) $('toggle-labels').checked = !!ui.labels;
  if ($('toggle-animations')) $('toggle-animations').checked = !!ui.animations;
  if ($('toggle-compact')) $('toggle-compact').checked = !!ui.compact;
  if ($('toggle-enter-send')) $('toggle-enter-send').checked = !!ui.enterSend;
  if ($('toggle-large-text')) $('toggle-large-text').checked = !!ui.largeText;
}
// Обработчики тумблеров
const _bindToggle = (id, key) => { const el = $(id); if (el) el.onchange = (e) => setUISetting(key, e.target.checked); };
_bindToggle('toggle-hints', 'hints');
_bindToggle('toggle-labels', 'labels');
_bindToggle('toggle-animations', 'animations');
_bindToggle('toggle-compact', 'compact');
_bindToggle('toggle-enter-send', 'enterSend');
_bindToggle('toggle-large-text', 'largeText');

// Применяем UI-настройки при входе и синхронизируем тумблеры при открытии профиля
const _finishEnterUI = window.finishEnter || finishEnter;
window.finishEnter = function() {
  _finishEnterUI();
  applyUISettings();
  setTimeout(() => maybeStartOnboarding(), 600);
};
const _openProfileUI = $('btn-profile').onclick;
$('btn-profile').onclick = function() {
  _openProfileUI();
  syncSettingsUI();
};

// ===================== КНОПКА «НАЗАД» (МОБИЛЬНАЯ) =====================
$('btn-back').onclick = (e) => {
  e.stopPropagation();
  closeChat();
  document.querySelector('.sidebar')?.classList.remove('hidden-mobile');
  document.querySelector('.chat-area')?.classList.remove('show-mobile');
};
// На мобиле при открытии чата прячем сайдбар
const _openChatMobile = window.openChat || openChat;
window.openChat = function(id) {
  _openChatMobile(id);
  if (window.innerWidth <= 760) {
    document.querySelector('.sidebar')?.classList.add('hidden-mobile');
    document.querySelector('.chat-area')?.classList.add('show-mobile');
  }
};

// ===================== ВИДИМЫЕ КНОПКИ МЕНЮ =====================
// На чатах в сайдбаре
const _renderChatsMenus = window.renderChats || renderChats;
window.renderChats = function() {
  _renderChatsMenus();
  if (matchMedia('(hover: none)').matches) return;
  const items = document.querySelectorAll('.chat-list .chat-item');
  const query = $('search-input').value.trim().toLowerCase();
  const visible = getMyChats().filter(c => !query || chatTitle(c).toLowerCase().includes(query));
  items.forEach((el, i) => {
    const c = visible[i]; if (!c) return;
    if (el.querySelector('.chat-item-menu-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'chat-item-menu-btn';
    btn.title = 'Действия с чатом';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>';
    btn.onclick = (e) => {
      e.stopPropagation();
      const r = btn.getBoundingClientRect();
      openChatCtxAt(c.id, r.left - 180, r.bottom + 4);
    };
    el.appendChild(btn);
  });
};
// Открыть chat-ctx в координатах (нужна функция из ранее)
function openChatCtxAt(chatId, x, y) {
  chatCtxTargetId = chatId;
  const pin = isPinnedChat(chatId), mute = isMutedChat(chatId);
  const chat = chats.find(c => c.id === chatId);
  const arch = chat && (chat.archivedBy || []).includes(session);
  $('chat-ctx-pin').querySelector('span').textContent = pin ? 'Открепить' : 'Закрепить';
  $('chat-ctx-mute').querySelector('span').textContent = mute ? 'Включить уведомления' : 'Без звука';
  $('chat-ctx-archive').querySelector('span').textContent = arch ? 'Из архива' : 'В архив';
  const menu = $('chat-ctx');
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - 220)) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 200) + 'px';
  menu.classList.add('open');
}

// На сообщениях
const _renderMessagesMenus = window.renderMessages || renderMessages;
window.renderMessages = function() {
  _renderMessagesMenus();
  if (matchMedia('(hover: none)').matches) return;
  document.querySelectorAll('#messages .msg').forEach(el => {
    if (el.querySelector('.msg-menu-btn')) return;
    if (el.classList.contains('cmd-me')) return;
    const btn = document.createElement('button');
    btn.className = 'msg-menu-btn';
    btn.title = 'Действия';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>';
    btn.onclick = (e) => {
      e.stopPropagation();
      const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY });
      el.dispatchEvent(evt);
    };
    el.appendChild(btn);
  });
};

// ===================== ОНБОРДИНГ-ТУР =====================
const ONBOARDING_STEPS = [
  { emoji: '👋', title: 'Добро пожаловать!', text: 'Это ваш мессенджер. Давайте за минуту покажу, где что находится.', target: null },
  { emoji: '✏️', title: 'Новый чат', text: 'Нажмите сюда, чтобы начать личный диалог с другим пользователем.', target: '#btn-new-chat' },
  { emoji: '👥', title: 'Группы и каналы', text: 'Создавайте групповые чаты или каналы для публикации контента.', target: '#btn-new-group' },
  { emoji: '📸', title: 'Истории', text: 'Делитесь моментами — они исчезнут через 24 часа.', target: '#stories-bar' },
  { emoji: '🔍', title: 'Поиск', text: 'Ищите по всем сообщениям сразу. Подсказка: Ctrl+K.', target: '#btn-search-global' },
  { emoji: '⚙️', title: 'Профиль и настройки', text: 'Здесь меняются тема, имя, аватар и настройки приложения. Загляните!', target: '#btn-profile' },
];
let onboardingStep = 0;
function maybeStartOnboarding() {
  const p = getUserPrefs();
  if (p.onboarded) return;
  startOnboarding();
}
function startOnboarding() {
  onboardingStep = 0;
  $('onboarding').style.display = 'block';
  renderOnboardingStep();
}
function renderOnboardingStep() {
  const step = ONBOARDING_STEPS[onboardingStep];
  if (!step) return finishOnboarding();
  $('onboarding-emoji').textContent = step.emoji;
  $('onboarding-title').textContent = step.title;
  $('onboarding-text').textContent = step.text;
  $('onboarding-next').textContent = onboardingStep === ONBOARDING_STEPS.length - 1 ? 'Понятно!' : 'Далее';
  // точки
  const dots = $('onboarding-dots'); dots.innerHTML = '';
  ONBOARDING_STEPS.forEach((_, i) => {
    const d = document.createElement('span');
    if (i === onboardingStep) d.className = 'active';
    dots.appendChild(d);
  });
  // спотлайт + позиция карточки
  const spot = $('onboarding-spotlight');
  const card = $('onboarding-card');
  const backdrop = document.querySelector('.onboarding-backdrop');
  const target = step.target ? document.querySelector(step.target) : null;
  // снимаем подсветку с предыдущего элемента
  clearOnboardHighlight();
  if (target) {
    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.classList.add('show');
    spot.style.left = (r.left - pad) + 'px';
    spot.style.top = (r.top - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';
    // фон затемняет сама подсветка (большая тень) — отдельный backdrop убираем
    if (backdrop) backdrop.style.opacity = '0';
    // поднимаем элемент над оверлеем, чтобы он был ярко виден
    onboardHighlightEl = target;
    onboardPrevStyle = { position: target.style.position, zIndex: target.style.zIndex, borderRadius: target.style.borderRadius };
    const cs = getComputedStyle(target);
    if (cs.position === 'static') target.style.position = 'relative';
    target.style.zIndex = '2502';
    target.style.borderRadius = target.style.borderRadius || '12px';
    // карточка снизу или справа от элемента
    let cx = r.left;
    let cy = r.bottom + 14;
    if (cy + 240 > window.innerHeight) cy = Math.max(14, r.top - 240);
    if (cx + 300 > window.innerWidth) cx = window.innerWidth - 314;
    card.style.left = Math.max(14, cx) + 'px';
    card.style.top = cy + 'px';
    card.style.transform = 'none';
  } else {
    spot.classList.remove('show');
    if (backdrop) backdrop.style.opacity = '1';
    card.style.left = '50%';
    card.style.top = '50%';
    card.style.transform = 'translate(-50%, -50%)';
  }
}
let onboardHighlightEl = null, onboardPrevStyle = null;
function clearOnboardHighlight() {
  if (onboardHighlightEl && onboardPrevStyle) {
    onboardHighlightEl.style.position = onboardPrevStyle.position || '';
    onboardHighlightEl.style.zIndex = onboardPrevStyle.zIndex || '';
    onboardHighlightEl.style.borderRadius = onboardPrevStyle.borderRadius || '';
  }
  onboardHighlightEl = null; onboardPrevStyle = null;
}
function finishOnboarding() {
  clearOnboardHighlight();
  const backdrop = document.querySelector('.onboarding-backdrop');
  if (backdrop) backdrop.style.opacity = '1';
  $('onboarding').style.display = 'none';
  setUserPref('onboarded', true);
}
$('onboarding-next').onclick = () => {
  onboardingStep++;
  if (onboardingStep >= ONBOARDING_STEPS.length) finishOnboarding();
  else renderOnboardingStep();
};
$('onboarding-skip').onclick = finishOnboarding;
$('btn-replay-tour').onclick = () => {
  closeModal('profile-modal');
  setTimeout(() => startOnboarding(), 250);
};
window.addEventListener('resize', () => {
  if ($('onboarding').style.display === 'block') renderOnboardingStep();
});

// =====================================================================
// ===================== БОЛЬШОЙ БАТЧ ФИЧ ==============================
// =====================================================================

// ---------- SAVED MESSAGES ----------
function savedChatId() { return 'saved_' + session; }
function ensureSavedChat() {
  if (!session) return;
  if (!chats.find(c => c.id === savedChatId())) {
    chats.push({ id: savedChatId(), type: 'saved', name: 'Избранное', members: [session], createdAt: Date.now() });
    save(DB.chats, chats);
  }
}
// chatTitle / avatar / preview для saved
const _ct_saved = chatTitle;
chatTitle = function(chat) {
  if (chat && chat.type === 'saved') return 'Избранное (заметки)';
  return _ct_saved(chat);
};
const _sca_saved = setChatAvatar;
setChatAvatar = function(el, chat) {
  if (chat && chat.type === 'saved') {
    const isLarge = el.classList.contains('avatar-large');
    el.className = 'avatar' + (isLarge ? ' avatar-large' : '') + ' color-2';
    el.style.backgroundImage = ''; el.textContent = '🔖';
    return;
  }
  return _sca_saved(el, chat);
};

// ---------- ПАПКИ ----------
let activeFolder = 'all';
function getFolders() { return (getUserPrefs().folders || []); }
function saveFolders(folders) {
  const p = prefs[session] || {}; p.folders = folders; prefs[session] = p;
  save(DB.prefs, prefs); broadcast();
}
function chatInFolder(chatId, folderId) {
  if (folderId === 'all') return true;
  if (folderId === 'unread') { const c = chats.find(x => x.id === chatId); return c && unreadCount(c) > 0; }
  const f = getFolders().find(f => f.id === folderId);
  return f ? (f.chatIds || []).includes(chatId) : true;
}
function renderFolderTabs() {
  const bar = $('folder-tabs');
  if (!bar) return;
  const folders = getFolders();
  bar.innerHTML = '';
  const tabs = [{ id: 'all', name: 'Все', icon: '💬' }, { id: 'unread', name: 'Непрочит.', icon: '●' }, ...folders];
  // Скрываем панель если папок нет (только дефолтные «Все/Непрочит.»)
  if (folders.length === 0) { bar.style.display = 'none'; } else { bar.style.display = 'flex'; }
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'folder-tab' + (activeFolder === t.id ? ' active' : '');
    let count = '';
    if (t.id !== 'all') {
      const n = getMyChats().filter(c => chatInFolder(c.id, t.id)).length;
      if (n > 0) count = `<span class="folder-count">${n}</span>`;
    }
    el.innerHTML = `<span>${t.icon || '📁'}</span> ${escapeHtml(t.name)} ${count}`;
    el.onclick = () => { activeFolder = t.id; renderFolderTabs(); renderChats(); };
    bar.appendChild(el);
  }
  // кнопка добавления папки
  const add = document.createElement('div');
  add.className = 'folder-tab-add';
  add.title = 'Управление папками';
  add.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  add.onclick = openFoldersModal;
  bar.appendChild(add);
}

// Модалка управления папками
$('btn-manage-folders') && ($('btn-manage-folders').onclick = () => { closeModal('profile-modal'); openFoldersModal(); });
function openFoldersModal() {
  renderFoldersList();
  $('new-folder-name').value = ''; $('new-folder-icon').value = '';
  $('folder-error').textContent = '';
  openModal('folders-modal');
}
function renderFoldersList() {
  const list = $('folders-list');
  const folders = getFolders();
  if (!folders.length) { list.innerHTML = '<div class="user-list-empty">Папок пока нет. Создайте первую ниже.</div>'; return; }
  list.innerHTML = '';
  for (const f of folders) {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.innerHTML = `<span class="folder-emoji">${escapeHtml(f.icon || '📁')}</span>
      <span class="folder-row-name"></span>
      <span class="folder-row-count">${(f.chatIds || []).length} чат(ов)</span>
      <button class="ren">✎</button><button class="del">🗑</button>`;
    row.querySelector('.folder-row-name').textContent = f.name;
    row.querySelector('.ren').onclick = () => {
      const nn = prompt('Новое название папки:', f.name);
      if (nn && nn.trim()) { f.name = nn.trim().slice(0, 20); saveFolders(folders); renderFoldersList(); renderFolderTabs(); }
    };
    row.querySelector('.del').onclick = () => {
      if (confirm(`Удалить папку «${f.name}»? Чаты останутся.`)) {
        const next = folders.filter(x => x.id !== f.id);
        if (activeFolder === f.id) activeFolder = 'all';
        saveFolders(next); renderFoldersList(); renderFolderTabs(); renderChats();
      }
    };
    list.appendChild(row);
  }
}
$('btn-add-folder').onclick = () => {
  const name = $('new-folder-name').value.trim();
  const icon = $('new-folder-icon').value.trim() || '📁';
  if (!name) { $('folder-error').textContent = 'Введите название папки'; return; }
  const folders = getFolders();
  folders.push({ id: uid(), name: name.slice(0, 20), icon: icon.slice(0, 2), chatIds: [] });
  saveFolders(folders);
  $('new-folder-name').value = ''; $('new-folder-icon').value = '';
  renderFoldersList(); renderFolderTabs();
  toast('Папка создана', 'success');
};

// Назначение чата в папки (из контекстного меню чата)
$('chat-ctx-folder').onclick = () => {
  $('chat-ctx').classList.remove('open');
  if (!chatCtxTargetId) return;
  const folders = getFolders();
  if (!folders.length) { toast('Сначала создайте папку', 'info'); openFoldersModal(); return; }
  const list = $('assign-folder-list');
  list.innerHTML = '';
  for (const f of folders) {
    const inIt = (f.chatIds || []).includes(chatCtxTargetId);
    const item = document.createElement('div');
    item.className = 'assign-folder-item' + (inIt ? ' in' : '');
    item.innerHTML = `<span>${escapeHtml(f.icon || '📁')}</span><span>${escapeHtml(f.name)}</span><span class="check">✓</span>`;
    item.onclick = () => {
      f.chatIds = f.chatIds || [];
      const i = f.chatIds.indexOf(chatCtxTargetId);
      if (i === -1) f.chatIds.push(chatCtxTargetId); else f.chatIds.splice(i, 1);
      saveFolders(folders);
      item.classList.toggle('in');
      renderFolderTabs();
    };
    list.appendChild(item);
  }
  openModal('assign-folder-modal');
};

// Интеграция: фильтр по активной папке + saved-чат всегда сверху
const _getMyChatsFolder = window.getMyChats || getMyChats;
window.getMyChats = function(includeArchived = false) {
  let list = _getMyChatsFolder(includeArchived);
  // saved-чат закрепляем сверху всегда
  list.sort((a, b) => {
    if (a.type === 'saved') return -1;
    if (b.type === 'saved') return 1;
    return 0;
  });
  return list;
};
const _renderChatsFolder = window.renderChats || renderChats;
window.renderChats = function() {
  // временно отфильтруем DOM по папке: переопределим через подмену getMyChats на время
  _renderChatsFolder();
  if (activeFolder !== 'all') {
    // скрываем элементы не из папки
    const visible = window.getMyChats().filter(c => {
      const q = $('search-input').value.trim().toLowerCase();
      return !q || chatTitle(c).toLowerCase().includes(q);
    });
    const items = document.querySelectorAll('.chat-list .chat-item');
    items.forEach((el, i) => {
      const c = visible[i];
      if (c && !chatInFolder(c.id, activeFolder)) el.style.display = 'none';
    });
    // если всё скрыто — подсказка
    const anyVisible = [...items].some(el => el.style.display !== 'none');
    if (!anyVisible && items.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-item-empty';
      empty.textContent = 'В этой папке пока нет чатов';
      $('chat-list').appendChild(empty);
    }
  }
  renderFolderTabs();
};

// ---------- ПОИСК В ЧАТЕ ----------
let chatSearchHits = [];
let chatSearchPos = -1;
$('btn-chat-search').onclick = () => {
  const bar = $('chat-search-bar');
  bar.classList.toggle('show');
  if (bar.classList.contains('show')) { $('chat-search-input').value = ''; $('chat-search-input').focus(); $('chat-search-count').textContent = ''; chatSearchHits = []; }
  else clearChatSearch();
};
$('chat-search-close').onclick = () => { $('chat-search-bar').classList.remove('show'); clearChatSearch(); };
$('chat-search-input').addEventListener('input', runChatSearch);
$('chat-search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); chatSearchStep(e.shiftKey ? -1 : 1); } });
$('chat-search-next').onclick = () => chatSearchStep(1);
$('chat-search-prev').onclick = () => chatSearchStep(-1);
function clearChatSearch() {
  document.querySelectorAll('#messages .msg.search-hit').forEach(el => el.classList.remove('search-hit'));
  chatSearchHits = []; chatSearchPos = -1; $('chat-search-count').textContent = '';
}
function runChatSearch() {
  const q = $('chat-search-input').value.trim().toLowerCase();
  document.querySelectorAll('#messages .msg.search-hit').forEach(el => el.classList.remove('search-hit'));
  chatSearchHits = []; chatSearchPos = -1;
  if (!q) { $('chat-search-count').textContent = ''; return; }
  document.querySelectorAll('#messages .msg').forEach(el => {
    if (el.textContent.toLowerCase().includes(q)) chatSearchHits.push(el);
  });
  $('chat-search-count').textContent = chatSearchHits.length ? `1/${chatSearchHits.length}` : '0';
  if (chatSearchHits.length) chatSearchStep(1);
}
function chatSearchStep(dir) {
  if (!chatSearchHits.length) return;
  document.querySelectorAll('#messages .msg.search-hit').forEach(el => el.classList.remove('search-hit'));
  chatSearchPos = (chatSearchPos + dir + chatSearchHits.length) % chatSearchHits.length;
  const el = chatSearchHits[chatSearchPos];
  el.classList.add('search-hit');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('chat-search-count').textContent = `${chatSearchPos + 1}/${chatSearchHits.length}`;
}

// ---------- ИНФО ГРУППЫ / УЧАСТНИКИ ----------
$('btn-chat-info').onclick = openGroupInfo;
function openGroupInfo() {
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat || chat.type !== 'group') return;
  setChatAvatar($('group-info-avatar'), chat);
  $('group-info-name').textContent = chat.name;
  $('group-info-count').textContent = `${chat.members.length} участников`;
  const isOwner = chat.ownerId ? chat.ownerId === session : chat.members[0] === session;
  renderGroupMembers(chat, isOwner);
  $('btn-add-members').style.display = isOwner ? '' : 'none';
  $('add-members-block').style.display = 'none';
  openModal('group-info-modal');
}
function renderGroupMembers(chat, isOwner) {
  const list = $('group-members-list');
  list.innerHTML = '';
  const ownerId = chat.ownerId || chat.members[0];
  for (const mid of chat.members) {
    const d = displayUser(mid);
    const item = document.createElement('div');
    item.className = 'user-list-item member-item';
    const isMe = mid === session;
    const role = mid === ownerId ? '<span class="member-role">владелец</span>' : '';
    const kick = (isOwner && !isMe && mid !== ownerId) ? `<button class="member-kick" data-kick="${mid}">Удалить</button>` : '';
    item.innerHTML = `<div class="avatar"></div><div class="user-list-item-name">${escapeHtml(d.name)}${isMe ? ' (вы)' : ''}</div>${role}${kick}`;
    setAvatar(item.querySelector('.avatar'), d);
    const kb = item.querySelector('[data-kick]');
    if (kb) kb.onclick = () => {
      chat.members = chat.members.filter(x => x !== mid);
      save(DB.chats, chats); broadcast();
      renderGroupMembers(chat, isOwner);
      $('group-info-count').textContent = `${chat.members.length} участников`;
      toast('Участник удалён', 'info');
    };
    list.appendChild(item);
  }
}
$('btn-add-members').onclick = () => {
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat) return;
  const block = $('add-members-block');
  const list = $('add-members-list');
  list.innerHTML = '';
  const candidates = users.filter(u => u.id !== session && !chat.members.includes(u.id));
  if (!candidates.length) { list.innerHTML = '<div class="user-list-empty">Все уже в группе</div>'; }
  for (const u of candidates) {
    const d = displayUser(u.id);
    const item = document.createElement('div');
    item.className = 'user-list-item';
    item.innerHTML = `<div class="avatar"></div><div class="user-list-item-name">${escapeHtml(d.name)}</div><input type="checkbox" data-uid="${u.id}">`;
    setAvatar(item.querySelector('.avatar'), d);
    item.onclick = (e) => { if (e.target.tagName !== 'INPUT') { const cb = item.querySelector('input'); cb.checked = !cb.checked; } };
    list.appendChild(item);
  }
  block.style.display = block.style.display === 'none' ? 'block' : 'none';
};
$('btn-confirm-add-members').onclick = () => {
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat) return;
  const checked = [...$('add-members-list').querySelectorAll('input:checked')].map(cb => cb.dataset.uid);
  if (!checked.length) { toast('Никто не выбран', 'info'); return; }
  chat.members.push(...checked);
  save(DB.chats, chats); broadcast();
  renderGroupMembers(chat, true);
  $('group-info-count').textContent = `${chat.members.length} участников`;
  $('add-members-block').style.display = 'none';
  toast(`Добавлено: ${checked.length}`, 'success');
};
$('btn-leave-group').onclick = () => {
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat) return;
  if (!confirm(`Покинуть «${chat.name}»?`)) return;
  chat.members = chat.members.filter(x => x !== session);
  save(DB.chats, chats); broadcast();
  closeModal('group-info-modal');
  closeChat(); renderChats();
  toast('Вы покинули группу', 'info');
};

// ---------- АЛЬБОМЫ ----------
$('album-input').onchange = async (e) => {
  const files = [...e.target.files].slice(0, 10); e.target.value = '';
  if (!files.length || !currentChatId) return;
  const urls = [];
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    if (f.size > 4 * 1024 * 1024) { toast(`"${f.name}" больше 4 МБ — пропущен`, 'error'); continue; }
    urls.push(await fileToDataURL(f));
  }
  if (!urls.length) return;
  if (urls.length === 1) sendMessage({ type: 'image', content: urls[0] });
  else sendMessage({ type: 'album', album: urls, content: '' });
};
// клики по фото в альбоме
document.addEventListener('click', (e) => {
  const img = e.target.closest('[data-album]');
  if (!img) return;
  const m = messages.find(x => x.id === img.dataset.album);
  if (!m || !m.album) return;
  albumLightbox(m.album, parseInt(img.dataset.idx, 10) || 0);
});
function albumLightbox(urls, start) {
  let idx = start;
  const show = () => openMedia(urls[idx], 'img');
  show();
  // навешиваем стрелки на media-viewer (просто переключаем по клику на края — упрощённо: клик по картинке = следующая)
  const mc = $('media-content');
  mc.onclick = (e) => { e.stopPropagation(); idx = (idx + 1) % urls.length; openMedia(urls[idx], 'img'); };
}

// ---------- УПОМИНАНИЯ @ (автодополнение) ----------
const mentionBox = $('mention-box');
let mentionActive = false, mentionStart = -1, mentionSel = 0, mentionMatches = [];
$('message-input').addEventListener('input', () => {
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat || chat.type !== 'group') { hideMention(); return; }
  const input = $('message-input');
  const val = input.value;
  const pos = input.selectionStart;
  const upto = val.slice(0, pos);
  const m = upto.match(/@([a-zA-Z0-9_.]*)$/);
  if (!m) { hideMention(); return; }
  mentionStart = pos - m[0].length;
  const q = m[1].toLowerCase();
  mentionMatches = chat.members
    .filter(id => id !== session)
    .map(id => displayUser(id))
    .filter(d => d.username.toLowerCase().includes(q) || d.name.toLowerCase().includes(q))
    .slice(0, 6);
  if (!mentionMatches.length) { hideMention(); return; }
  mentionSel = 0; mentionActive = true;
  renderMentionBox();
});
function renderMentionBox() {
  mentionBox.innerHTML = '';
  mentionMatches.forEach((d, i) => {
    const item = document.createElement('div');
    item.className = 'mention-item' + (i === mentionSel ? ' sel' : '');
    item.innerHTML = `<div class="avatar"></div><div><div class="mi-name">${escapeHtml(d.name)}</div><div class="mi-handle">@${escapeHtml(d.username)}</div></div>`;
    setAvatar(item.querySelector('.avatar'), d);
    item.onclick = () => insertMention(d);
    mentionBox.appendChild(item);
  });
  mentionBox.classList.add('show');
}
function hideMention() { mentionActive = false; mentionBox.classList.remove('show'); }
function insertMention(d) {
  const input = $('message-input');
  const val = input.value;
  const pos = input.selectionStart;
  input.value = val.slice(0, mentionStart) + '@' + d.username + ' ' + val.slice(pos);
  hideMention();
  input.focus();
}
$('message-input').addEventListener('keydown', (e) => {
  if (!mentionActive) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); mentionSel = (mentionSel + 1) % mentionMatches.length; renderMentionBox(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); mentionSel = (mentionSel - 1 + mentionMatches.length) % mentionMatches.length; renderMentionBox(); }
  else if (e.key === 'Enter') { e.preventDefault(); insertMention(mentionMatches[mentionSel]); }
  else if (e.key === 'Escape') hideMention();
}, true);
// уведомление при упоминании
const _sendMsgMention = sendMessage;
sendMessage = function(payload) {
  _sendMsgMention(payload);
  if (payload.type === 'text' && payload.content) {
    const mentioned = [...payload.content.matchAll(/@([a-zA-Z0-9_.]+)/g)].map(m => m[1].toLowerCase());
    if (mentioned.length) {
      const chat = chats.find(c => c.id === currentChatId);
      // (уведомление получит упомянутый при синхронизации; здесь просто тост-подтверждение)
      const names = mentioned.filter(u => users.find(x => x.username.toLowerCase() === u));
      if (names.length) toast(`Упомянуты: ${names.map(n => '@' + n).join(', ')}`, 'info', 1800);
    }
  }
};

// ---------- ВИКТОРИНА (режим в модалке опроса) ----------
(function addQuizToggle() {
  const pollBody = document.querySelector('#poll-modal .modal-body');
  if (!pollBody || $('poll-quiz-toggle')) return;
  const multiRow = pollBody.querySelector('.toggle-row');
  const row = document.createElement('div');
  row.className = 'toggle-row';
  row.innerHTML = `<span>Режим викторины (есть правильный ответ)</span><input type="checkbox" id="poll-quiz-toggle">`;
  if (multiRow) multiRow.after(row); else pollBody.appendChild(row);
  $('poll-quiz-toggle').onchange = (e) => {
    document.querySelectorAll('#poll-options .poll-option-input').forEach(inp => {
      inp.classList.toggle('quiz-mode', e.target.checked);
    });
    toast(e.target.checked ? 'Отметьте правильный вариант галочкой слева' : 'Обычный опрос', 'info', 2000);
    renderQuizRadios(e.target.checked);
  };
})();
function renderQuizRadios(on) {
  document.querySelectorAll('#poll-options .quiz-radio').forEach(r => r.remove());
  if (!on) return;
  document.querySelectorAll('#poll-options .poll-option-input').forEach((inp, i) => {
    if (inp.previousElementSibling?.classList?.contains('quiz-radio')) return;
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'quiz-correct'; radio.className = 'quiz-radio';
    radio.value = i; radio.style.cssText = 'width:18px;height:18px;accent-color:var(--online);margin-right:6px;vertical-align:middle';
    inp.parentNode.insertBefore(radio, inp);
  });
}
// перехват создания опроса для quiz
const _origCreatePoll = $('btn-create-poll').onclick;
$('btn-create-poll').onclick = function() {
  const quizOn = $('poll-quiz-toggle') && $('poll-quiz-toggle').checked;
  if (quizOn) {
    const q = $('poll-question').value.trim();
    const opts = [...$('poll-options').querySelectorAll('.poll-option-input')].map(i => i.value.trim()).filter(Boolean);
    if (!q || opts.length < 2) { $('poll-error').textContent = 'Вопрос и минимум 2 варианта.'; return; }
    const correctRadio = document.querySelector('#poll-options input[name="quiz-correct"]:checked');
    if (!correctRadio) { $('poll-error').textContent = 'Отметьте правильный ответ.'; return; }
    const correct = parseInt(correctRadio.value, 10);
    sendMessage({ type: 'poll', poll: { question: q, quiz: true, correct, multi: false, options: opts.map(t => ({ text: t, votes: [] })) }, content: '' });
    closeModal('poll-modal');
    return;
  }
  _origCreatePoll.call(this);
};

// ---------- НАСТРОЕНИЕ (mood) ----------
let selectedMood = '';
document.querySelectorAll('#mood-picker span').forEach(sp => {
  sp.onclick = () => {
    selectedMood = sp.dataset.mood;
    document.querySelectorAll('#mood-picker span').forEach(s => s.classList.toggle('active', s === sp));
  };
});
const _saveProfileMood = $('btn-save-profile').onclick;
$('btn-save-profile').onclick = function() {
  const u = me();
  if (u) { u.mood = selectedMood; save(DB.users, users); broadcast(); }
  _saveProfileMood.call(this);
};
const _openProfileMood = $('btn-profile').onclick;
$('btn-profile').onclick = function() {
  _openProfileMood();
  const u = me();
  selectedMood = (u && u.mood) || '';
  document.querySelectorAll('#mood-picker span').forEach(s => s.classList.toggle('active', s.dataset.mood === selectedMood));
};
// добавляем mood в displayUser
const _displayUserMood = window.displayUser;
window.displayUser = function(id) {
  const d = _displayUserMood(id);
  const real = realUser(id);
  if (real && real.mood) d.mood = real.mood;
  return d;
};
// встраиваем mood в nameWithVipHTML
const _nameWithVip = nameWithVipHTML;
nameWithVipHTML = function(d) {
  let base = _nameWithVip(d);
  if (d && d.mood) base += ` <span class="mood-badge">${escapeHtml(d.mood)}</span>`;
  return base;
};

// ---------- QR-КОД ПРОФИЛЯ ----------
$('btn-show-qr').onclick = () => {
  const u = me(); if (!u) return;
  const data = encodeURIComponent('messenger-user:@' + u.username);
  $('qr-wrap').innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${data}" alt="QR" onerror="this.parentNode.innerHTML='<div style=\\'color:#333;padding:40px\\'>@${escapeHtml(u.username)}</div>'">`;
  $('qr-name').textContent = realName(u);
  $('qr-handle').textContent = '@' + u.username;
  openModal('qr-modal');
};

// ---------- WORDLE ----------
const WORDLE_WORDS = ['слово','город','книга','песня','родина','школа','земля','время','место','рука','небо','море','солнце','ветер','камень','дерево','река','поле','зерно','банан','мир','дом','кот','сон','лес'];
const WORDLE_5 = WORDLE_WORDS.filter(w => w.length === 5);
let wordleTarget = '', wordleGuesses = [], wordleDone = false;
function startWordle() {
  wordleTarget = WORDLE_5[Math.floor(visibleRandom() * WORDLE_5.length)];
  wordleGuesses = []; wordleDone = false;
  $('wordle-msg').textContent = ''; $('wordle-msg').className = 'wordle-msg';
  $('wordle-input').value = ''; $('wordle-input').disabled = false;
  renderWordle();
  openModal('wordle-modal');
  setTimeout(() => $('wordle-input').focus(), 100);
}
function visibleRandom() { return (Date.now() % 9973) / 9973; }
function renderWordle() {
  const board = $('wordle-board'); board.innerHTML = '';
  for (let r = 0; r < 6; r++) {
    const row = document.createElement('div'); row.className = 'wordle-row';
    const guess = wordleGuesses[r] || '';
    for (let c = 0; c < 5; c++) {
      const cell = document.createElement('div');
      cell.className = 'wordle-cell';
      const ch = guess[c] || '';
      if (ch) {
        cell.textContent = ch; cell.classList.add('filled');
        if (r < wordleGuesses.length) {
          if (wordleTarget[c] === ch) cell.classList.add('correct');
          else if (wordleTarget.includes(ch)) cell.classList.add('present');
          else cell.classList.add('absent');
        }
      }
      row.appendChild(cell);
    }
    board.appendChild(row);
  }
}
$('wordle-guess').onclick = wordleSubmit;
$('wordle-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); wordleSubmit(); } });
function wordleSubmit() {
  if (wordleDone) return;
  const g = $('wordle-input').value.trim().toLowerCase();
  if (g.length !== 5) { $('wordle-msg').textContent = 'Нужно 5 букв'; return; }
  wordleGuesses.push(g);
  $('wordle-input').value = '';
  renderWordle();
  if (g === wordleTarget) {
    wordleDone = true; $('wordle-msg').textContent = '🎉 Угадали!'; $('wordle-msg').className = 'wordle-msg win';
    $('wordle-input').disabled = true;
  } else if (wordleGuesses.length >= 6) {
    wordleDone = true; $('wordle-msg').textContent = 'Загадано: ' + wordleTarget.toUpperCase(); $('wordle-msg').className = 'wordle-msg lose';
    $('wordle-input').disabled = true;
  }
}
$('wordle-new').onclick = startWordle;

// ---------- ИНТЕГРАЦИЯ В plus-menu (album, wordle) ----------
document.querySelectorAll('#plus-menu button').forEach(btn => {
  const act = btn.dataset.act;
  if (act === 'album') btn.onclick = () => { $('plus-menu').classList.remove('open'); $('album-input').click(); };
  if (act === 'game-wordle') btn.onclick = () => { $('plus-menu').classList.remove('open'); startWordle(); };
});

// ---------- ОБНОВЛЕНИЕ openChat: инфо-кнопка для групп, скрытие поиска ----------
const _openChatBatch = window.openChat;
window.openChat = function(id) {
  _openChatBatch(id);
  const chat = chats.find(c => c.id === id);
  $('btn-chat-info').style.display = (chat && chat.type === 'group') ? '' : 'none';
  $('chat-search-bar').classList.remove('show'); clearChatSearch();
  // saved-чат: скрыть звонки/контакт
  if (chat && chat.type === 'saved') {
    $('btn-call-voice').style.display = 'none';
    $('btn-call-video').style.display = 'none';
    $('btn-edit-contact').style.display = 'none';
    $('chat-header-sub').textContent = 'Заметки только для вас';
  }
};

// ---------- album/saved в превью ----------
const _lastPrevBatch = window.lastMessagePreview;
window.lastMessagePreview = function(msg) {
  if (msg && msg.type === 'album') return (msg.senderId === session ? 'Вы: ' : '') + `🖼 Альбом (${(msg.album||[]).length})`;
  return _lastPrevBatch(msg);
};

// ---------- ИСЧЕЗАЮЩИЕ СООБЩЕНИЯ (авто-удаление per-chat) ----------
const DISAPPEAR_OPTIONS = [
  { ms: 0, label: 'Автоудаление: выкл' },
  { ms: 3600000, label: 'Автоудаление: 1 час' },
  { ms: 86400000, label: 'Автоудаление: 24 часа' },
  { ms: 604800000, label: 'Автоудаление: 7 дней' },
];
function disappearLabel(chat) {
  const cur = (chat && chat.disappearing) || 0;
  const o = DISAPPEAR_OPTIONS.find(x => x.ms === cur);
  return o ? o.label.replace('Автоудаление: ', '') : 'выкл';
}
$('chat-ctx-disappear').onclick = () => {
  $('chat-ctx').classList.remove('open');
  if (!chatCtxTargetId) return;
  const chat = chats.find(c => c.id === chatCtxTargetId);
  if (!chat) return;
  const cur = chat.disappearing || 0;
  const idx = DISAPPEAR_OPTIONS.findIndex(x => x.ms === cur);
  const next = DISAPPEAR_OPTIONS[(idx + 1) % DISAPPEAR_OPTIONS.length];
  chat.disappearing = next.ms;
  save(DB.chats, chats); broadcast();
  toast(next.label, 'info');
};
// тикер чистит старые сообщения в чатах с disappearing
setInterval(() => {
  let changed = false;
  const fresh = load(DB.messages, []);
  const now = Date.now();
  const filtered = fresh.filter(m => {
    const chat = chats.find(c => c.id === m.chatId);
    if (chat && chat.disappearing && (now - m.timestamp) > chat.disappearing) { changed = true; return false; }
    return true;
  });
  if (changed) {
    save(DB.messages, filtered); messages = filtered; broadcast();
    if (currentChatId) renderMessages(); renderChats();
  }
}, 30000);

// показываем текущее значение в подписи пункта меню при открытии chat-ctx
const _origAttachChatCtx = (function(){})(); // (текст обновляется ниже через Mutationless подход)
// перехватываем openChatCtxAt и attachChatCtx-открытие, чтобы проставить лейблы
function refreshDisappearLabel() {
  const chat = chats.find(c => c.id === chatCtxTargetId);
  const span = $('chat-ctx-disappear').querySelector('span');
  if (span) span.textContent = chat && chat.disappearing ? `Автоудаление: ${disappearLabel(chat)}` : 'Автоудаление: выкл';
}
const _openChatCtxAtDis = openChatCtxAt;
openChatCtxAt = function(chatId, x, y) {
  _openChatCtxAtDis(chatId, x, y);
  refreshDisappearLabel();
};
// для правого клика тоже — слушаем открытие меню
const _chatCtxObserverTarget = $('chat-ctx');
new MutationObserver(() => {
  if (_chatCtxObserverTarget.classList.contains('open')) refreshDisappearLabel();
}).observe(_chatCtxObserverTarget, { attributes: true, attributeFilter: ['class'] });

// ---------- enterApp: создать saved-чат, отрисовать папки ----------
const _finishEnterBatch = window.finishEnter;
window.finishEnter = function() {
  _finishEnterBatch();
  ensureSavedChat();
  renderFolderTabs();
  renderChats();
};

// =====================================================================
// ===================== НАСТОЯЩИЕ ЗВОНКИ (PeerJS) =====================
// =====================================================================
// Сигналинг через публичный брокер PeerJS + STUN Google → звонки между
// разными устройствами по интернету. Идентификация по @username.

let peer = null, peerReady = false;
let activeCall = null, incomingCall = null;
let callLocalStream = null, callKindP = null, callTimerP = null, callStartP = 0, mutedP = false, ringTimeout = null;

const PEER_PREFIX = 'mlmsgr1-'; // префикс пространства имён, чтобы ID не пересекались с чужими
function peerIdFor(username) {
  return PEER_PREFIX + String(username).toLowerCase().replace(/[^a-z0-9]/g, '-');
}
function peerUsernameFromId(id) { return (id || '').replace(PEER_PREFIX, ''); }

function initPeer() {
  if (!window.Peer) { return; } // библиотека не загрузилась (офлайн)
  if (!session) return;
  const u = me(); if (!u) return;
  if (peer && !peer.destroyed) return;
  try {
    peer = new Peer(peerIdFor(u.username), {
      config: { iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ] }
    });
  } catch (e) { return; }
  peer.on('open', () => { peerReady = true; updateCallSelfId(); });
  peer.on('call', (call) => {
    if (activeCall || incomingCall) { try { call.close(); } catch {} return; }
    incomingCall = call;
    callKindP = (call.metadata && call.metadata.video) ? 'video' : 'voice';
    const fromName = (call.metadata && call.metadata.name) || ('@' + peerUsernameFromId(call.peer));
    const fromUser = (call.metadata && call.metadata.username) || peerUsernameFromId(call.peer);
    showCallScreen({ name: fromName, username: fromUser, kind: callKindP, state: 'Входящий вызов' });
    $('call-answer').style.display = '';
    try { beep(); } catch {}
  });
  peer.on('error', (err) => {
    if (!err) return;
    if (err.type === 'peer-unavailable') {
      toast('Пользователь не в сети или не открыл приложение', 'error');
      endCallP(false);
    } else if (err.type === 'unavailable-id') {
      // ID занят (например, вы открыли в двух вкладках) — звонки примет другая вкладка
      peerReady = false;
    } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      peerReady = false;
      updateCallSelfId();
    }
  });
  peer.on('disconnected', () => { peerReady = false; try { peer.reconnect(); } catch {} });
}
function destroyPeer() {
  peerReady = false;
  try { if (peer && !peer.destroyed) peer.destroy(); } catch {}
  peer = null;
}

// ---------- UI звонка ----------
function showCallScreen({ name, username, kind, state }) {
  $('call-overlay').classList.add('show');
  $('call-state').textContent = state;
  $('call-name').textContent = name;
  setAvatar($('call-avatar'), { id: username || name, name });
  const remote = $('call-remote-video'), local = $('call-local-video');
  if (kind === 'video') { remote.style.display = ''; local.style.display = ''; }
  else { remote.style.display = 'none'; local.style.display = 'none'; }
}
function startTimerP() {
  if (callTimerP) return;
  callStartP = Date.now();
  callTimerP = setInterval(() => {
    $('call-meta').textContent = fmtDuration(Math.floor((Date.now() - callStartP) / 1000));
  }, 1000);
}
function endCallP(closeRemote = true) {
  if (ringTimeout) { clearTimeout(ringTimeout); ringTimeout = null; }
  if (closeRemote && activeCall) { try { activeCall.close(); } catch {} }
  if (incomingCall && closeRemote) { try { incomingCall.close(); } catch {} }
  activeCall = null; incomingCall = null;
  if (callLocalStream) { callLocalStream.getTracks().forEach(t => t.stop()); callLocalStream = null; }
  if (callTimerP) { clearInterval(callTimerP); callTimerP = null; }
  mutedP = false; $('call-mute').classList.remove('active');
  $('call-answer').style.display = 'none';
  $('call-overlay').classList.remove('show');
  $('call-remote-video').srcObject = null;
  $('call-local-video').srcObject = null;
  $('call-state').textContent = ''; $('call-meta').textContent = '';
}

// ---------- Исходящий звонок ----------
async function peerStartCall(targetUsername, displayName, kind) {
  if (!window.Peer) { toast('Сервис звонков недоступен (нет интернета)', 'error'); return; }
  if (!peer || peer.destroyed) initPeer();
  if (activeCall || incomingCall) { toast('Уже идёт звонок', 'info'); return; }
  const target = String(targetUsername).replace(/^@/, '').trim();
  if (!target) return;
  const meU = me();
  if (target.toLowerCase() === meU.username.toLowerCase()) { toast('Нельзя позвонить самому себе', 'info'); return; }
  callKindP = kind;
  showCallScreen({ name: displayName || ('@' + target), username: target, kind, state: peerReady ? 'Вызов…' : 'Подключение к сети…' });
  // дождёмся готовности peer (до 6 сек)
  if (!peerReady) {
    const ok = await waitPeerReady(6000);
    if (!ok) { toast('Не удалось подключиться к сервису звонков', 'error'); endCallP(); return; }
    $('call-state').textContent = 'Вызов…';
  }
  try {
    callLocalStream = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { audio: true, video: true } : { audio: true });
  } catch (e) { toast('Нет доступа к ' + (kind === 'video' ? 'камере' : 'микрофону'), 'error'); endCallP(); return; }
  if (kind === 'video') $('call-local-video').srcObject = callLocalStream;
  let call;
  try {
    call = peer.call(peerIdFor(target), callLocalStream, { metadata: { video: kind === 'video', name: realName(meU), username: meU.username } });
  } catch (e) { toast('Не удалось позвонить', 'error'); endCallP(); return; }
  if (!call) { toast('Не удалось позвонить', 'error'); endCallP(); return; }
  activeCall = call;
  call.on('stream', (remote) => {
    $('call-remote-video').srcObject = remote;
    $('call-state').textContent = 'Идёт разговор';
    if (ringTimeout) { clearTimeout(ringTimeout); ringTimeout = null; }
    startTimerP();
  });
  call.on('close', () => endCallP(false));
  call.on('error', () => { toast('Ошибка соединения', 'error'); endCallP(false); });
  ringTimeout = setTimeout(() => {
    if (activeCall && $('call-state').textContent === 'Вызов…') { toast('Нет ответа', 'info'); endCallP(); }
  }, 45000);
}
function waitPeerReady(timeout) {
  return new Promise(res => {
    if (peerReady) return res(true);
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (peerReady) { clearInterval(iv); res(true); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); res(false); }
    }, 150);
  });
}

// ---------- Ответ на входящий ----------
async function answerCallP() {
  if (!incomingCall) return;
  $('call-answer').style.display = 'none';
  $('call-state').textContent = 'Подключение…';
  try {
    callLocalStream = await navigator.mediaDevices.getUserMedia(callKindP === 'video' ? { audio: true, video: true } : { audio: true });
  } catch (e) { toast('Нет доступа к устройству', 'error'); endCallP(); return; }
  if (callKindP === 'video') $('call-local-video').srcObject = callLocalStream;
  try { incomingCall.answer(callLocalStream); } catch (e) { toast('Ошибка ответа', 'error'); endCallP(); return; }
  activeCall = incomingCall; incomingCall = null;
  activeCall.on('stream', (remote) => {
    $('call-remote-video').srcObject = remote;
    $('call-state').textContent = 'Идёт разговор';
    startTimerP();
  });
  activeCall.on('close', () => endCallP(false));
  activeCall.on('error', () => { toast('Ошибка соединения', 'error'); endCallP(false); });
}

// ---------- Привязка кнопок (переопределяем старые BroadcastChannel) ----------
$('call-answer').onclick = () => answerCallP();
$('call-end').onclick = () => endCallP(true);
$('call-mute').onclick = () => {
  if (!callLocalStream) return;
  mutedP = !mutedP;
  callLocalStream.getAudioTracks().forEach(t => t.enabled = !mutedP);
  $('call-mute').classList.toggle('active', mutedP);
  toast(mutedP ? 'Микрофон выключен' : 'Микрофон включён', 'info', 1200);
};
$('btn-call-voice').onclick = () => {
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat || chat.type !== 'dm') return;
  const other = displayUser(chat.members.find(m => m !== session));
  peerStartCall(other.username, other.name, 'voice');
};
$('btn-call-video').onclick = () => {
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat || chat.type !== 'dm') return;
  const other = displayUser(chat.members.find(m => m !== session));
  peerStartCall(other.username, other.name, 'video');
};

// ---------- Звонок по @username (кросс-устройство) ----------
$('btn-call-username').onclick = () => {
  $('call-username-input').value = '';
  $('call-user-error').textContent = '';
  updateCallSelfId();
  if (!peer || peer.destroyed) initPeer();
  openModal('call-user-modal');
  setTimeout(() => $('call-username-input').focus(), 80);
};
function updateCallSelfId() {
  const el = $('call-self-id'); if (!el) return;
  const u = me(); if (!u) return;
  const dotCls = peerReady ? 'online' : 'connecting';
  const status = peerReady ? 'в сети для звонков' : 'подключение…';
  el.innerHTML = `<span class="call-status-dot ${dotCls}"></span>Ваш юзернейм для звонков: <b>@${escapeHtml(u.username)}</b><br><span style="color:var(--text-muted)">${status}</span>`;
}
$('call-do-voice').onclick = () => {
  const v = $('call-username-input').value.trim().replace(/^@/, '');
  if (!v) { $('call-user-error').textContent = 'Введите юзернейм'; return; }
  closeModal('call-user-modal');
  peerStartCall(v, '@' + v, 'voice');
};
$('call-do-video').onclick = () => {
  const v = $('call-username-input').value.trim().replace(/^@/, '');
  if (!v) { $('call-user-error').textContent = 'Введите юзернейм'; return; }
  closeModal('call-user-modal');
  peerStartCall(v, '@' + v, 'video');
};
$('call-username-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('call-do-voice').click(); } });

// ---------- Инициализация при входе / выходе ----------
// Если PeerJS догрузился позже (async) — инициализируем тогда
window.onPeerReady = function() { if (session) initPeer(); };
const _finishEnterCalls = window.finishEnter;
window.finishEnter = function() {
  _finishEnterCalls();
  // пробуем сразу; если библиотека ещё грузится — onPeerReady подхватит
  setTimeout(() => { if (window.Peer) initPeer(); }, 300);
};
const _logoutCalls = $('btn-logout').onclick;
$('btn-logout').onclick = function() {
  endCallP(true);
  destroyPeer();
  _logoutCalls && _logoutCalls.call(this);
};
window.addEventListener('beforeunload', () => { try { destroyPeer(); } catch {} });

// ===================== АВТОВХОД =====================
if (session && me()) enterApp();
else applyTheme('dark');
