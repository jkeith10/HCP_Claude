'use strict';

// --- Session + auth state ---------------------------------------------------
const SESSION_KEY = 'hvac_session_id';
const PW_KEY = 'hvac_app_password';

let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId =
    (crypto.randomUUID && crypto.randomUUID()) ||
    's_' + Math.random().toString(36).slice(2) + Date.now();
  localStorage.setItem(SESSION_KEY, sessionId);
}
let appPassword = localStorage.getItem(PW_KEY) || '';

// --- Elements ---------------------------------------------------------------
const el = (id) => document.getElementById(id);
const loginView = el('login');
const appView = el('app');
const messagesEl = el('messages');
const inputEl = el('input');
const sendBtn = el('send-btn');
const micBtn = el('mic-btn');
const resetBtn = el('reset-btn');

let busy = false;

// --- Helpers ----------------------------------------------------------------
function headers(extra = {}) {
  const h = { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...extra };
  if (appPassword) h['x-app-password'] = appPassword;
  return h;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function addTyping() {
  const div = document.createElement('div');
  div.className = 'typing';
  div.textContent = 'Assistant is thinking…';
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function speak(text) {
  if (!window.speechSynthesis || !text) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.slice(0, 600));
    u.rate = 1.05;
    window.speechSynthesis.speak(u);
  } catch {
    /* ignore */
  }
}

// --- Rendering assistant results -------------------------------------------
function renderResult(result) {
  if (result.type === 'message') {
    addMessage('assistant', result.text || '(no response)');
    speak(result.text);
  } else if (result.type === 'confirm') {
    renderConfirm(result);
  }
}

function renderConfirm(result) {
  if (result.preamble) addMessage('assistant', result.preamble);

  const card = document.createElement('div');
  card.className = 'confirm';
  card.dataset.resolved = 'false';

  const h4 = document.createElement('h4');
  h4.textContent = '⚠ Confirm action';
  card.appendChild(h4);

  for (const action of result.actions) {
    const a = document.createElement('div');
    a.className = 'action';
    const tool = document.createElement('div');
    tool.className = 'tool';
    tool.textContent = action.tool;
    const summary = document.createElement('div');
    summary.textContent = action.summary;
    a.appendChild(tool);
    a.appendChild(summary);

    const details = document.createElement('details');
    const sm = document.createElement('summary');
    sm.textContent = 'Details';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(action.input, null, 2);
    details.appendChild(sm);
    details.appendChild(pre);
    a.appendChild(details);
    card.appendChild(a);
  }

  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const approve = document.createElement('button');
  approve.className = 'approve';
  approve.textContent = 'Confirm';
  const cancel = document.createElement('button');
  cancel.className = 'cancel';
  cancel.textContent = 'Cancel';
  buttons.appendChild(cancel);
  buttons.appendChild(approve);
  card.appendChild(buttons);

  const resolve = async (approved) => {
    if (card.dataset.resolved === 'true') return;
    card.dataset.resolved = 'true';
    const note = document.createElement('div');
    note.className = 'resolution';
    note.textContent = approved ? '✓ Confirmed — performing…' : '✕ Cancelled.';
    card.appendChild(note);
    await sendConfirm(approved, note);
  };
  approve.addEventListener('click', () => resolve(true));
  cancel.addEventListener('click', () => resolve(false));

  messagesEl.appendChild(card);
  scrollToBottom();
}

// --- Network ----------------------------------------------------------------
async function sendMessage(text) {
  if (busy) return;
  busy = true;
  setComposerEnabled(false);
  addMessage('user', text);
  const typing = addTyping();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ message: text }),
    });
    typing.remove();
    if (res.status === 401) return handleUnauthorized();
    const data = await res.json();
    if (!res.ok) {
      addMessage('error', data.error || 'Something went wrong.');
    } else {
      renderResult(data);
    }
  } catch (err) {
    typing.remove();
    addMessage('error', 'Network error: ' + err.message);
  } finally {
    busy = false;
    setComposerEnabled(true);
    inputEl.focus();
  }
}

