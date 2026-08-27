/**
 * CoreLink 3D — Backend Server
 * Node.js / Express
 * Features: GLB serving, AI chat (Ollama + vLLM), Session Management
 */

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const fetch    = require('node-fetch');
const cors     = require('cors');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();

// ── Config ────────────────────────────────────────────────────
const PORT          = process.env.PORT          || 3000;
const OLLAMA_URL    = process.env.OLLAMA_URL    || 'http://localhost:11434';
const VLLM_URL      = process.env.VLLM_URL      || 'http://localhost:8000';
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL  || 'qwen2.5-coder:7b';
const VLLM_MODEL    = process.env.VLLM_MODEL    || 'Qwen/Qwen2.5-Coder-7B-Instruct';
// AI_BACKEND: "ollama" | "vllm"
const AI_BACKEND    = process.env.AI_BACKEND    || 'ollama';

const PUBLIC_DIR    = path.resolve(__dirname, '..', 'public');
const UPLOADS_DIR   = path.resolve(__dirname, '..', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── In-memory Session Store ───────────────────────────────────
// Map<sessionId, { id, createdAt, history: [{role, content}] }>
const sessions = new Map();
const fileOwners = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const OWNER_COOKIE = 'corelink_owner';
const FILE_OWNERS_PATH = path.join(UPLOADS_DIR, '.owners.json');

try {
  if (fs.existsSync(FILE_OWNERS_PATH)) {
    const storedOwners = JSON.parse(fs.readFileSync(FILE_OWNERS_PATH, 'utf8'));
    Object.entries(storedOwners).forEach(([filename, owner]) => fileOwners.set(filename, owner));
  }
} catch (err) {
  console.warn('[storage] Could not restore file ownership metadata:', err.message);
}

function persistFileOwners() {
  fs.writeFileSync(FILE_OWNERS_PATH, JSON.stringify(Object.fromEntries(fileOwners)), { mode: 0o600 });
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    const value = part.slice(index + 1).trim();
    try {
      return [part.slice(0, index).trim(), decodeURIComponent(value)];
    } catch {
      return [part.slice(0, index).trim(), ''];
    }
  }));
}

function getOwnerToken(req) {
  return parseCookies(req)[OWNER_COOKIE] || null;
}

function setOwnerCookie(res, token) {
  res.setHeader('Set-Cookie', `${OWNER_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
}

function ensureOwner(req, res) {
  const existing = getOwnerToken(req);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  setOwnerCookie(res, token);
  return token;
}

function requireOwner(req, res, next) {
  if (!getOwnerToken(req)) return res.status(401).json({ error: 'Session ownership is required' });
  next();
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  s.lastActive = Date.now();
  return s;
}

function createSession() {
  const id = uuidv4();
  const session = { id, createdAt: Date.now(), lastActive: Date.now(), history: [] };
  sessions.set(id, session);
  return session;
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL_MS) sessions.delete(id);
  }
}

function getFileOwner(filename) {
  return fileOwners.get(filename) || null;
}

setInterval(pruneExpiredSessions, 15 * 60 * 1000); // prune every 15 min

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// ── Multer ────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, file, cb) => {
    const safe = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.glb' || ext === '.gltf') return cb(null, true);
    cb(new Error('Only .glb and .gltf files are accepted'));
  },
});

// ── Helper: fetch with manual timeout ────────────────────────
function fetchWithTimeout(url, opts = {}, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ── AI Adapters ───────────────────────────────────────────────

/**
 * Send chat to Ollama (non-streaming).
 * @param {Array<{role,content}>} messages
 * @returns {Promise<string>} response text
 */
async function ollamaChat(messages) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.message?.content || '';
}

/**
 * Stream chat from Ollama via SSE.
 * @param {Array<{role,content}>} messages
 * @param {import('express').Response} res
 */
async function ollamaChatStream(messages, res) {
  const ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true }),
  });
  if (!ollamaRes.ok) throw new Error(`Ollama HTTP ${ollamaRes.status}`);

  for await (const chunk of ollamaRes.body) {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        res.write(`data: ${JSON.stringify({ token: parsed.message?.content || '', done: parsed.done })}\n\n`);
        if (parsed.done) return;
      } catch { /* skip malformed */ }
    }
  }
}

/**
 * Send chat to vLLM OpenAI-compatible API (non-streaming).
 * @param {Array<{role,content}>} messages
 * @returns {Promise<string>} response text
 */
async function vllmChat(messages) {
  const res = await fetch(`${VLLM_URL}/v1/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model:       VLLM_MODEL,
      messages,
      max_tokens:  2048,
      temperature: 0.7,
    }),
  });
  if (!res.ok) throw new Error(`vLLM HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Stream chat from vLLM via SSE.
 * @param {Array<{role,content}>} messages
 * @param {import('express').Response} res
 */
async function vllmChatStream(messages, res) {
  const vllmRes = await fetch(`${VLLM_URL}/v1/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model:       VLLM_MODEL,
      messages,
      max_tokens:  2048,
      temperature: 0.7,
      stream:      true,
    }),
  });
  if (!vllmRes.ok) throw new Error(`vLLM HTTP ${vllmRes.status}`);

  for await (const chunk of vllmRes.body) {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') {
        res.write(`data: ${JSON.stringify({ token: '', done: true })}\n\n`);
        return;
      }
      try {
        const parsed = JSON.parse(payload);
        const token = parsed.choices?.[0]?.delta?.content || '';
        res.write(`data: ${JSON.stringify({ token, done: false })}\n\n`);
      } catch { /* skip */ }
    }
  }
}

