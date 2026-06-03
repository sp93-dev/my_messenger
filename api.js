/* =====================================================================
   Слой интеграции с Django-бэкендом.
   Переводит авторизацию, пользователей, чаты и сообщения на сервер.
   Загружается ПОСЛЕ app.js и переопределяет нужные функции.
   ===================================================================== */
(function () {
  // Адрес API определяется автоматически:
  // - если сайт открыт прямо с Django (порт 8000) или с настоящего домена → тот же origin
  // - если открыт локально иначе (file://, Live Server, превью на другом порту) → backend :8000
  const _host = location.hostname;
  const _isLocal = location.protocol === 'file:' || _host === '' ||
                   _host === 'localhost' || _host === '127.0.0.1';
  const _onDjango = location.port === '8000';
  const API_BASE = (_isLocal && !_onDjango) ? 'http://127.0.0.1:8000/api' : (location.origin + '/api');
  const TOKEN_KEY = 'msg_token';
  let token = localStorage.getItem(TOKEN_KEY) || null;
  let lastSync = 0;
  let pollTimer = null;

  // ---------- HTTP ----------
  async function http(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Token ' + token;
    const res = await fetch(API_BASE + path, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      // Бан за запрещённый контент — блокирующий экран
      if (data && data.banned) {
        handleBanned(data.error);
      } else if (res.status === 401 && token && path !== '/login' && path !== '/register') {
        // Истёкшая/невалидная сессия — мягкий выход на экран входа
        handleSessionExpired();
      }
      const err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }
  function handleBanned(message) {
    try { stopPolling(); } catch {}
    try { disconnectWS(); } catch {}
    token = null; localStorage.removeItem(TOKEN_KEY);
    try { session = null; save(DB.session, null); } catch {}
    let ov = document.getElementById('ban-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'ban-overlay';
      ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0b0b0f;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px;font-family:Inter,system-ui,sans-serif;';
      document.body.appendChild(ov);
    }
    ov.innerHTML = `
      <div style="font-size:64px;margin-bottom:16px">🚫</div>
      <h1 style="font-size:24px;font-weight:700;margin-bottom:10px">Аккаунт заблокирован</h1>
      <p style="max-width:420px;color:#aab;line-height:1.6;font-size:15px">${(message || 'Нарушение правил сообщества.')}</p>
      <p style="max-width:420px;color:#778;margin-top:14px;font-size:13px">Восстановление аккаунта и данных невозможно. Это сделано для безопасной среды без угроз, наркоторговли и подобного.</p>`;
    ov.style.display = 'flex';
  }
  let sessionExpiredShown = false;
  function handleSessionExpired() {
    if (sessionExpiredShown) return;
    sessionExpiredShown = true;
    try { stopPolling(); } catch {}
    try { disconnectWS(); } catch {}
    token = null; localStorage.removeItem(TOKEN_KEY);
    try { session = null; save(DB.session, null); } catch {}
    $('main-screen').classList.remove('active');
    $('auth-screen').classList.add('active');
    try { toast('Сессия истекла, войдите снова', 'info', 5000); } catch {}
    setTimeout(() => { sessionExpiredShown = false; }, 3000);
  }
  const API = {
    register: (d) => http('POST', '/register', d),
    login: (d) => http('POST', '/login', d),
    logout: () => http('POST', '/logout', {}),
    me: () => http('GET', '/me'),
    updateMe: (d) => http('PATCH', '/me', d),
    users: () => http('GET', '/users'),
    searchUsers: (q) => http('GET', '/users/search?q=' + encodeURIComponent(q)),
    presence: () => http('POST', '/presence', {}),
    chats: () => http('GET', '/chats'),
    createChat: (d) => http('POST', '/chats', d),
    chatAction: (id, d) => http('PATCH', '/chats/' + id, d),
    chatMessages: (id) => http('GET', '/chats/' + id + '/messages'),
    sendMessage: (id, d) => http('POST', '/chats/' + id + '/messages', d),
    patchMessage: (id, d) => http('PATCH', '/messages/' + id, d),
    deleteMessage: (id) => http('DELETE', '/messages/' + id),
    sync: (since) => http('GET', '/sync?since=' + (since || 0)),
    getStories: () => http('GET', '/stories'),
    createStory: (d) => http('POST', '/stories', d),
    deleteStory: (id) => http('DELETE', '/stories/' + id),
    viewStory: (id) => http('POST', '/stories/' + id, {}),
    reports: () => http('GET', '/reports'),
    resolveReport: (id) => http('POST', '/reports/' + id, {}),
    banUser: (userId, ban) => http('POST', '/moderation/ban', { userId, ban }),
    upload: async (file) => {
      const fd = new FormData();
      fd.append('file', file);
      const headers = {};
      if (token) headers['Authorization'] = 'Token ' + token;
      const res = await fetch(API_BASE + '/upload', { method: 'POST', headers, body: fd });
      if (!res.ok) { let e = {}; try { e = await res.json(); } catch {} throw new Error(e.error || 'Ошибка загрузки'); }
      return res.json();
    },
  };
  window.__API = API;

  // ---------- Нормализация серверных объектов ----------
  function normUser(su) {
    return {
      id: su.id, username: su.username, name: su.name, avatar: su.avatar || null,
      bio: su.bio || '', status: su.status || '', mood: su.mood || '',
      vipTag: su.vipTag || '', isVip: !!su.isVip, pubkey: su.pubkey || '',
      isAdmin: !!su.isAdmin,
      _online: !!su.online, _lastSeen: su.lastSeen ? new Date(su.lastSeen).getTime() : 0,
    };
  }
  function normChat(sc) {
    return {
      id: sc.id, type: sc.type, name: sc.name || null, avatar: sc.avatar || null,
      description: sc.description || null, ownerId: sc.ownerId || null,
      secret: !!sc.secret,
      pinnedId: sc.pinnedId || null,
      members: sc.members || [], createdAt: sc.createdAt,
    };
  }
  // дописывает токен к ссылкам на наши медиа (для тега <img>/<video>)
  function withMediaToken(url) {
    if (typeof url !== 'string' || url.indexOf('/media/') === -1 || !token) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(token);
  }
  function normMsg(sm) {
    // разворачиваем extra в плоский объект, как ожидает рендер app.js
    const base = {
      id: sm.id, chatId: sm.chatId, senderId: sm.senderId, type: sm.type,
      content: sm.content || '', timestamp: sm.timestamp,
      editedAt: sm.editedAt || null, _updatedAt: sm.updatedAt || sm.timestamp,
    };
    const m = Object.assign(base, sm.extra || {});
    if (m.mediaEnc && typeof m.content === 'string') {
      // зашифрованное медиа: реальный URL прячем, ставим плейсхолдер,
      // расшифровка подставит blob-URL после рендера
      m._encUrl = withMediaToken(m.content);
      m.content = decMediaCache[m.id] || TRANSPARENT_PX;
    } else if (m.enc && typeof m.content === 'string') {
      // секретное текстовое сообщение: контент — шифртекст
      m._cipher = m.content; m._iv = m.iv; m._needDecrypt = true;
      m.content = '🔒 …';
    } else {
      if (typeof m.content === 'string') m.content = withMediaToken(m.content);
      if (Array.isArray(m.album)) m.album = m.album.map(withMediaToken);
    }
    return m;
  }
  const TRANSPARENT_PX = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  function normStory(s) {
    return Object.assign({}, s, { content: withMediaToken(s.content) });
  }

  // =================== E2E-ШИФРОВАНИЕ (секретные чаты) ===================
  // ECDH P-256 для согласования ключа + AES-GCM для сообщений.
  // Приватный ключ хранится только на этом устройстве (localStorage).
  const subtle = (window.crypto && window.crypto.subtle) ? window.crypto.subtle : null;
  const keyCache = new Map(); // chatId -> CryptoKey (AES)
  function ab2b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
  function b642ab(b64) { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a.buffer; }

  async function ensureKeypair() {
    if (!subtle || !session) return;
    const privKeyName = 'msg_e2e_priv_' + session;
    const pubKeyName = 'msg_e2e_pub_' + session;
    let privB64 = localStorage.getItem(privKeyName);
    let pubB64 = localStorage.getItem(pubKeyName);
    if (!privB64 || !pubB64) {
      const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
      privB64 = ab2b64(await subtle.exportKey('pkcs8', kp.privateKey));
      pubB64 = ab2b64(await subtle.exportKey('spki', kp.publicKey));
      localStorage.setItem(privKeyName, privB64);
      localStorage.setItem(pubKeyName, pubB64);
    }
    // публикуем pubkey, если на сервере его нет / он другой
    const meU = me();
    if (meU && meU.pubkey !== pubB64) {
      try { const u = await API.updateMe({ pubkey: pubB64 }); upsertUser(normUser(u)); } catch {}
    }
  }
  async function myPrivateKey() {
    const privB64 = localStorage.getItem('msg_e2e_priv_' + session);
    if (!privB64) return null;
    return subtle.importKey('pkcs8', b642ab(privB64), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  }
  async function deriveChatKey(chat) {
    if (keyCache.has(chat.id)) return keyCache.get(chat.id);
    const otherId = chat.members.find(m => m !== session);
    const other = realUser(otherId);
    if (!other || !other.pubkey) return null;
    const priv = await myPrivateKey();
    if (!priv) return null;
    const peerPub = await subtle.importKey('spki', b642ab(other.pubkey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const key = await subtle.deriveKey(
      { name: 'ECDH', public: peerPub }, priv,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    keyCache.set(chat.id, key);
    return key;
  }
  async function encryptForChat(chat, text) {
    const key = await deriveChatKey(chat);
    if (!key) throw new Error('нет ключа');
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return { ct: ab2b64(ct), iv: ab2b64(iv) };
  }
  async function decryptForChat(chat, ctB64, ivB64) {
    const key = await deriveChatKey(chat);
    if (!key) throw new Error('нет ключа');
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(b642ab(ivB64)) }, key, b642ab(ctB64));
    return new TextDecoder().decode(pt);
  }
  function isSecretChat(chatId) {
    const c = chats.find(x => x.id === chatId);
    return !!(c && c.secret);
  }
  // дешифрует все ожидающие секретные сообщения и перерисовывает
  let decryptRunning = false;
  async function decryptPending() {
    if (!subtle || decryptRunning) return;
    decryptRunning = true;
    let changed = false;
    try {
      for (const m of messages) {
        if (m.enc && m._needDecrypt) {
          const chat = chats.find(c => c.id === m.chatId);
          if (!chat) continue;
          try {
            m.content = await decryptForChat(chat, m._cipher, m._iv);
          } catch { m.content = '🔒 не удалось расшифровать'; }
          m._needDecrypt = false;
          changed = true;
        }
      }
    } finally { decryptRunning = false; }
    if (changed) { if (currentChatId) renderMessages(); renderChats(); }
  }
  window.__decryptPending = decryptPending;

  // ---- Шифрование медиа (байты) для секретных чатов ----
  async function encryptBytes(chat, arrayBuffer) {
    const key = await deriveChatKey(chat);
    if (!key) throw new Error('нет ключа');
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);
    return { ct, iv: ab2b64(iv) };
  }
  async function decryptBytes(chat, ctBuffer, ivB64) {
    const key = await deriveChatKey(chat);
    if (!key) throw new Error('нет ключа');
    return subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(b642ab(ivB64)) }, key, ctBuffer);
  }
  const decMediaCache = {}; // msgId -> blob URL расшифрованного медиа
  let decMediaRunning = false;
  // расшифровывает медиа открытого чата и подставляет blob-URL в элементы
  async function decryptMediaPending() {
    if (!subtle || decMediaRunning || !currentChatId) return;
    decMediaRunning = true;
    try {
      for (const m of messages) {
        if (!m.mediaEnc || m.chatId !== currentChatId) continue;
        if (decMediaCache[m.id]) { applyMediaUrl(m.id, decMediaCache[m.id]); continue; }
        const chat = chats.find(c => c.id === m.chatId);
        if (!chat) continue;
        try {
          const resp = await fetch(m._encUrl);
          const ctBuf = await resp.arrayBuffer();
          const ptBuf = await decryptBytes(chat, ctBuf, m.miv);
          const blob = new Blob([ptBuf], { type: m.mmime || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          decMediaCache[m.id] = url;
          m.content = url;  // чтобы скачивание/перерисовка использовали расшифрованное
          applyMediaUrl(m.id, url);
        } catch {}
      }
    } finally { decMediaRunning = false; }
  }
  function applyMediaUrl(msgId, url) {
    const el = document.querySelector(`.msg[data-msg-id="${msgId}"]`);
    if (!el) return;
    const node = el.querySelector('img[data-media], video[data-media], audio, .file-card');
    if (!node) return;
    if (node.classList && node.classList.contains('file-card')) {
      node.dataset.fileUrl = url;  // для скачивания зашифрованного файла
    } else if (node.tagName === 'IMG' || node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
      if (node.getAttribute('src') !== url) node.setAttribute('src', url);
    }
  }
  window.__decryptMediaPending = decryptMediaPending;
  // обратно: из плоского сообщения вытащить extra (всё кроме базовых полей)
  const CORE_FIELDS = new Set(['id', 'chatId', 'senderId', 'type', 'content', 'timestamp', 'editedAt', '_updatedAt']);
  function extractExtra(payload) {
    const extra = {};
    for (const k of Object.keys(payload)) {
      if (k === 'type' || k === 'content') continue;
      extra[k] = payload[k];
    }
    return extra;
  }

  // ---------- Апсерты в локальные массивы ----------
  function upsertUser(u) {
    const i = users.findIndex(x => x.id === u.id);
    if (i === -1) users.push(u); else users[i] = u;
  }
  function upsertChat(c) {
    const i = chats.findIndex(x => x.id === c.id);
    if (i === -1) chats.push(c); else chats[i] = { ...chats[i], ...c };
  }
  function upsertMsg(m) {
    const i = messages.findIndex(x => x.id === m.id);
    if (i === -1) messages.push(m); else messages[i] = m;
  }
  function applyServerMessage(sm) { upsertMsg(normMsg(sm)); }

  // ---------- Онлайн-статус из серверных данных ----------
  isOnline = function (userId) {
    const u = realUser(userId);
    return !!(u && u._online);
  };
  lastSeenText = function (userId) {
    const u = realUser(userId);
    if (!u) return 'не в сети';
    if (u._online) return 'в сети';
    if (!u._lastSeen) return 'был(а) недавно';
    const diff = Date.now() - u._lastSeen;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'был(а) только что';
    if (m < 60) return `был(а) ${m} мин назад`;
    const h = Math.floor(m / 60);
    if (h < 24) return `был(а) ${h} ч назад`;
    return 'был(а) давно';
  };
  // heartbeat на сервер вместо localStorage
  pulsePresence = function () { if (token) API.presence().catch(() => {}); };
  // saved-чат создаётся на сервере при бутстрапе — локальный no-op
  ensureSavedChat = function () {};

  // ---------- БУТСТРАП ПОСЛЕ ВХОДА ----------
  async function serverBootstrap(meUser) {
    const meU = meUser || await API.me();
    session = meU.id;
    save(DB.session, session);
    const [others, chatList] = await Promise.all([API.users(), API.chats()]);
    users = [normUser(meU), ...others.map(normUser)];
    chats = chatList.map(normChat);
    // гарантируем «Избранное»
    if (!chats.some(c => c.type === 'saved')) {
      try { const saved = await API.createChat({ type: 'saved' }); upsertChat(normChat(saved)); } catch {}
    }
    const data = await API.sync(0);
    lastSync = data.now;
    messages = data.messages.map(normMsg);
    if (typeof stories !== 'undefined') { stories = (data.stories || []).map(normStory); save(DB.stories, stories); }
    save(DB.users, users); save(DB.chats, chats); save(DB.messages, messages);
    // E2E: убеждаемся, что у нас есть ключ и он опубликован
    await ensureKeypair();
    decryptPending(); decryptMediaPending();
  }

  // ---------- WEBSOCKET (мгновенная доставка) ----------
  let ws = null, wsPing = null, wsReconnect = null, wsConnected = false;
  const WS_BASE = API_BASE.replace(/^http/, 'ws').replace(/\/api$/, '');
  function connectWS() {
    if (!token) return;
    try { if (ws) ws.close(); } catch {}
    try {
      ws = new WebSocket(WS_BASE + '/ws?token=' + encodeURIComponent(token));
    } catch (e) { return; }
    ws.onopen = () => {
      wsConnected = true;
      if (wsPing) clearInterval(wsPing);
      wsPing = setInterval(() => { try { ws.send(JSON.stringify({ type: 'ping' })); } catch {} }, 25000);
      // при WS-соединении опрос реже (только presence/подстраховка)
      startPolling(8000);
    };
    ws.onmessage = (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch { return; }
      handleWsEvent(data);
    };
    ws.onclose = () => {
      wsConnected = false;
      if (wsPing) { clearInterval(wsPing); wsPing = null; }
      startPolling(2500); // вернулись к частому опросу
      if (token) {
        if (wsReconnect) clearTimeout(wsReconnect);
        wsReconnect = setTimeout(connectWS, 3000);
      }
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  function disconnectWS() {
    if (wsReconnect) { clearTimeout(wsReconnect); wsReconnect = null; }
    if (wsPing) { clearInterval(wsPing); wsPing = null; }
    if (ws) { try { ws.onclose = null; ws.close(); } catch {} ws = null; }
    wsConnected = false;
  }
  function handleWsEvent(data) {
    if (!data || !data.type) return;
    if (data.type === 'message') {
      upsertMsg(normMsg(data.message));
      save(DB.messages, messages);
      if (data.message.chatId === currentChatId) renderMessages();
      renderChats();
      decryptPending(); decryptMediaPending();
    } else if (data.type === 'message_deleted') {
      messages = messages.filter(m => m.id !== data.id);
      save(DB.messages, messages);
      if (data.chatId === currentChatId) renderMessages();
      renderChats();
    } else if (data.type === 'chat') {
      upsertChat(normChat(data.chat));
      save(DB.chats, chats);
      renderChats();
      if (typeof renderFolderTabs === 'function') renderFolderTabs();
      if (currentChatId === data.chat.id && typeof renderPinned === 'function') renderPinned();
    } else if (data.type === 'story') {
      if (typeof stories !== 'undefined') {
        const i = stories.findIndex(s => s.id === data.story.id);
        const ns = normStory(data.story); if (i === -1) stories.push(ns); else stories[i] = ns;
        save(DB.stories, stories);
        if (typeof renderStoriesBar === 'function') renderStoriesBar();
      }
    } else if (data.type === 'report') {
      onNewReport(data.report);
    }
  }
  window.__wsConnected = () => wsConnected;

  // ---------- ПОЛЛИНГ ----------
  function startPolling(interval) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollSync, interval || 2500);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  async function pollSync() {
    if (!token) return;
    try {
      const data = await API.sync(lastSync);
      lastSync = data.now;
      (data.users || []).forEach(su => upsertUser(normUser(su)));
      (data.chats || []).forEach(sc => upsertChat(normChat(sc)));
      (data.messages || []).forEach(sm => upsertMsg(normMsg(sm)));
      if (data.stories && typeof stories !== 'undefined') { stories = data.stories.map(normStory); save(DB.stories, stories); }
      if (currentChatId) await reconcileChat(currentChatId);
      save(DB.users, users); save(DB.chats, chats); save(DB.messages, messages);
      if (session) { renderChats(); if (typeof renderStoriesBar === 'function') renderStoriesBar(); }
      if (currentChatId) { renderMessages(); if (typeof renderPinned === 'function') renderPinned(); }
      refreshChatHeaderPresence();
      decryptPending(); decryptMediaPending();
    } catch (e) { /* сеть недоступна — попробуем позже */ }
  }
  // полная сверка сообщений открытого чата (ловит удаления)
  async function reconcileChat(chatId) {
    try {
      const list = await API.chatMessages(chatId);
      const ids = new Set(list.map(m => m.id));
      messages = messages.filter(m => m.chatId !== chatId || ids.has(m.id));
      list.forEach(sm => upsertMsg(normMsg(sm)));
    } catch {}
  }
  window.__pollSync = pollSync;

  // ---------- АВТОРИЗАЦИЯ ----------
  $('btn-register').onclick = async () => {
    const name = $('reg-name').value.trim();
    const username = $('reg-username').value.trim();
    const phone = $('reg-phone') ? $('reg-phone').value.trim() : '';
    const p1 = $('reg-password').value, p2 = $('reg-password2').value;
    const err = $('register-error'); err.textContent = '';
    if (!name) return err.textContent = 'Введите имя.';
    const phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 7) return err.textContent = 'Укажите номер телефона (минимум 7 цифр).';
    if (p1 !== p2) return err.textContent = 'Пароли не совпадают.';
    try {
      const r = await API.register({ username, password: p1, name, phone });
      token = r.token; localStorage.setItem(TOKEN_KEY, token);
      await serverBootstrap(r.user);
      finishEnter();
      startPolling(); connectWS();
      loadReports();
    } catch (e) { err.textContent = e.message || 'Ошибка регистрации'; }
  };
  $('btn-login').onclick = async () => {
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    const err = $('login-error'); err.textContent = '';
    try {
      const r = await API.login({ username, password });
      token = r.token; localStorage.setItem(TOKEN_KEY, token);
      await serverBootstrap(r.user);
      finishEnter();
      startPolling(); connectWS();
      loadReports();
    } catch (e) { err.textContent = e.message || 'Ошибка входа'; }
  };
  $('btn-logout').onclick = async () => {
    try { await API.logout(); } catch {}
    stopPolling(); disconnectWS();
    token = null; localStorage.removeItem(TOKEN_KEY);
    session = null; currentChatId = null;
    save(DB.session, null);
    try { applyTheme('dark'); } catch {}
    try { if (typeof destroyPeer === 'function') destroyPeer(); } catch {}
    $('main-screen').classList.remove('active');
    $('auth-screen').classList.add('active');
    $('login-username').value = ''; $('login-password').value = '';
  };

  // ---------- ОТПРАВКА СООБЩЕНИЙ ----------
  sendMessage = async function (payload) {
    if (!currentChatId) return;
    // режим редактирования
    if (pendingEditId) {
      const id = pendingEditId; pendingEditId = null;
      try { cancelEdit(); } catch {}
      try {
        const sm = await API.patchMessage(id, { content: payload.content });
        applyServerMessage(sm); renderMessages(); renderChats();
      } catch (e) { toast('Не удалось изменить сообщение', 'error'); }
      return;
    }
    const type = payload.type || 'text';
    const content = payload.content || '';
    const extra = extractExtra(payload);
    if (pendingReplyTo) extra.replyTo = pendingReplyTo;
    if (pendingSelfDestruct) extra.selfDestruct = true;
    // сбрасываем состояние композера как в оригинале
    const wasSelfDestruct = pendingSelfDestruct;
    pendingSelfDestruct = false; try { refreshComposerToggles(); } catch {}
    pendingReplyTo = null; try { cancelReply(); } catch {}
    // упоминания (тост)
    if (type === 'text' && content) {
      const mentioned = [...content.matchAll(/@([a-zA-Z0-9_.]+)/g)]
        .map(x => x[1]).filter(un => users.find(u => u.username.toLowerCase() === un.toLowerCase()));
      if (mentioned.length) toast('Упомянуты: ' + mentioned.map(n => '@' + n).join(', '), 'info', 1800);
    }
    // E2E: в секретном чате шифруем текст перед отправкой
    let outType = type, outContent = content;
    if (isSecretChat(currentChatId) && type === 'text' && content) {
      try {
        const chat = chats.find(c => c.id === currentChatId);
        const { ct, iv } = await encryptForChat(chat, content);
        outContent = ct; extra.enc = true; extra.iv = iv;
      } catch (e) { toast('Не удалось зашифровать сообщение', 'error'); return; }
    }
    try {
      const sm = await API.sendMessage(currentChatId, { type: outType, content: outContent, extra });
      applyServerMessage(sm);
      // своё сообщение в секретном чате показываем сразу открытым текстом (он у нас есть),
      // чтобы не мелькал плейсхолдер «🔒 …»
      if (extra.enc && content) {
        const mine = messages.find(x => x.id === sm.id);
        if (mine) { mine.content = content; mine._needDecrypt = false; }
      }
      save(DB.messages, messages);
      decryptPending(); decryptMediaPending();
      renderMessages(); renderChats();
    } catch (e) { toast('Сообщение не отправлено', 'error'); }
  };

  // ---------- РЕАКЦИИ / ОПРОСЫ / ЛАЙКИ / ПРОЧТЕНИЕ ----------
  toggleReaction = async function (msgId, emoji) {
    const m = messages.find(x => x.id === msgId); if (!m) return;
    const reactions = JSON.parse(JSON.stringify(m.reactions || {}));
    reactions[emoji] = reactions[emoji] || [];
    const i = reactions[emoji].indexOf(session);
    if (i === -1) reactions[emoji].push(session); else reactions[emoji].splice(i, 1);
    if (!reactions[emoji].length) delete reactions[emoji];
    m.reactions = reactions; renderMessages();
    try { const sm = await API.patchMessage(msgId, { extra: { reactions } }); applyServerMessage(sm); } catch {}
  };
  votePoll = async function (msgId, optIdx) {
    const m = messages.find(x => x.id === msgId); if (!m || m.type !== 'poll') return;
    const poll = JSON.parse(JSON.stringify(m.poll));
    if (!poll.multi) poll.options.forEach(o => o.votes = (o.votes || []).filter(v => v !== session));
    const opt = poll.options[optIdx]; opt.votes = opt.votes || [];
    const i = opt.votes.indexOf(session);
    if (i === -1) opt.votes.push(session); else opt.votes.splice(i, 1);
    m.poll = poll; renderMessages();
    try { const sm = await API.patchMessage(msgId, { extra: { poll } }); applyServerMessage(sm); } catch {}
  };
  toggleLike = async function (msgId) {
    const m = messages.find(x => x.id === msgId); if (!m) return;
    const likes = (m.likes || []).slice();
    const i = likes.indexOf(session);
    if (i === -1) likes.push(session); else likes.splice(i, 1);
    m.likes = likes; renderMessages();
    try { const sm = await API.patchMessage(msgId, { extra: { likes } }); applyServerMessage(sm); } catch {}
  };
  markMessageRead = function (msgId) {
    const m = messages.find(x => x.id === msgId); if (!m) return;
    m.readBy = m.readBy || [];
    if (m.readBy.includes(session)) return;
    m.readBy.push(session);
    if (!m.readAt && m.selfDestruct) m.readAt = Date.now();
    API.patchMessage(msgId, { extra: { readBy: m.readBy, readAt: m.readAt } })
      .then(sm => applyServerMessage(sm)).catch(() => {});
  };

  // ---------- УДАЛЕНИЕ (с undo) ----------
  $('ctx-delete').onclick = () => {
    if (!ctxTargetId) return;
    const id = ctxTargetId;
    const removed = messages.find(m => m.id === id);
    messages = messages.filter(m => m.id !== id);
    ctxMenu.classList.remove('open'); ctxTargetId = null;
    renderMessages(); renderChats();
    API.deleteMessage(id).catch(() => {});
    if (!removed) return;
    toast('Сообщение удалено', {
      type: 'info', duration: 5000,
      action: {
        label: 'Отменить', onClick: async () => {
          try {
            const extra = extractExtra(removed);
            const sm = await API.sendMessage(removed.chatId, { type: removed.type, content: removed.content, extra });
            applyServerMessage(sm); renderMessages(); renderChats();
            toast('Восстановлено', 'success');
          } catch { toast('Не удалось восстановить', 'error'); }
        }
      }
    });
  };

  // ---------- СОЗДАНИЕ ЧАТОВ ----------
  // Новый личный чат
  let searchTimer = null;
  renderNewChatUsers = function () {
    const list = $('new-chat-users');
    const q = $('new-chat-search').value.trim();
    if (q.length < 3) {
      list.innerHTML = `<div class="user-list-empty">Введите минимум 3 символа юзернейма или номер телефона — покажем подходящих людей.</div>`;
      return;
    }
    list.innerHTML = `<div class="user-list-empty">Поиск…</div>`;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      let found = [];
      try { found = await API.searchUsers(q); } catch {}
      const myPrefs = (typeof prefs !== 'undefined' && prefs[session]) || {};
      const blocked = myPrefs.blocked || [];
      found = found.filter(u => u.id !== session && !blocked.includes(u.id));
      if (!found.length) { list.innerHTML = `<div class="user-list-empty">Никто не найден. Проверьте юзернейм или номер.</div>`; return; }
      list.innerHTML = '';
      for (const su of found) {
        const d = normUser(su); upsertUser(d);  // запомним карточку, чтобы шифрование нашло pubkey
        const div = document.createElement('div'); div.className = 'user-list-item';
        div.innerHTML = `<div class="avatar-wrap"><div class="avatar"></div></div>
          <div class="user-list-item-name"></div>
          <button class="msg-chat-btn" title="Написать">💬</button>`;
        setAvatar(div.querySelector('.avatar'), d);
        const spadm = d.isAdmin ? ' <span class="spadm-badge">SPADM</span>' : '';
        div.querySelector('.user-list-item-name').innerHTML =
          `${escapeHtml(d.name)}${spadm}<div style="font-size:12px;color:var(--text-muted)">@${escapeHtml(d.username)}</div>`;
        const openDM = async () => {
          // все ЛС секретные
          const existing = chats.find(c => c.type === 'dm' && c.secret &&
            c.members.length === 2 && c.members.includes(session) && c.members.includes(d.id));
          if (existing) { closeModal('new-chat-modal'); openChat(existing.id); return; }
          try {
            const c = normChat(await API.createChat({ type: 'dm', withUserId: d.id, secret: true }));
            upsertChat(c); closeModal('new-chat-modal'); renderChats(); openChat(c.id);
          } catch (e) { toast(e.message || 'Не удалось создать чат', 'error'); }
        };
        div.onclick = openDM;
        list.appendChild(div);
      }
    }, 300);
  };
  // переопределяем обработчик ввода: app.js забиндил старую ссылку до нашего override
  if ($('new-chat-search')) $('new-chat-search').oninput = renderNewChatUsers;
  if ($('btn-new-chat')) $('btn-new-chat').onclick = () => {
    $('new-chat-search').value = ''; renderNewChatUsers(); openModal('new-chat-modal');
  };

  // Создание группы
  $('btn-create-group').onclick = async () => {
    const name = $('group-name').value.trim(); const err = $('group-error'); err.textContent = '';
    if (!name) return err.textContent = 'Введите название.';
    const checked = [...$('new-group-users').querySelectorAll('input:checked')].map(cb => cb.dataset.uid);
    if (!checked.length) return err.textContent = 'Выберите участников.';
    try {
      const c = normChat(await API.createChat({ type: 'group', name, memberIds: checked }));
      upsertChat(c); closeModal('new-group-modal'); renderChats(); openChat(c.id);
    } catch (e) { err.textContent = 'Ошибка создания группы'; }
  };

  // Создание канала
  if ($('btn-do-create-channel')) $('btn-do-create-channel').onclick = async () => {
    const name = $('new-channel-name').value.trim(); const desc = $('new-channel-desc').value.trim();
    const err = $('create-channel-error'); err.textContent = '';
    if (!name) return err.textContent = 'Название.';
    let avatar = '';
    try { avatar = (typeof newChannelAvatarData !== 'undefined' && newChannelAvatarData) || ''; } catch {}
    try {
      const c = normChat(await API.createChat({ type: 'channel', name, description: desc, avatar }));
      upsertChat(c); closeModal('create-channel-modal'); renderChats(); openChat(c.id);
    } catch (e) { err.textContent = 'Ошибка создания канала'; }
  };

  // Подписка на канал
  toggleSubscribe = async function (channelId) {
    try {
      const c = normChat(await API.chatAction(channelId, { action: 'subscribe' }));
      upsertChat(c); renderChats(); if (currentChatId === channelId) openChat(channelId);
    } catch (e) { toast('Не удалось изменить подписку', 'error'); }
  };

  // Управление участниками группы
  if ($('btn-confirm-add-members')) $('btn-confirm-add-members').onclick = async () => {
    const chat = chats.find(c => c.id === currentChatId); if (!chat) return;
    const checked = [...$('add-members-list').querySelectorAll('input:checked')].map(cb => cb.dataset.uid);
    if (!checked.length) { toast('Никто не выбран', 'info'); return; }
    try {
      const c = normChat(await API.chatAction(chat.id, { action: 'addMembers', memberIds: checked }));
      upsertChat(c);
      if (typeof openGroupInfo === 'function') openGroupInfo();
      toast(`Добавлено: ${checked.length}`, 'success');
    } catch (e) { toast('Ошибка', 'error'); }
  };
  if ($('btn-leave-group')) $('btn-leave-group').onclick = async () => {
    const chat = chats.find(c => c.id === currentChatId); if (!chat) return;
    if (!confirm(`Покинуть «${chat.name}»?`)) return;
    try {
      await API.chatAction(chat.id, { action: 'leave' });
      chats = chats.filter(c => c.id !== chat.id);
      closeModal('group-info-modal'); closeChat(); renderChats();
      toast('Вы покинули группу', 'info');
    } catch (e) { toast('Ошибка', 'error'); }
  };
  // удаление участника (kick) — переопределяем openGroupInfo рендер кнопок через делегирование
  document.addEventListener('click', async (e) => {
    const kb = e.target.closest('[data-kick]');
    if (!kb) return;
    const chat = chats.find(c => c.id === currentChatId); if (!chat) return;
    const mid = kb.dataset.kick;
    try {
      const c = normChat(await API.chatAction(chat.id, { action: 'removeMember', memberId: mid }));
      upsertChat(c);
      if (typeof openGroupInfo === 'function') openGroupInfo();
      toast('Участник удалён', 'info');
    } catch (err2) { toast('Ошибка', 'error'); }
  }, true);

  // ---------- ПРОФИЛЬ ----------
  $('btn-save-profile').onclick = async () => {
    const u = me(); if (!u) return;
    const err = $('profile-error'); err.textContent = '';
    const payload = {
      name: $('profile-name').value.trim(),
      username: $('profile-username').value.trim(),
      bio: $('profile-bio').value.trim(),
      status: $('profile-status').value.trim(),
    };
    // настроение
    try {
      const moodEl = document.querySelector('#mood-picker span.active');
      if (moodEl) payload.mood = moodEl.dataset.mood || '';
    } catch {}
    // VIP-приписка
    if (u.isVip && $('profile-vip-tag')) payload.vipTag = $('profile-vip-tag').value.slice(0, 12);
    if ($('profile-password').value) payload.password = $('profile-password').value;
    if (!payload.name) return err.textContent = 'Введите имя.';
    try {
      const updated = normUser(await API.updateMe(payload));
      upsertUser(updated);
      if (payload.password) { /* токен пересоздан — перелогинимся прозрачно */ }
      refreshMe(); renderChats(); if (currentChatId) openChat(currentChatId);
      closeModal('profile-modal');
      toast('Профиль сохранён', 'success');
    } catch (e) { err.textContent = e.message || 'Ошибка сохранения'; }
  };
  $('profile-avatar-input').onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { $('profile-error').textContent = 'Макс 2 МБ.'; return; }
    const dataUrl = await fileToDataURL(file);
    try {
      const updated = normUser(await API.updateMe({ avatar: dataUrl }));
      upsertUser(updated);
      setAvatar($('profile-avatar'), { id: updated.id, name: updated.name, avatar: updated.avatar });
      refreshMe(); renderChats(); if (currentChatId) renderMessages();
    } catch { toast('Не удалось загрузить аватар', 'error'); }
  };
  $('btn-remove-avatar').onclick = async () => {
    try {
      const updated = normUser(await API.updateMe({ avatar: '' }));
      upsertUser(updated);
      setAvatar($('profile-avatar'), { id: updated.id, name: updated.name, avatar: null });
      refreshMe(); renderChats();
    } catch { toast('Ошибка', 'error'); }
  };
  if ($('btn-become-vip')) $('btn-become-vip').onclick = async () => {
    const u = me(); if (!u) return;
    const next = !u.isVip;
    if (!confirm(next ? 'Активировать VIP (демо)?' : 'Снять VIP-статус?')) return;
    try {
      const updated = normUser(await API.updateMe({ isVip: next }));
      upsertUser(updated);
      refreshMe(); renderChats();
      $('vip-banner').classList.toggle('active', next);
      $('vip-banner-title').textContent = next ? '👑 Вы VIP' : 'VIP-подписка';
      $('vip-banner-sub').textContent = next ? 'Все премиум-фичи активны' : 'Эксклюзивные фичи скоро';
      $('btn-become-vip').textContent = next ? 'Отключить VIP (демо)' : 'Стать VIP — скоро';
      if (next) closeModal('vip-modal');
    } catch { toast('Ошибка', 'error'); }
  };

  // ---------- ЗАГРУЗКА МЕДИА ФАЙЛАМИ (вместо data-url) ----------
  const MAX_UPLOAD = 25 * 1024 * 1024;
  $('file-input').onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file || !currentChatId) return;
    if (file.size > MAX_UPLOAD) { toast('Файл больше 25 МБ', 'error'); return; }
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    const type = isImage ? 'image' : isVideo ? 'video' : 'file';
    const chat = chats.find(c => c.id === currentChatId);
    try {
      if (chat && chat.secret) {
        // секретный чат: шифруем байты перед загрузкой
        toast('Шифрование и загрузка…', 'info', 1500);
        const buf = await file.arrayBuffer();
        const { ct, iv } = await encryptBytes(chat, buf);
        const encFile = new File([ct], 'enc.bin', { type: 'application/octet-stream' });
        const up = await API.upload(encFile);
        sendMessage({ type, content: up.url, mediaEnc: true, miv: iv, mmime: file.type, mname: file.name, fileName: file.name, fileSize: file.size });
      } else {
        toast('Загрузка файла…', 'info', 1500);
        const up = await API.upload(file);
        if (isImage) sendMessage({ type: 'image', content: up.url });
        else if (isVideo) sendMessage({ type: 'video', content: up.url });
        else sendMessage({ type: 'file', content: up.url, fileName: up.name, fileSize: up.size, fileMime: up.mime });
      }
    } catch (err) { toast('Не удалось загрузить файл', 'error'); }
  };
  if ($('album-input')) $('album-input').onchange = async (e) => {
    const files = [...e.target.files].slice(0, 10); e.target.value = '';
    if (!files.length || !currentChatId) return;
    toast('Загрузка альбома…', 'info', 1500);
    const urls = [];
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > MAX_UPLOAD) { toast(`"${f.name}" больше 25 МБ — пропущен`, 'error'); continue; }
      try { const up = await API.upload(f); urls.push(up.url); } catch {}
    }
    if (!urls.length) return;
    if (urls.length === 1) sendMessage({ type: 'image', content: urls[0] });
    else sendMessage({ type: 'album', album: urls, content: '' });
  };
  // голос/видео-сообщения: загружаем blob файлом, если запись доступна
  window.__uploadBlobAndSend = async (blob, type, duration) => {
    try {
      const ext = type === 'voice' ? 'webm' : 'webm';
      const file = new File([blob], 'rec.' + ext, { type: blob.type || 'application/octet-stream' });
      if (file.size > MAX_UPLOAD) { toast('Запись больше 25 МБ', 'error'); return; }
      const up = await API.upload(file);
      sendMessage({ type, content: up.url, duration });
    } catch { toast('Не удалось отправить запись', 'error'); }
  };

  // ---------- ИСТОРИИ НА СЕРВЕРЕ ----------
  if ($('story-input')) $('story-input').onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (file.size > MAX_UPLOAD) { toast('Файл больше 25 МБ', 'error'); return; }
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) { toast('Только фото/видео', 'error'); return; }
    try {
      toast('Публикация истории…', 'info', 1500);
      const up = await API.upload(file);
      const s = await API.createStory({ type: isImage ? 'image' : 'video', content: up.url });
      if (typeof stories !== 'undefined') { stories.push(normStory(s)); save(DB.stories, stories); }
      if (typeof renderStoriesBar === 'function') renderStoriesBar();
      toast('История опубликована', 'success');
    } catch { toast('Не удалось опубликовать историю', 'error'); }
  };
  if ($('story-delete')) $('story-delete').onclick = async () => {
    try {
      const list = (typeof visibleStories === 'function' ? visibleStories() : stories)
        .filter(s => s.userId === viewerUserId).sort((a, b) => a.timestamp - b.timestamp);
      const cur = list[viewerIndex]; if (!cur) return;
      try { await API.deleteStory(cur.id); } catch {}
      stories = stories.filter(s => s.id !== cur.id); save(DB.stories, stories);
      if (typeof renderStoriesBar === 'function') renderStoriesBar();
      if (typeof closeStoryViewer === 'function') closeStoryViewer();
    } catch {}
  };
  if (typeof openStoryViewer === 'function') {
    const _openStoryViewer = openStoryViewer;
    openStoryViewer = function (userId) {
      _openStoryViewer(userId);
      try {
        (stories || []).filter(s => s.userId === userId).forEach(s => {
          s.viewedBy = s.viewedBy || [];
          if (!s.viewedBy.includes(session)) { s.viewedBy.push(session); API.viewStory(s.id).catch(() => {}); }
        });
        save(DB.stories, stories);
      } catch {}
    };
  }

  // ---------- ЗАКРЕПЛЁННЫЕ СООБЩЕНИЯ НА СЕРВЕРЕ ----------
  $('ctx-pin').onclick = async () => {
    if (!ctxTargetId || !currentChatId) return;
    const chat = chats.find(c => c.id === currentChatId); if (!chat) return;
    const newPin = chat.pinnedId === ctxTargetId ? '' : ctxTargetId;
    ctxMenu.classList.remove('open');
    try {
      const c = normChat(await API.chatAction(currentChatId, { action: 'pin', messageId: newPin }));
      upsertChat(c);
      if (typeof renderPinned === 'function') renderPinned();
      renderMessages();
    } catch { toast('Не удалось закрепить', 'error'); }
  };
  if ($('pinned-unpin')) $('pinned-unpin').onclick = async (e) => {
    e.stopPropagation();
    if (!currentChatId) return;
    try {
      const c = normChat(await API.chatAction(currentChatId, { action: 'pin', messageId: '' }));
      upsertChat(c);
      if (typeof renderPinned === 'function') renderPinned();
    } catch {}
  };

  // ---------- ОТКРЫТИЕ ЧАТА: подтянуть историю с сервера ----------
  const _openChatServer = window.openChat || openChat;
  // 🔒 в названии секретных чатов везде (список, шапка, поиск)
  // все ЛС зашифрованы — отдельной метки в заголовке не добавляем (показываем в шапке)
  // в секретном чате: текст + эмодзи + зашифрованные фото/видео/файлы (attach).
  // прячем то, что сервер увидел бы открытым: голос/видеосообщения, опросы/гео/игры (плюс-меню)
  function applySecretChatUI(id) {
    const chat = chats.find(c => c.id === id);
    const secret = !!(chat && chat.secret);
    if ($('btn-attach')) $('btn-attach').style.display = '';   // attach разрешён (шифруется)
    ['btn-voice', 'btn-plus-menu', 'btn-video-msg'].forEach(bid => {
      const b = $(bid); if (b) b.style.display = secret ? 'none' : '';
    });
    let note = $('secret-note');
    if (secret) {
      if (!note) {
        note = document.createElement('div');
        note.id = 'secret-note';
        note.style.cssText = 'font-size:11.5px;color:var(--online);text-align:center;padding:4px;';
        note.textContent = '🔒 Зашифровано сквозным шифрованием — сервер не видит содержимое.';
        const comp = document.querySelector('.composer');
        if (comp && comp.parentNode) comp.parentNode.insertBefore(note, comp);
      }
      note.style.display = '';
    } else if (note) { note.style.display = 'none'; }
  }
  window.openChat = function (id) {
    _openChatServer(id);
    applySecretChatUI(id);
    reconcileChat(id).then(() => { if (currentChatId === id) renderMessages(); decryptPending(); decryptMediaPending(); });
  };

  // ---------- ПАНЕЛЬ МОДЕРАЦИИ (для админа) ----------
  let reportsCache = [];
  function isAdmin() { const u = me(); return !!(u && u.isAdmin); }
  function refreshModBadge() {
    const btn = $('btn-moderation'), badge = $('mod-badge');
    if (!btn) return;
    if (!isAdmin()) { btn.style.display = 'none'; return; }
    btn.style.display = '';
    const n = reportsCache.filter(r => !r.resolved).length;
    if (badge) {
      if (n > 0) { badge.textContent = n > 99 ? '99+' : n; badge.style.display = ''; }
      else badge.style.display = 'none';
    }
  }
  async function loadReports() {
    if (!isAdmin()) return;
    try { reportsCache = await API.reports(); refreshModBadge(); } catch {}
  }
  function onNewReport(report) {
    if (!isAdmin()) return;
    const i = reportsCache.findIndex(r => r.id === report.id);
    if (i === -1) reportsCache.unshift(report); else reportsCache[i] = report;
    refreshModBadge();
    try { toast(`⚠ Жалоба: @${report.offender} (${report.category})`, 'error', 5000); } catch {}
    if ($('moderation-modal').classList.contains('open')) renderReports();
  }
  function renderReports() {
    const list = $('reports-list');
    const items = reportsCache.filter(r => !r.resolved);
    if (!items.length) { list.innerHTML = '<div class="reports-empty">Жалоб нет 👍</div>'; return; }
    list.innerHTML = '';
    for (const r of items) {
      const d = new Date(r.timestamp);
      const card = document.createElement('div');
      card.className = 'report-card';
      card.innerHTML = `
        <div class="rc-top">
          <span class="rc-cat">${escapeHtml(r.category)}</span>
          <span class="rc-user">@${escapeHtml(r.offender)}</span>
          <span class="rc-time">${d.toLocaleString('ru-RU')}</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted)">${r.context === 'profile' ? 'в профиле' : 'в сообщении'} · совпало: <span class="rc-term">${escapeHtml(r.term)}</span></div>
        <div class="rc-content">${escapeHtml(r.content || '')}</div>
        <div style="display:flex;gap:8px">
          <button class="rc-resolve" data-resolve="${r.id}">✓ Решено</button>
          ${r.offenderId ? `<button class="rc-ban" data-ban="${r.offenderId}" data-user="${escapeHtml(r.offender)}">🚫 Забанить</button>` : ''}
        </div>`;
      card.querySelector('[data-resolve]').onclick = async () => {
        try { await API.resolveReport(r.id); r.resolved = true; renderReports(); refreshModBadge(); } catch {}
      };
      const banBtn = card.querySelector('[data-ban]');
      if (banBtn) banBtn.onclick = async () => {
        if (!confirm(`Забанить @${banBtn.dataset.user}? Он не сможет войти (можно разбанить через Django-админку).`)) return;
        try {
          await API.banUser(banBtn.dataset.ban, true);
          await API.resolveReport(r.id); r.resolved = true;
          renderReports(); refreshModBadge();
          toast(`@${banBtn.dataset.user} забанен`, 'success');
        } catch (e) { toast(e.message || 'Не удалось забанить', 'error'); }
      };
      list.appendChild(card);
    }
  }
  if ($('btn-moderation')) $('btn-moderation').onclick = async () => {
    await loadReports(); renderReports(); openModal('moderation-modal');
  };

  // ---------- ЗНАЧОК SPADM У АДМИНОВ ----------
  if (typeof nameWithVipHTML === 'function') {
    const _nameWithVipAdmin = nameWithVipHTML;
    nameWithVipHTML = function (d) {
      let base = _nameWithVipAdmin(d);
      const real = d && d.id && realUser(d.id);
      if (real && real.isAdmin) base += ' <span class="spadm-badge">SPADM</span>';
      return base;
    };
  }
  // показать телефон в профиле при открытии
  const _openProfilePhone = $('btn-profile').onclick;
  $('btn-profile').onclick = function () {
    if (_openProfilePhone) _openProfilePhone();
    const u = me();
    if (u && $('profile-phone')) $('profile-phone').value = u.phone || '';
  };
  // сохранить телефон вместе с профилем
  const _saveProfilePhone = $('btn-save-profile').onclick;
  $('btn-save-profile').onclick = async function () {
    // временно подменим updateMe, чтобы добавить phone? Проще — отдельный вызов после
    if (_saveProfilePhone) _saveProfilePhone.call(this);
    const phone = $('profile-phone') ? $('profile-phone').value.trim() : '';
    if (phone !== undefined) {
      try { const u = await API.updateMe({ phone }); upsertUser(normUser(u)); } catch (e) { if (e && e.message) toast(e.message, 'error'); }
    }
  };

  // ---------- ИНИЦИАЛИЗАЦИЯ ----------
  async function init() {
    // нейтрализуем старый локальный автологин
    stopPolling();
    if (!token) {
      $('main-screen').classList.remove('active');
      $('auth-screen').classList.add('active');
      return;
    }
    try {
      const meU = await API.me();
      await serverBootstrap(meU);
      finishEnter();
      startPolling(); connectWS();
      loadReports();
    } catch (e) {
      // токен невалиден или сервер недоступен
      token = null; localStorage.removeItem(TOKEN_KEY);
      $('main-screen').classList.remove('active');
      $('auth-screen').classList.add('active');
      if (e && e.status !== 401) {
        toast('Сервер недоступен. Запустите backend (manage.py runserver).', 'error', 6000);
      }
    }
  }
  // запускаем после полной загрузки app.js
  init();
})();