async function sendConfirm(approved, noteEl) {
  busy = true;
  setComposerEnabled(false);
  const typing = addTyping();
  try {
    const res = await fetch('/api/confirm', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ approved }),
    });
    typing.remove();
    if (res.status === 401) return handleUnauthorized();
    const data = await res.json();
    if (!res.ok) {
      addMessage('error', data.error || 'Something went wrong.');
    } else {
      if (noteEl) noteEl.textContent = approved ? '✓ Confirmed.' : '✕ Cancelled.';
      renderResult(data);
    }
  } catch (err) {
    typing.remove();
    addMessage('error', 'Network error: ' + err.message);
  } finally {
    busy = false;
    setComposerEnabled(true);
  }
}

async function resetConversation() {
  try {
    await fetch('/api/reset', { method: 'POST', headers: headers() });
  } catch {
    /* ignore */
  }
  messagesEl.innerHTML = '';
  addMessage('system', 'New conversation started.');
}

// --- Auth flow --------------------------------------------------------------
function handleUnauthorized() {
  appPassword = '';
  localStorage.removeItem(PW_KEY);
  showLogin();
  busy = false;
  setComposerEnabled(true);
}

function showLogin() {
  appView.classList.add('hidden');
  loginView.classList.remove('hidden');
  el('login-password').focus();
}

function showApp() {
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
  if (!messagesEl.children.length) {
    addMessage(
      'system',
      "Connected. Ask about today's schedule, a customer, unpaid invoices, or unsigned estimates.",
    );
  }
  inputEl.focus();
}

async function verifyPassword(pw) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-password': pw },
  });
  const data = await res.json();
  return Boolean(data.ok);
}

async function init() {
  let authRequired = false;
  try {
    const cfg = await (await fetch('/api/config')).json();
    authRequired = cfg.authRequired;
  } catch {
    /* default to no auth */
  }

  if (!authRequired) {
    appPassword = '';
    showApp();
    return;
  }
  if (appPassword && (await verifyPassword(appPassword))) {
    showApp();
  } else {
    showLogin();
  }
}

// --- Composer / input -------------------------------------------------------
function setComposerEnabled(enabled) {
  sendBtn.disabled = !enabled;
  inputEl.disabled = !enabled;
  micBtn.disabled = !enabled;
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
}

function submitInput() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = '';
  autoGrow();
  sendMessage(text);
}

// --- Voice input (Web Speech API) ------------------------------------------
function setupVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    micBtn.style.display = 'none';
    return;
  }
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;

  let listening = false;
  let base = '';

  rec.addEventListener('result', (e) => {
    let transcript = '';
    for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
    inputEl.value = (base ? base + ' ' : '') + transcript;
    autoGrow();
  });
  rec.addEventListener('end', () => {
    listening = false;
    micBtn.classList.remove('listening');
  });
  rec.addEventListener('error', () => {
    listening = false;
    micBtn.classList.remove('listening');
  });

  micBtn.addEventListener('click', () => {
    if (busy) return;
    if (listening) {
      rec.stop();
      return;
    }
    base = inputEl.value.trim();
    try {
      rec.start();
      listening = true;
      micBtn.classList.add('listening');
    } catch {
      /* already started */
    }
  });
}

// --- Wire up events ---------------------------------------------------------
sendBtn.addEventListener('click', submitInput);
inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitInput();
  }
});
resetBtn.addEventListener('click', resetConversation);

el('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = el('login-password').value;
  const errEl = el('login-error');
  errEl.classList.add('hidden');
  if (await verifyPassword(pw)) {
    appPassword = pw;
    localStorage.setItem(PW_KEY, pw);
    showApp();
  } else {
    errEl.classList.remove('hidden');
  }
});

setupVoice();
init();

// Register service worker for installability (best-effort).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
