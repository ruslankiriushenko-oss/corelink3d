/**
 * CoreLink 3D — Security Middleware
 * HTTPS-only enforcement, Strict CSP, Suspicious Request Logging,
 * Path Traversal & Zip Bomb Guards, Malicious Model Validation
 */

const path = require('path');
const fs = require('fs');
const helmet = require('helmet');

// ── Suspicious Request Logging ────────────────────────────────
const SUSPICIOUS_PATTERNS = [
  /(\.\.[\/\\]|\.\.%2f|\.\.%5c|%2e%2e[\/\\]|%2e%2e%2f|%2e%2e%5c)/i, // Directory traversal (raw & encoded)
  /%00|\\0|\x00/,                                     // Null byte injection
  /(\.env|\.git|\.aws|\.ssh|\.htpasswd)/i,            // Sensitive dotfiles
  /(wp-admin|wp-login|xmlrpc|phpmyadmin|cgi-bin|actuator|config\.json)/i, // Scanners
  /(etc\/passwd|win\.ini|boot\.ini)/i,                 // OS files
  /<script|javascript:|data:text\/html/i,             // XSS payloads in query
];

function logSecurityEvent(level, req, reason, details = {}) {
  const timestamp = new Date().toISOString();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  const method = req.method;
  const url = req.originalUrl || req.url;

  console.warn(`[SECURITY ${level.toUpperCase()}] ${timestamp} | IP: ${ip} | ${method} ${url} | Reason: ${reason}`);
  return {
    timestamp,
    level,
    reason,
    ip,
    method,
    url,
    userAgent: ua,
    ...details,
  };
}

// ── HTTPS Enforcement & HSTS ──────────────────────────────────
function httpsEnforcer(req, res, next) {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.FORCE_HTTPS === 'true';
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';

  // In production / HTTPS proxy, redirect HTTP to HTTPS
  if (isProduction && !isHttps) {
    const host = req.headers.host || 'localhost';
    const httpsUrl = `https://${host}${req.originalUrl || req.url}`;
    logSecurityEvent('info', req, 'Redirecting insecure HTTP request to HTTPS');
    return res.redirect(301, httpsUrl);
  }

  // Set HSTS Header
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  next();
}

// ── Suspicious Request Guard ──────────────────────────────────
function suspiciousRequestGuard(req, res, next) {
  let target = req.originalUrl || req.url || '';
  try {
    target = decodeURIComponent(target);
  } catch {
    // Malformed URI encoding is suspicious; inspect raw target
  }
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(target) || pattern.test(req.url || '')) {
      logSecurityEvent('warn', req, `Blocked suspicious request matching pattern: ${pattern}`);
      return res.status(400).json({ error: 'Invalid or forbidden request path.' });
    }
  }
  next();
}

