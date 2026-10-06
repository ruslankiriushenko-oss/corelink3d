/**
 * CoreLink 3D — Project Bundle Manager (.cl3d)
 * Secure .cl3d (ZIP) unpacking with decompression limit guards (Zip Bomb protection).
 * Packing is done by the editor (webgpuEditor._exportStudioProject).
 */

// Max decompression guards
const MAX_ARCHIVE_FILES = 50;
const MAX_UNCOMPRESSED_SIZE_BYTES = 300 * 1024 * 1024; // 300 MB

class ProjectBundleManager {
  /**
  * Unpack a .cl3d project bundle and extract its model and metadata
   * @param {File|Blob|ArrayBuffer} fileOrBuffer
   * @param {string} [optionalFilename]
  * @returns {Promise<{ modelBlob: Blob, modelFile: File, metadata: Object, modelName: string }>}
   */
  async unpackProjectBundle(fileOrBuffer, optionalFilename) {
    if (!fileOrBuffer) {
      throw new Error('No project file provided.');
    }

    if (typeof window.JSZip === 'undefined') {
      throw new Error('JSZip library is not loaded. Cannot load .cl3d project.');
    }

    const zip = new window.JSZip();
    let zipData = fileOrBuffer;

    if (fileOrBuffer instanceof File || fileOrBuffer instanceof Blob) {
      zipData = await fileOrBuffer.arrayBuffer();
    }

    const archive = await zip.loadAsync(zipData);
    const files = Object.keys(archive.files);

    if (files.length > MAX_ARCHIVE_FILES) {
      throw new Error(`Archive exceeds maximum permitted file count (${files.length} > ${MAX_ARCHIVE_FILES}).`);
    }

    let totalUncompressedSize = 0;
    for (const filename of files) {
      if (filename.includes('..') || filename.startsWith('/') || filename.startsWith('\\')) {
        throw new Error('Malicious path traversal detected inside project archive.');
      }
      const entry = archive.files[filename];
      if (!entry.dir && entry._data && typeof entry._data.uncompressedSize === 'number') {
        totalUncompressedSize += entry._data.uncompressedSize;
      }
    }

    if (totalUncompressedSize > MAX_UNCOMPRESSED_SIZE_BYTES) {
      throw new Error('Project archive exceeds maximum allowable uncompressed size limit (Zip Bomb protection).');
    }

    const sceneEntry = archive.file('scene.json') || archive.file('project.json');
    if (!sceneEntry) {
      throw new Error('Invalid .cl3d project bundle: missing scene.json definition.');
    }

    const sceneJsonText = await sceneEntry.async('text');
    if (sceneJsonText.length > 10 * 1024 * 1024) {
      throw new Error('scene.json payload exceeds maximum allowed size.');
    }
    let metadata;
    try {
      metadata = JSON.parse(sceneJsonText);
    } catch (err) {
      throw new Error('Corrupted scene.json configuration inside project bundle.');
    }

    const modelEntry = archive.file('model.glb') || archive.file(/^.*\.glb$/i)[0] || archive.file(/^.*\.gltf$/i)[0];
    if (!modelEntry) {
      throw new Error('Invalid .cl3d project bundle: missing 3D model asset.');
    }

    const modelBuffer = await modelEntry.async('arraybuffer');
    if (modelBuffer.byteLength > MAX_UNCOMPRESSED_SIZE_BYTES) {
      throw new Error('3D model inside project bundle exceeds size limit.');
    }
    const modelBlob = new Blob([modelBuffer], { type: 'model/gltf-binary' });
    const rawName = metadata.name || optionalFilename || (fileOrBuffer instanceof File ? fileOrBuffer.name : 'Project_Model');
    const modelName = rawName.replace(/\.cl3d$/i, '');
    const modelFile = new File([modelBuffer], `${modelName}.glb`, { type: 'model/gltf-binary' });

    return {
      modelBlob,
      modelFile,
      modelName,
      metadata,
    };
  }
}

const projectBundle = new ProjectBundleManager();
export default projectBundle;
