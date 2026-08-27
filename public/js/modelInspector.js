/**
 * CoreLink 3D — Model Inspector (modelInspector.js)
 * Real-time GLB/3D scene inspector: polycount analysis, mesh node hierarchy, texture map extraction, and draw calls.
 */

import * as THREE from 'three';
import viewer3d from './viewer3d.js';

class ModelInspector {
  constructor() {}

  /**
   * Performs full inspection on the current active model in the viewer.
   * @returns {object} Inspection results
   */
  inspectModel() {
    if (!viewer3d.currentModel) {
      return {
        modelName: 'None',
        meshCount: 0,
        polyCount: 0,
        vertCount: 0,
        drawCalls: 0,
        dimensions: '—',
        meshTree: [],
        textures: []
      };
    }

    const stats = viewer3d.getStats();
    
    // Calculate bounding box dimensions
    const box = new THREE.Box3().setFromObject(viewer3d.currentModel);
    const size = box.getSize(new THREE.Vector3());
    const dimensions = `${size.x.toFixed(2)}m × ${size.y.toFixed(2)}m × ${size.z.toFixed(2)}m`;

    // Extract Mesh Hierarchy Nodes
    const meshTree = [];
    const texturesSet = new Set();

    viewer3d.currentModel.traverse((child) => {
      if (child.isMesh) {
        let polys = 0;
        let verts = 0;
        if (child.geometry) {
          if (child.geometry.index) {
            polys = child.geometry.index.count / 3;
          } else if (child.geometry.attributes?.position) {
            polys = child.geometry.attributes.position.count / 3;
          }
          if (child.geometry.attributes?.position) {
            verts = child.geometry.attributes.position.count;
          }
        }

        meshTree.push({
          name: child.name || `Mesh_${meshTree.length + 1}`,
          polys: Math.round(polys),
          verts: Math.round(verts),
          visible: child.visible,
          uuid: child.uuid,
          materialName: Array.isArray(child.material)
            ? child.material[0]?.name
            : child.material?.name,
        });

        // Extract Textures & Maps
        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(mat => {
            if (mat.map) texturesSet.add({ type: 'Diffuse', name: mat.map.name || 'Albedo_Map' });
            if (mat.normalMap) texturesSet.add({ type: 'Normal', name: mat.normalMap.name || 'Normal_Detail' });
            if (mat.roughnessMap) texturesSet.add({ type: 'Roughness', name: mat.roughnessMap.name || 'Roughness_Channel' });
            if (mat.metalnessMap) texturesSet.add({ type: 'Metalness', name: mat.metalnessMap.name || 'Metalness_Channel' });
            if (mat.emissiveMap) texturesSet.add({ type: 'Emissive', name: mat.emissiveMap.name || 'Glow_Channel' });
          });
        }
      }
    });

    const textures = Array.from(texturesSet);
    if (textures.length === 0) {
      textures.push(
        { type: 'Diffuse', name: 'Procedural Standard PBR' },
        { type: 'Normal', name: 'Generated Surface Normal' }
      );
    }

    return {
      modelName: stats.modelName,
      meshCount: stats.meshCount,
      polyCount: stats.polyCount,
      vertCount: stats.vertCount,
      drawCalls: stats.drawCalls,
      dimensions,
      meshTree,
      textures
    };
  }

  /**
   * Toggle visibility of a specific mesh by name or UUID.
   */
  toggleMeshVisibility(meshName, visible) {
    if (!viewer3d.currentModel) return;

    viewer3d.currentModel.traverse((child) => {
      if (child.isMesh && (child.name === meshName || child.uuid === meshName)) {
        child.visible = Boolean(visible);
      }
    });
  }

  /**
   * Returns mesh targets valid for material editing (excludes material-name placeholders).
   */
  getMaterialTargets() {
    const inspection = this.inspectModel();
    const placeholderRe = /^material[_-]?material?\d*$/i;
    const invalidNameRe = /^(material|mat)[\s_-]*[a-z0-9_]*$/i;

    return inspection.meshTree.filter((node) => {
      if (!node.uuid || node.polys <= 0) return false;
      const name = String(node.name || '');
      if (!name.trim()) return false;
      if (placeholderRe.test(name)) return false;
      if (invalidNameRe.test(name) && node.name === node.materialName) return false;
      if (/^material[_-]/i.test(name) && !/mesh|core|ring|base|body|panel|shell|face|trim|detail|part/i.test(name)) {
        return false;
      }
      return true;
    });
  }
}

const modelInspector = new ModelInspector();
export default modelInspector;