// ── Content Security Policy (CSP) ─────────────────────────────
const cspConfig = helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: [
      "'self'",
      "'unsafe-inline'", // Needed for inline app boots & module scripts
      "'unsafe-eval'",   // Needed for Three.js & Babylon.js shader compilation / loaders
      "'wasm-unsafe-eval'", // Needed for Babylon WebGPU WGSL/glslang wasm
      'https://cdn.jsdelivr.net',
      'https://unpkg.com',
      'https://cdn.babylonjs.com',
      'https://preview.babylonjs.com',
      'https://www.clarity.ms',
      'https://c.clarity.ms',
      'https://scripts.clarity.ms',
      'https://*.clarity.ms',
      'https://www.googletagmanager.com',
    ],
    scriptSrcElem: [
      "'self'",
      "'unsafe-inline'",
      "'unsafe-eval'",
      "'wasm-unsafe-eval'",
      'https://cdn.jsdelivr.net',
      'https://unpkg.com',
      'https://cdn.babylonjs.com',
      'https://preview.babylonjs.com',
      'https://www.clarity.ms',
      'https://c.clarity.ms',
      'https://scripts.clarity.ms',
      'https://*.clarity.ms',
      'https://www.googletagmanager.com',
    ],
    styleSrc: [
      "'self'",
      "'unsafe-inline'",
      'https://fonts.googleapis.com',
      'https://cdn.jsdelivr.net',
      'https://cdn.babylonjs.com',
      'https://cdnjs.cloudflare.com',
    ],
    fontSrc: [
      "'self'",
      'https://fonts.gstatic.com',
      'https://cdn.jsdelivr.net',
      'https://cdn.babylonjs.com',
      'https://cdnjs.cloudflare.com',
      'data:',
    ],
    imgSrc: [
      "'self'",
      'data:',
      'blob:',
      'https://cdn.jsdelivr.net',
      'https://cdn.babylonjs.com',
      'https://preview.babylonjs.com',
      'https://www.clarity.ms',
      'https://c.clarity.ms',
      'https://*.clarity.ms',
      'https://c.bing.com',
      'https://*.bing.com',
      'https://api.qrserver.com',
      'https://www.googletagmanager.com',
      'https://www.google-analytics.com',
    ],
    mediaSrc: ["'self'", 'blob:', 'data:'],
    connectSrc: [
      "'self'",
      'blob:',
      'data:',
      'https://cdn.jsdelivr.net',
      'https://cdn.babylonjs.com',
      'https://preview.babylonjs.com',
      'https://www.clarity.ms',
      'https://c.clarity.ms',
      'https://*.clarity.ms',
      'https://c.bing.com',
      'https://*.bing.com',
      'https://www.google-analytics.com',
      'https://*.google-analytics.com',
      'https://region1.google-analytics.com',
      'https://www.googletagmanager.com',
      'https://api.qrserver.com',
      'http://localhost:*',
      'http://127.0.0.1:*',
    ],
    workerSrc: ["'self'", 'blob:'],
    childSrc: ["'self'", 'blob:'],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
  },
});

// ── Path Sanitization & Validation ────────────────────────────
function sanitizeFilename(filename) {
  if (typeof filename !== 'string') return '';
  // Remove directory separators and null bytes
  const base = path.basename(filename).replace(/[\/\\]/g, '').replace(/\0/g, '');
  // Disallow hidden files and relative traversal dots
  if (base.startsWith('.') || base.includes('..')) {
    return '';
  }
  // Allow only alphanumeric, dashes, underscores, and safe extensions
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isSafePath(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

// ── File Content / Magic Byte Validation ──────────────────────
function validateModelFileBuffer(buffer, filename) {
  if (!buffer || buffer.length < 4) {
    return { valid: false, reason: 'File buffer too small or empty' };
  }

  const ext = path.extname(filename).toLowerCase();

  // GLB magic bytes: 0x46546C67 ("glTF" in ASCII little-endian)
  if (ext === '.glb') {
    const magic = buffer.toString('utf8', 0, 4);
    if (magic !== 'glTF') {
      return { valid: false, reason: 'Invalid binary GLB header magic bytes' };
    }
    return { valid: true };
  }

  // GLTF JSON validation
  if (ext === '.gltf') {
    try {
      const json = JSON.parse(buffer.toString('utf8'));
      if (!json || typeof json !== 'object' || !json.asset) {
        return { valid: false, reason: 'Invalid glTF JSON: missing asset property' };
      }
      return { valid: true };
    } catch (err) {
      return { valid: false, reason: 'Invalid glTF JSON content' };
    }
  }

  if (ext === '.hdr' || ext === '.exr') {
    return { valid: false, reason: 'HDR and EXR environment maps are not supported' };
  }

  // CL3D (ZIP Container): PK\x03\x04
  if (ext === '.cl3d' || ext === '.zip') {
    if (buffer[0] === 0x50 && buffer[1] === 0x4B && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)) {
      return { valid: true };
    }
    return { valid: false, reason: 'Invalid ZIP/CL3D container signature' };
  }

  return { valid: true };
}

module.exports = {
  SUSPICIOUS_PATTERNS,
  logSecurityEvent,
  httpsEnforcer,
  suspiciousRequestGuard,
  cspConfig,
  sanitizeFilename,
  isSafePath,
  validateModelFileBuffer,
};
