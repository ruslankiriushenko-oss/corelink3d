/**
 * CoreLink 3D — Backend Server
 * Node.js / Express
 * Features: static editor hosting, owner-scoped GLB storage
 */

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const cors     = require('cors');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto   = require('crypto');

const {
  httpsEnforcer,
  suspiciousRequestGuard,
  cspConfig,
  sanitizeFilename,
  isSafePath,
  validateModelFileBuffer,
  logSecurityEvent,
} = require('./middleware/security');

const app = express();

// ── Config ────────────────────────────────────────────────────
const PORT          = process.env.PORT          || 3000;

const PUBLIC_DIR    = path.resolve(__dirname, '..', 'public');
const UPLOADS_DIR   = path.resolve(__dirname, '..', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── File ownership ────────────────────────────────────────────
const fileOwners = new Map();
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
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${OWNER_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict${secureFlag}; Path=/; Max-Age=3600`);
}

function ensureOwner(req, res) {
  const existing = getOwnerToken(req);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  setOwnerCookie(res, token);
  return token;
}

function requireOwner(req, res, next) {
  let owner = getOwnerToken(req);
  if (!owner) {
    owner = ensureOwner(req, res);
  }
  req.ownerToken = owner;
  next();
}

function pruneStaleUploads() {
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    const now = Date.now();
    const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
    let changed = false;

    for (const file of files) {
      if (file.startsWith('.')) continue; // Keep dotfiles like .owners.json
      const filePath = path.join(UPLOADS_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          if (fileOwners.has(file)) {
            fileOwners.delete(file);
            changed = true;
          }
        }
      } catch { /* skip */ }
    }

    if (changed) persistFileOwners();
  } catch (err) {
    console.warn('[storage] Upload cleanup error:', err.message);
  }
}

function getFileOwner(filename) {
  return fileOwners.get(filename) || null;
}

setInterval(pruneStaleUploads, 60 * 60 * 1000);   // prune stale uploads every 1 hr
pruneStaleUploads(); // Initial run on startup

// ── Middleware ────────────────────────────────────────────────
app.disable('x-powered-by');
app.use(httpsEnforcer);
app.use(suspiciousRequestGuard);
app.use(cspConfig);

app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false, // Managed by cspConfig in security.js
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});

app.use('/api', apiLimiter);
app.use(cors({
  origin: process.env.CORS_ORIGIN || false,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// The Clarity project id is public by design, but serving it from Railway's
// environment keeps deployment-specific analytics configuration out of Git.
// Whitelisting the expected identifier format prevents an env value from ever
// becoming executable content in the browser.
app.get('/runtime-config.js', (_req, res) => {
  const configuredId = String(process.env.CLARITY_PROJECT_ID || '').trim();
  const clarityProjectId = /^[A-Za-z0-9]{6,32}$/.test(configuredId) ? configuredId : '';
  res.set({
    'Cache-Control': 'no-store, max-age=0',
    'Content-Type': 'application/javascript; charset=utf-8',
  });
  res.send(`window.__CORELINK_RUNTIME__ = Object.freeze({ clarityProjectId: ${JSON.stringify(clarityProjectId)} });`);
});
app.use(express.static(PUBLIC_DIR));

// ── Multer ────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, file, cb) => {
    const clean = sanitizeFilename(file.originalname) || `model-${Date.now()}`;
    const safe = `${Date.now()}-${clean}`;
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 1,
    parts: 2,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.glb' || ext === '.gltf') return cb(null, true);
    cb(new Error('Only .glb and .gltf files are accepted'));
  },
});

// ── Routes: Health ────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── Routes: GLB File Management ───────────────────────────────
function readHeaderBuffer(filePath, maxBytes = 65536) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stats = fs.fstatSync(fd);
    const readSize = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, 0);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

app.post('/api/glb/upload', requireOwner, upload.single('model'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filePath = path.join(UPLOADS_DIR, req.file.filename);
  if (!isSafePath(UPLOADS_DIR, filePath)) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return res.status(400).json({ error: 'Invalid file path' });
  }

  // Validate magic bytes / file structure on bounded header buffer
  try {
    const buffer = readHeaderBuffer(filePath, 65536);
    const validation = validateModelFileBuffer(buffer, req.file.originalname);
    if (!validation.valid) {
      fs.unlinkSync(filePath);
      logSecurityEvent('warn', req, `Uploaded file failed validation: ${validation.reason}`, { file: req.file.originalname });
      return res.status(400).json({ error: `Security validation failed: ${validation.reason}` });
    }
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return res.status(500).json({ error: 'Could not validate uploaded file' });
  }

  const owner = req.ownerToken || getOwnerToken(req);
  fileOwners.set(req.file.filename, owner);
  persistFileOwners();
  res.json({
    success:      true,
    filename:     req.file.filename,
    originalName: req.file.originalname,
    size:         req.file.size,
    url:          `/api/glb/file/${encodeURIComponent(req.file.filename)}`,
  });
});

app.get('/api/glb/file/:filename', requireOwner, (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: 'Invalid filename' });

  const owner = getFileOwner(filename);
  if (owner !== getOwnerToken(req)) return res.status(404).json({ error: 'File not found' });
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!isSafePath(UPLOADS_DIR, filePath) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = ext === '.gltf' ? 'model/gltf+json' : 'model/gltf-binary';
  res.setHeader('Content-Type', mime);
  res.sendFile(filename, { root: UPLOADS_DIR });
});

app.get('/api/glb/list', requireOwner, (req, res) => {
  const files = fs.readdirSync(UPLOADS_DIR)
    .filter(f => /\.(glb|gltf)$/i.test(f) && fileOwners.get(f) === getOwnerToken(req))
    .map(f => {
      const stat = fs.statSync(path.join(UPLOADS_DIR, f));
      return { filename: f, url: `/api/glb/file/${encodeURIComponent(f)}`, size: stat.size, uploadedAt: stat.mtimeMs };
    })
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
  res.json({ files, count: files.length });
});

app.delete('/api/glb/file/:filename', requireOwner, (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: 'Invalid filename' });

  if (getFileOwner(filename) !== getOwnerToken(req)) return res.status(404).json({ error: 'File not found' });
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!isSafePath(UPLOADS_DIR, filePath) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
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
  console.log('║' + '      CoreLink 3D — Editor Ready        '.padEnd(w) + '║');
  console.log('╠' + '═'.repeat(w) + '╣');
  console.log('║  ' + pad(`Local   : http://localhost:${PORT}`)      + '║');
  console.log('║  ' + pad(`Engine  : Babylon.js (WebGPU / WebGL2)`)  + '║');
  console.log('║  ' + pad(`Uploads : ${UPLOADS_DIR}`)                + '║');
  console.log('╚' + '═'.repeat(w) + '╝\n');
});
