import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { runAssistant, resumeAfterConfirmation } from './assistant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// In-memory session store. Personal single-user tool: fine for one container.
// Each session holds the Claude `messages` array plus any pending write.
// Sessions expire after inactivity to bound memory.
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const sessions = new Map();

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, messages: [], pending: null, lastSeen: Date.now() };
    sessions.set(id, s);
  }
  s.lastSeen = Date.now();
  return s;
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(id);
}, 1000 * 60 * 15).unref();

// ---------------------------------------------------------------------------
// Optional shared-password gate. Uses a constant-time compare.
// ---------------------------------------------------------------------------
function passwordOk(supplied) {
  if (!config.appPassword) return true; // gate disabled
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(config.appPassword);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  if (passwordOk(req.get('x-app-password'))) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({ authRequired: Boolean(config.appPassword), model: config.anthropicModel });
});

// Verify a password without doing anything else (for the login screen).
app.post('/api/login', (req, res) => {
  res.json({ ok: passwordOk(req.get('x-app-password')) });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const sessionId = req.get('x-session-id');
  const message = (req.body?.message ?? '').toString().trim();
  if (!sessionId) return res.status(400).json({ error: 'Missing x-session-id header.' });
  if (!message) return res.status(400).json({ error: 'Empty message.' });

  const session = getSession(sessionId);
  if (session.pending) {
    return res
      .status(409)
      .json({ error: 'An action is awaiting your confirmation. Resolve it first.' });
  }

  session.messages.push({ role: 'user', content: message });
  try {
    const result = await runAssistant(session);
    res.json(result);
  } catch (err) {
    console.error('[chat] error:', err);
    res.status(500).json({ error: err.message || 'Assistant error.' });
  }
});

app.post('/api/confirm', requireAuth, async (req, res) => {
  const sessionId = req.get('x-session-id');
  const approved = Boolean(req.body?.approved);
  if (!sessionId) return res.status(400).json({ error: 'Missing x-session-id header.' });

  const session = getSession(sessionId);
  if (!session.pending) return res.status(409).json({ error: 'Nothing to confirm.' });

  try {
    const result = await resumeAfterConfirmation(session, approved);
    res.json(result);
  } catch (err) {
    console.error('[confirm] error:', err);
    res.status(500).json({ error: err.message || 'Assistant error.' });
  }
});

// Start a fresh conversation.
app.post('/api/reset', requireAuth, (req, res) => {
  const sessionId = req.get('x-session-id');
  if (sessionId) sessions.delete(sessionId);
  res.json({ ok: true });
});

// Static frontend (mobile PWA).
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(config.port, () => {
  console.log(`HVAC assistant running on http://localhost:${config.port}`);
  console.log(`  Model: ${config.anthropicModel}`);
  console.log(`  Housecall Pro base: ${config.housecallApiBase}`);
  console.log(`  Password gate: ${config.appPassword ? 'ENABLED' : 'disabled'}`);
});
