const assert = require('assert');
const {
  sanitizeFilename,
  isSafePath,
  validateModelFileBuffer,
  SUSPICIOUS_PATTERNS,
} = require('../server/middleware/security');

console.log('Running Security & Validation tests...');

// 1. sanitizeFilename
assert.strictEqual(sanitizeFilename('../../etc/passwd'), 'passwd');
assert.strictEqual(sanitizeFilename('valid_name.glb'), 'valid_name.glb');
assert.strictEqual(sanitizeFilename('../secret.gltf'), 'secret.gltf');
assert.strictEqual(sanitizeFilename('.hidden'), '');

// 2. isSafePath
const base = '/app/uploads';
assert.strictEqual(isSafePath(base, '/app/uploads/file.glb'), true);
assert.strictEqual(isSafePath(base, '/app/uploads/../etc/passwd'), false);

// 3. validateModelFileBuffer
// GLB
const validGlb = Buffer.from('glTF\x02\x00\x00\x00', 'binary');
assert.strictEqual(validateModelFileBuffer(validGlb, 'test.glb').valid, true);
const invalidGlb = Buffer.from('RIFF\x00\x00\x00\x00', 'binary');
assert.strictEqual(validateModelFileBuffer(invalidGlb, 'test.glb').valid, false);

// glTF JSON
const validGltf = Buffer.from(JSON.stringify({ asset: { version: '2.0' } }), 'utf8');
assert.strictEqual(validateModelFileBuffer(validGltf, 'test.gltf').valid, true);
const invalidGltf = Buffer.from('not json', 'utf8');
assert.strictEqual(validateModelFileBuffer(invalidGltf, 'test.gltf').valid, false);

// Environment maps are unsupported
const hdr = Buffer.from('#?RADIANCE\n# Radiance header\n', 'utf8');
assert.strictEqual(validateModelFileBuffer(hdr, 'env.hdr').valid, false);
const exr = Buffer.from([0x76, 0x2f, 0x31, 0x01, 0x00, 0x00]);
assert.strictEqual(validateModelFileBuffer(exr, 'env.exr').valid, false);

// CL3D / ZIP
const validZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
assert.strictEqual(validateModelFileBuffer(validZip, 'project.cl3d').valid, true);

// 4. Suspicious patterns
const traversalPattern = SUSPICIOUS_PATTERNS[0];
assert.strictEqual(traversalPattern.test('..%2fetc/passwd'), true);
assert.strictEqual(traversalPattern.test('../config.json'), true);

// 5. suspiciousRequestGuard middleware resilience
const { suspiciousRequestGuard } = require('../server/middleware/security');

// Malformed URI shouldn't throw 500/URIError
let guardCalledNext = false;
const reqMalformed = {
  url: '/api/%E0%A4%A',
  originalUrl: '/api/%E0%A4%A',
  headers: {},
  socket: { remoteAddress: '127.0.0.1' },
  method: 'GET'
};
const resMock = {
  status: (code) => ({
    json: (data) => ({ code, data })
  })
};
suspiciousRequestGuard(reqMalformed, resMock, () => {
  guardCalledNext = true;
});
assert.strictEqual(guardCalledNext, true);

// Traversal pattern blocked
let blockedStatus = null;
const reqTraversal = {
  url: '/api/../../etc/passwd',
  originalUrl: '/api/../../etc/passwd',
  headers: {},
  socket: { remoteAddress: '127.0.0.1' },
  method: 'GET'
};
const resBlockedMock = {
  status: (code) => {
    blockedStatus = code;
    return { json: () => {} };
  }
};
suspiciousRequestGuard(reqTraversal, resBlockedMock, () => {});
assert.strictEqual(blockedStatus, 400);

console.log('✅ All security & validation unit tests passed successfully!');