// ── Routes: Health ────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status:    'ok',
    backend:   AI_BACKEND,
    model:     AI_BACKEND === 'vllm' ? VLLM_MODEL : OLLAMA_MODEL,
    sessions:  sessions.size,
  });
});

// ── Routes: Sessions ──────────────────────────────────────────

// Create a new session
app.post('/api/session', (req, res) => {
  const owner = ensureOwner(req, res);
  const session = createSession();
  session.owner = owner;
  res.json({ sessionId: session.id, createdAt: session.createdAt });
});

// Get session info + history
app.get('/api/session/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session || session.owner !== getOwnerToken(req)) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({ sessionId: session.id, history: session.history, messageCount: session.history.length });
});

// Clear session history
app.delete('/api/session/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session || session.owner !== getOwnerToken(req)) return res.status(404).json({ error: 'Session not found' });
  session.history = [];
  res.json({ success: true });
});

// List all active sessions
app.get('/api/sessions', (req, res) => {
  const owner = getOwnerToken(req);
  const list = [...sessions.values()].filter(s => s.owner === owner).map(s => ({
    id:           s.id,
    createdAt:    s.createdAt,
    lastActive:   s.lastActive,
    messageCount: s.history.length,
  }));
  res.json({ sessions: list });
});

// ── Routes: AI Chat ───────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { prompt, sessionId, stream = false } = req.body;

  if (!prompt || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
    return res.status(400).json({ error: 'prompt is required and must be a non-empty string' });
  }

  const normalizedPrompt = prompt.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  const owner = ensureOwner(req, res);

  // Resolve or create session
  let session = sessionId ? getSession(sessionId) : null;
  if (session && session.owner !== owner) return res.status(403).json({ error: 'Session access denied' });
  if (!session) {
    session = createSession();
    session.owner = owner;
  }

  // Append user message to session history
  session.history.push({ role: 'user', content: normalizedPrompt });

  // Keep last 20 messages to avoid context overflow
  const messages = session.history.slice(-20);

  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(`data: ${JSON.stringify({ sessionId: session.id })}\n\n`);

      // Collect streamed tokens to save to history
      let fullResponse = '';
      const originalWrite = res.write.bind(res);
      res.write = (chunk) => {
        try {
          const str = chunk.toString();
          const match = str.match(/^data: (.+)\n\n$/);
          if (match) {
            const parsed = JSON.parse(match[1]);
            if (parsed.token) fullResponse += parsed.token;
          }
        } catch { /* no-op */ }
        return originalWrite(chunk);
      };

      if (AI_BACKEND === 'vllm') {
        await vllmChatStream(messages, res);
      } else {
        await ollamaChatStream(messages, res);
      }

      // Save assistant reply to session
      if (fullResponse) session.history.push({ role: 'assistant', content: fullResponse });
      res.end();

    } else {
      let responseText = '';
      if (AI_BACKEND === 'vllm') {
        responseText = await vllmChat(messages);
      } else {
        responseText = await ollamaChat(messages);
      }

      session.history.push({ role: 'assistant', content: responseText });

      res.json({
        response:  responseText,
        sessionId: session.id,
        model:     AI_BACKEND === 'vllm' ? VLLM_MODEL : OLLAMA_MODEL,
        backend:   AI_BACKEND,
        turns:     Math.floor(session.history.length / 2),
      });
    }

  } catch (err) {
    console.error('[/api/chat]', err.message);
    // Roll back the user message if AI failed
    session.history.pop();

    if (!res.headersSent) {
      res.status(503).json({
        error:     'AI service unavailable',
        backend:   AI_BACKEND,
        details:   'The configured AI backend did not complete the request.',
        hint:      AI_BACKEND === 'vllm'
          ? 'Make sure vLLM is running: python -m vllm.entrypoints.openai.api_server --model ' + VLLM_MODEL
          : 'Make sure Ollama is running: ollama serve',
      });
    }
  }
});

