/**
 * Small, dependency-free validation gate for locally selected model assets.
 * Browser file types are advisory, so format checks use extension + contents.
 */

export const MAX_MODEL_FILE_SIZE_BYTES = 100 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = new Set(['glb', 'gltf', 'obj', 'fbx', 'cl3d']);

export function sanitizeModelFilename(value) {
  const name = String(value || 'model.glb').split(/[\\/]/).pop().replace(/[\0]/g, '');
  return name.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/^\.+/, '') || 'model.glb';
}

export async function validateModelFile(file, optionalName) {
  if (!(file instanceof Blob)) throw new Error('The selected asset is not a readable local file.');
  if (!file.size) throw new Error('The selected asset is empty.');
  if (file.size > MAX_MODEL_FILE_SIZE_BYTES) {
    throw new Error(`Model files must be ${MAX_MODEL_FILE_SIZE_BYTES / 1024 / 1024} MB or smaller.`);
  }

  const filename = sanitizeModelFilename(optionalName || file.name);
  const extension = filename.split('.').pop().toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error('Supported formats: .glb, .gltf, .obj, .fbx, .cl3d');
  }

  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  if (extension === 'glb') validateGlbHeader(header, file.size);
  if (extension === 'gltf') await validateGltfJson(file);
  if (extension === 'cl3d') validateZipHeader(header);
  if (extension === 'fbx') validateFbxHeader(header);
  return { filename, extension };
}

function validateGlbHeader(header, fileSize) {
  if (header.byteLength < 12) throw new Error('Invalid GLB: file header is incomplete.');
  const data = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (data.getUint32(0, true) !== 0x46546c67) throw new Error('Invalid GLB: expected glTF binary signature.');
  if (data.getUint32(4, true) !== 2) throw new Error('Invalid GLB: only glTF 2.0 binary assets are supported.');
  if (data.getUint32(8, true) !== fileSize) throw new Error('Invalid GLB: declared file size does not match the asset.');
}

async function validateGltfJson(file) {
  let document;
  try {
    document = JSON.parse(await file.text());
  } catch (_) {
    throw new Error('Invalid glTF: the file is not valid JSON.');
  }
  if (!document?.asset || document.asset.version !== '2.0') {
    throw new Error('Invalid glTF: expected an asset declaration for glTF 2.0.');
  }
}

function validateZipHeader(header) {
  if (header[0] !== 0x50 || header[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(header[2])) {
    throw new Error('Invalid .cl3d project: expected a ZIP container.');
  }
}

function validateFbxHeader(header) {
  const signature = new TextDecoder().decode(header);
  if (!signature.startsWith('Kaydara FBX Binary') && !signature.startsWith('; FBX')) {
    throw new Error('Invalid FBX: unrecognized file header.');
  }
}


