/**
 * CoreLink 3D — Material Manager (materialManager.js)
 * Manages material properties (color, roughness, metalness, normal scale, emissive, shader modes)
 * for the active 3D model and individual sub-meshes.
 */

import * as THREE from 'three';
import viewer3d from './viewer3d.js';
import { saveModelFile } from './modelStorage.js';

class MaterialManager {
  constructor() {
    this.currentShaderMode = 'pbr';
    this._savedMaterials = new Map();
    this._saveTimeout = null;
  }

  _scheduleAutoSave() {
    if (this._saveTimeout) clearTimeout(this._saveTimeout);
    this._saveTimeout = setTimeout(() => {
      this._exportAndSave();
    }, 1000);
  }

  async _exportAndSave() {
    if (!viewer3d.currentModel || !viewer3d.lastLoadedBlob) return;
    try {
      const result = await viewer3d.exportSceneGLBBuffer({ binary: true });
      const blob = new Blob([result.buffer], { type: 'model/gltf-binary' });
      const fileName = viewer3d.lastLoadedFileName || 'model.glb';
      await saveModelFile(blob, fileName);
    } catch (err) {
      console.warn('[MaterialManager] Auto-save failed:', err);
    }
  }

  /**
   * Helper to traverse target meshes and mutate materials.
   * If targetMeshName is 'all' or undefined, applies to all meshes in the scene.
   */
  _applyToMaterials(targetMeshName, callback) {
    if (!viewer3d.currentModel) return;

    viewer3d.currentModel.traverse((child) => {
      if (!child.isMesh || !child.material) return;

      const matchesTarget =
        !targetMeshName ||
        targetMeshName === 'all' ||
        child.uuid === targetMeshName ||
        child.name === targetMeshName;

      if (matchesTarget) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(mat => {
          // Clone material if it's shared to avoid unintended side effects across multiple meshes
          if (targetMeshName && targetMeshName !== 'all' && child.material === mat) {
            child.material = mat.clone();
            callback(child.material, child);
          } else {
            callback(mat, child);
          }
        });
      }
    });
  }

  /**
   * Set Base Color (HEX or CSS color string)
   */
  setBaseColor(colorHex, targetMeshName = 'all') {
    try {
      const color = new THREE.Color(colorHex);
      this._applyToMaterials(targetMeshName, (mat) => {
        if (mat.color) mat.color.copy(color);
      });
      this._scheduleAutoSave();
    } catch (err) {
      console.warn('[MaterialManager] Invalid color format:', colorHex, err);
    }
  }

  /**
   * Set Roughness (0.0 - 1.0)
   */
  setRoughness(value, targetMeshName = 'all') {
    const val = THREE.MathUtils.clamp(parseFloat(value), 0, 1);
    this._applyToMaterials(targetMeshName, (mat) => {
      if ('roughness' in mat) mat.roughness = val;
    });
    this._scheduleAutoSave();
  }

  /**
   * Set Metalness (0.0 - 1.0)
   */
  setMetalness(value, targetMeshName = 'all') {
    const val = THREE.MathUtils.clamp(parseFloat(value), 0, 1);
    this._applyToMaterials(targetMeshName, (mat) => {
      if ('metalness' in mat) mat.metalness = val;
    });
    this._scheduleAutoSave();
  }

  /**
   * Set Normal Scale (0.0 - 3.0)
   */
  setNormalScale(value, targetMeshName = 'all') {
    const val = THREE.MathUtils.clamp(parseFloat(value), 0, 3);
    this._applyToMaterials(targetMeshName, (mat) => {
      if (mat.normalScale) mat.normalScale.set(val, val);
    });
    this._scheduleAutoSave();
  }

  /**
   * Set Emissive Color & Intensity
   */
  setEmissive(colorHex, intensity = 1.0, targetMeshName = 'all') {
    try {
      const color = colorHex ? new THREE.Color(colorHex) : new THREE.Color(0x000000);
      const val = parseFloat(intensity);

      this._applyToMaterials(targetMeshName, (mat) => {
        if (mat.emissive) mat.emissive.copy(color);
        if ('emissiveIntensity' in mat) mat.emissiveIntensity = val;
      });
      this._scheduleAutoSave();
    } catch (err) {
      console.warn('[MaterialManager] Error setting emissive:', err);
    }
  }

  /**
  * Toggle between Standard PBR and the Sci-Fi overlay effect
   */
  setShaderMode(mode = 'pbr') {
    this.currentShaderMode = mode;

    this._applyToMaterials('all', (mat, mesh) => {
      if (mode === 'custom') {
        if (!this._savedMaterials.has(mesh.uuid)) this._savedMaterials.set(mesh.uuid, mesh.material);
        const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const customMaterials = sourceMaterials.map((source) => {
          const custom = source.clone();
          custom.wireframe = true;
          custom.transparent = true;
          custom.opacity = 0.82;
          if (custom.emissive) custom.emissive.set(0x00f2fe);
          if ('emissiveIntensity' in custom) custom.emissiveIntensity = Math.max(custom.emissiveIntensity || 0, 0.35);
          return custom;
        });
        mesh.material = Array.isArray(mesh.material) ? customMaterials : customMaterials[0];
      } else {
        const original = this._savedMaterials.get(mesh.uuid);
        if (original) {
          mesh.material = original;
          this._savedMaterials.delete(mesh.uuid);
        }
      }
    });
  }

  /**
   * Batch update from AI JSON or UI controls
   */
  applyMaterialUpdate(params) {
    if (!params) return;

    const target = params.targetMesh || params.target || 'all';

    if (params.color) {
      this.baseColorHex = params.color;
      this.setBaseColor(params.color, target);
    }
    if (params.roughness !== undefined && params.roughness !== null) {
      this.setRoughness(params.roughness, target);
    }
    if (params.metalness !== undefined && params.metalness !== null) {
      this.setMetalness(params.metalness, target);
    }
    if (params.normalScale !== undefined && params.normalScale !== null) {
      this.setNormalScale(params.normalScale, target);
    }
    if (params.emissive) {
      this.setEmissive(params.emissive, params.emissiveIntensity || 1.0, target);
    }
  }
}

const materialManager = new MaterialManager();
export default materialManager;