// ── Routes: AI Status ─────────────────────────────────────────

app.get('/api/ai/status', async (_req, res) => {
  const result = { backend: AI_BACKEND, ollama: null, vllm: null };

  // Check Ollama
  try {
    const r = await fetchWithTimeout(`${OLLAMA_URL}/api/tags`, {}, 3000);
    const data = await r.json();
    const models = data.models?.map(m => m.name) || [];
    result.ollama = {
      online:         true,
      url:            OLLAMA_URL,
      models,
      targetModel:    OLLAMA_MODEL,
      modelAvailable: models.some(m => m.startsWith(OLLAMA_MODEL.split(':')[0])),
    };
  } catch {
    result.ollama = { online: false, url: OLLAMA_URL, models: [], targetModel: OLLAMA_MODEL, modelAvailable: false };
  }

  // Check vLLM
  try {
    const r = await fetchWithTimeout(`${VLLM_URL}/v1/models`, {}, 3000);
    const data = await r.json();
    const models = data.data?.map(m => m.id) || [];
    result.vllm = {
      online:         true,
      url:            VLLM_URL,
      models,
      targetModel:    VLLM_MODEL,
      modelAvailable: models.includes(VLLM_MODEL),
    };
  } catch {
    result.vllm = { online: false, url: VLLM_URL, models: [], targetModel: VLLM_MODEL, modelAvailable: false };
  }

  // Active backend status shortcut
  result.active = AI_BACKEND === 'vllm' ? result.vllm : result.ollama;
  res.json(result);
});

// ── Routes: GLB File Management ───────────────────────────────

app.post('/api/glb/upload', requireOwner, upload.single('model'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  fileOwners.set(req.file.filename, getOwnerToken(req));
  persistFileOwners();
  res.json({
    success:      true,
    filename:     req.file.filename,
    originalName: req.file.originalname,
    size:         req.file.size,
    url:          `/api/glb/file/${req.file.filename}`,
  });
});

app.get('/api/glb/file/:filename', requireOwner, (req, res) => {
  const filename = path.basename(req.params.filename);
  const owner = getFileOwner(filename);
  if (owner !== getOwnerToken(req)) return res.status(404).json({ error: 'File not found' });
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const ext  = path.extname(filePath).toLowerCase();
  const mime = ext === '.gltf' ? 'model/gltf+json' : 'model/gltf-binary';
  res.setHeader('Content-Type', mime);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(filename, { root: UPLOADS_DIR });
});

app.get('/api/glb/list', requireOwner, (req, res) => {
  const files = fs.readdirSync(UPLOADS_DIR)
    .filter(f => /\.(glb|gltf)$/i.test(f) && fileOwners.get(f) === getOwnerToken(req))
    .map(f => {
      const stat = fs.statSync(path.join(UPLOADS_DIR, f));
      return { filename: f, url: `/api/glb/file/${f}`, size: stat.size, uploadedAt: stat.mtimeMs };
    })
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
  res.json({ files, count: files.length });
});

app.delete('/api/glb/file/:filename', requireOwner, (req, res) => {
  const filename = path.basename(req.params.filename);
  if (getFileOwner(filename) !== getOwnerToken(req)) return res.status(404).json({ error: 'File not found' });
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  fs.unlinkSync(filePath);
  fileOwners.delete(filename);
  persistFileOwners();
  res.json({ success: true, deleted: filename });
});

// ── Catch-all: serve frontend ─────────────────────────────────
app.get(/^(?!\/api).*/, (_req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile('index.html', { root: PUBLIC_DIR });
  } else {
    res.sendFile('app.html', { root: PUBLIC_DIR });
  }
});

// ── Error handler ─────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.includes('only')) {
    return res.status(400).json({ error: err.message });
  }
  console.error('[server error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  const w = 44;
  const pad = (s) => s.padEnd(w - 4);
  console.log('\n' + '╔' + '═'.repeat(w) + '╗');
  console.log('║' + '      CoreLink 3D — Server Ready        '.padEnd(w) + '║');
  console.log('╠' + '═'.repeat(w) + '╣');
  console.log('║  ' + pad(`Local   : http://localhost:${PORT}`)      + '║');
  console.log('║  ' + pad(`Backend : ${AI_BACKEND.toUpperCase()}`)   + '║');
  console.log('║  ' + pad(`Model   : ${AI_BACKEND === 'vllm' ? VLLM_MODEL : OLLAMA_MODEL}`) + '║');
  console.log('║  ' + pad(`Uploads : ${UPLOADS_DIR}`)                + '║');
  console.log('╚' + '═'.repeat(w) + '╝\n');
});
