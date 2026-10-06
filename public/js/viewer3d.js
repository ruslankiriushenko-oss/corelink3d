/**
 * CoreLink 3D — 3D Viewer Engine (viewer3d.js)
 * Three.js scene, camera, renderer, OrbitControls, GLTF/DRACO loader, and procedural demo model.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }   from 'three/addons/loaders/DRACOLoader.js';
import { GLTFExporter }  from 'three/addons/exporters/GLTFExporter.js';
import { OBJLoader }     from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader }     from 'three/addons/loaders/FBXLoader.js';
import { sanitizeModelFilename, validateModelFile } from './modelValidation.js';
import { getSavedModelFile, saveModelFile } from './modelStorage.js';

function isWebGLAvailable() {
  try {
    const canvas = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
  } catch (error) {
    return false;
  }
}

// Shared DRACOLoader singleton — avoids spawning a new WASM worker per model load.
// One instance is reused for the lifetime of the page.
const _sharedDraco = new DRACOLoader();
_sharedDraco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');
_sharedDraco.preload();

class Viewer3D {
  constructor(canvasId) {
    this.canvas          = document.getElementById(canvasId);
    this.scene           = null;
    this.camera          = null;
    this.renderer        = null;
    this.controls        = null;
    this.currentModel    = null;
    this.mixer           = null;
    this.animActions     = [];
    this.clock           = new THREE.Clock();
    this.gridHelper      = null;
    this.showGrid        = true;
    this.wireframeMode   = false;
    this.isAutoRotating  = false;
    this.autoRotateSpeed = 0.5;
    this.isLightOrbiting = false;
    this.orbitLightSpeed = 1.0;
    this.orbitLightAngle = 0;
    this.isPageVisible   = true;
    
    // FPS stats
    this.frameCount      = 0;
    this.fpsStart        = performance.now();
    this.fps             = 60;
    this.drawCalls       = 0;
    this.animFrameId     = null;
    this.resizeObserver  = null;
    this.disposed        = false;
    this._originalMaterials = new Map();
    this._hologramMaterials = new Map();
    this.environmentIntensity = 1;

    // Lights references
    this.lights = {
      ambient: null,
      key: null,
      fill: null,
      rim: null
    };

    this._init();
  }

  _init() {
    if (!this.canvas) {
      console.error('[Viewer3D] Canvas element not found');
      return;
    }

    if (!isWebGLAvailable()) {
      this._showWebGLFallback();
      return;
    }

    const container = this.canvas.parentElement;
    const width  = container.clientWidth  || 800;
    const height = container.clientHeight || 600;

    // 1. Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x040508);

    // 2. Camera
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 2000);
    this.camera.position.set(2.5, 2.0, 3.5);

    // 3. Renderer
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas:          this.canvas,
        antialias:       true,
        alpha:           false,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      console.error('[Viewer3D] WebGL initialization failed:', error);
      this.scene = null;
      this._showWebGLFallback();
      return;
    }
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping         = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure  = 1.1;
    this.renderer.outputColorSpace     = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled    = true;
    this.renderer.shadowMap.type       = THREE.PCFSoftShadowMap;

    // 4. Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping    = true;
    this.controls.dampingFactor    = 0.05;
    this.controls.minDistance      = 0.1;
    this.controls.maxDistance      = 500;
    this.controls.target.set(0, 0, 0);

    // 5. Lighting Setup
    this._setupLights();

    // 6. Floor Grid Helper
    this.gridHelper = new THREE.GridHelper(20, 20, 0x00f2fe, 0x1e293b);
    this.gridHelper.position.y = -1;
    this.gridHelper.material.transparent = true;
    this.gridHelper.material.opacity = 0.4;
    this.scene.add(this.gridHelper);

    // 7. Resize Observer
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);

    // 8. Visibility Change Detection (Performance Optimization)
    this.isPageVisible = document.visibilityState !== 'hidden';
    document.addEventListener('visibilitychange', () => {
      this.isPageVisible = document.visibilityState === 'visible';
      if (this.isPageVisible) {
        this.fpsStart = performance.now();
      }
    });

    // 9. Load saved model or create demo
    this._loadSavedModelOrCreateDemo();

    // 10. Start Render Loop
    this._animate();
  }

  _showWebGLFallback() {
    if (!this.canvas?.parentElement) return;
    this.canvas.hidden = true;
    const message = document.createElement('div');
    message.className = 'webgl-fallback';
    message.textContent = 'WebGL is unavailable. Enable hardware acceleration or use a compatible browser.';
    this.canvas.parentElement.appendChild(message);
  }

  async _loadSavedModelOrCreateDemo() {
    try {
      const savedModel = await getSavedModelFile();
      if (savedModel?.blob) {
        await this.loadModelFromFile(savedModel.blob);
      } else {
        this.createDemoModel();
      }
    } catch (error) {
      console.warn('[viewer3d] Could not load saved model, creating demo:', error);
      this.createDemoModel();
    }
  }

  _setupLights() {
    // Ambient
    this.lights.ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(this.lights.ambient);

    // Key Light (Main Shadow Caster)
    this.lights.key = new THREE.DirectionalLight(0xffffff, 1.5);
    this.lights.key.position.set(5, 8, 5);
    this.lights.key.castShadow = true;
    this.lights.key.shadow.mapSize.width  = 2048;
    this.lights.key.shadow.mapSize.height = 2048;
    this.lights.key.shadow.bias = -0.0001;
    this.scene.add(this.lights.key);

    // Fill Light (Soft cool light from side)
    this.lights.fill = new THREE.DirectionalLight(0x4facfe, 0.5);
    this.lights.fill.position.set(-5, 3, -2);
    this.scene.add(this.lights.fill);

    // Rim Light (Warm highlight from back)
    this.lights.rim = new THREE.DirectionalLight(0x00f2fe, 0.8);
    this.lights.rim.position.set(0, 5, -6);
    this.scene.add(this.lights.rim);
  }

  /**
   * Generates a sleek procedural sci-fi mechanical core model with distinct sub-meshes
   * for immediate interactive testing.
   */
  createDemoModel() {
    if (!this.scene) return;
    if (this.currentModel) {
      this._restoreOriginalMaterials();
      this.scene.remove(this.currentModel);
      this._disposeObject(this.currentModel);
    }

    this._clearMaterialState();

    const group = new THREE.Group();
    group.name = 'SciFi_Core_Demo';

    // Sub-mesh 1: Main Metallic Core Sphere
    const coreGeo = new THREE.IcosahedronGeometry(0.8, 4);
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      metalness: 0.95,
      roughness: 0.15,
      name: 'Mat_MainCore'
    });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    coreMesh.name = 'Main_Core_Sphere';
    coreMesh.castShadow = true;
    coreMesh.receiveShadow = true;
    group.add(coreMesh);

    // Sub-mesh 2: Outer Rotating Cyber Ring
    const ringGeo = new THREE.TorusGeometry(1.2, 0.08, 16, 64);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x00f2fe,
      metalness: 0.8,
      roughness: 0.2,
      emissive: 0x00f2fe,
      emissiveIntensity: 0.3,
      name: 'Mat_OuterRing'
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.name = 'Outer_Cyber_Ring';
    ringMesh.rotation.x = Math.PI / 3;
    ringMesh.castShadow = true;
    group.add(ringMesh);

    // Sub-mesh 3: Glowing Energy Crystal Core
    const crystalGeo = new THREE.OctahedronGeometry(0.4);
    const crystalMat = new THREE.MeshStandardMaterial({
      color: 0x4facfe,
      metalness: 0.1,
      roughness: 0.1,
      emissive: 0x4facfe,
      emissiveIntensity: 1.2,
      name: 'Mat_EnergyCrystal'
    });
    const crystalMesh = new THREE.Mesh(crystalGeo, crystalMat);
    crystalMesh.name = 'Glowing_Energy_Crystal';
    group.add(crystalMesh);

    // Sub-mesh 4: Base Platform Ring
    const baseGeo = new THREE.CylinderGeometry(1.5, 1.6, 0.15, 32);
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      metalness: 0.9,
      roughness: 0.3,
      name: 'Mat_BasePlatform'
    });
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.name = 'Base_Platform';
    baseMesh.position.y = -0.9;
    baseMesh.receiveShadow = true;
    group.add(baseMesh);

    this.scene.add(group);
    this.currentModel = group;

    this.resetCamera();
  }

  /**
   * Load external GLB/GLTF model.
   * @param {string} url 
   * @param {function} onProgress 
   * @returns {Promise<object>} Model info summary
   */
  loadModel(url, onProgress) {
    return new Promise((resolve, reject) => {
      if (!this.renderer) {
        reject(new Error('WebGL is unavailable on this device.'));
        return;
      }
      if (this.currentModel) {
        this._restoreOriginalMaterials();
        this.scene.remove(this.currentModel);
        this._disposeObject(this.currentModel);
        this.currentModel = null;
      }
      this._clearMaterialState();
      if (this.mixer) {
        this.mixer.stopAllAction();
        this.mixer = null;
        this.animActions = [];
      }

      // Use shared singleton DRACO loader — avoids spawning a new WASM worker per load.
      const loader = new GLTFLoader();
      loader.setDRACOLoader(_sharedDraco);

      loader.load(
        url,
        (gltf) => {
          const model = gltf.scene;
          model.name = gltf.scene.name || 'Loaded_GLB_Model';

          this._addLoadedModel(model, gltf.animations || []);

          // Animations
          if (gltf.animations && gltf.animations.length > 0) {
            this.mixer = new THREE.AnimationMixer(model);
            this.animActions = gltf.animations.map(clip => {
              const action = this.mixer.clipAction(clip);
              action.play();
              return action;
            });
          }

          this.resetCamera();
          resolve(this.getStats());
        },
        (xhr) => {
          if (onProgress && xhr.lengthComputable) {
            onProgress(Math.round((xhr.loaded / xhr.total) * 100));
          }
        },
        (err) => {
          console.error('[Viewer3D] GLB Load Error:', err);
          reject(err);
        }
      );
    });
  }

  async loadModelFromFile(file, onProgress, optionalFilename) {
    if (!file) throw new Error('No model file or data provided.');
    const validated = await validateModelFile(file, optionalFilename || file.name);
    return new Promise((resolve, reject) => {
      if (!this.renderer) {
        reject(new Error('WebGL is unavailable on this device.'));
        return;
      }

      const fileName = validated.filename || sanitizeModelFilename(optionalFilename || file.name || (file instanceof File ? file.name : 'model.glb'));
      const extension = (fileName ? fileName.split('.').pop() : 'glb').toLowerCase();
      this.lastLoadedBlob = file;
      this.lastLoadedFileName = fileName;
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Could not read model file.'));
      reader.onprogress = (event) => {
        if (onProgress && event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      };
      reader.onload = () => {
        try {
          if (extension === 'obj') {
            const model = new OBJLoader().parse(new TextDecoder().decode(reader.result));
            this._addLoadedModel(model);
            resolve(this.getStats());
            return;
          }
          if (extension === 'fbx') {
            const model = new FBXLoader().parse(reader.result, '');
            this._addLoadedModel(model, model.animations || []);
            resolve(this.getStats());
            return;
          }
          if (extension === 'glb' || extension === 'gltf') {
            // Use shared singleton DRACO loader — avoids spawning a new WASM worker per load.
            const loader = new GLTFLoader();
            loader.setDRACOLoader(_sharedDraco);
            const source = extension === 'gltf' ? new TextDecoder().decode(reader.result) : reader.result;
            loader.parse(source, '', (gltf) => {
              this._addLoadedModel(gltf.scene, gltf.animations || []);
              resolve(this.getStats());
            }, reject);
            return;
          }
          reject(new Error(`Unsupported model format: .${extension}`));
        } catch (error) {
          reject(error);
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  _addLoadedModel(model, animations = []) {
    if (this.currentModel) {
      this._restoreOriginalMaterials();
      this.scene.remove(this.currentModel);
      this._disposeObject(this.currentModel);
    }
    this._clearMaterialState();
    model.name = model.name || 'Loaded_3D_Model';
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    model.position.sub(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) model.scale.setScalar(3.0 / maxDim);
    model.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      if (this.wireframeMode && child.material) {
        (Array.isArray(child.material) ? child.material : [child.material]).forEach((material) => { material.wireframe = true; });
      }
    });
    this.scene.add(model);
    this.currentModel = model;
    if (animations.length) {
      this.mixer = new THREE.AnimationMixer(model);
      this.animActions = animations.map((clip) => {
        const action = this.mixer.clipAction(clip);
        action.play();
        return action;
      });
    }
    this.resetCamera();

    // Auto-save loaded model to IndexedDB
    if (this.lastLoadedBlob && this.lastLoadedFileName) {
      saveModelFile(this.lastLoadedBlob, this.lastLoadedFileName).catch(err =>
        console.warn('[viewer3d] Could not save model:', err)
      );
    }
  }

  pauseRendering() {
    this.isRenderingPaused = true;
  }

  resumeRendering() {
    this.isRenderingPaused = false;
  }

  _animate() {
    if (this.disposed) return;
    this.animFrameId = requestAnimationFrame(() => this._animate());

    // Skip rendering if page is hidden or paused for external editor
    if (!this.isPageVisible || this.isRenderingPaused) {
      return;
    }

    const delta = this.clock.getDelta();

    // Advance GLB animations
    if (this.mixer) {
      this.mixer.update(delta);
    }

    // Auto rotate model
    if (this.isAutoRotating && this.currentModel) {
      this.currentModel.rotation.y += this.autoRotateSpeed * delta;
    }

    // Orbit light around model
    if (this.isLightOrbiting && this.lights.key) {
      this.orbitLightAngle += this.orbitLightSpeed * delta;
      const radius = 4;
      const height = 2;
      this.lights.key.position.x = Math.cos(this.orbitLightAngle) * radius;
      this.lights.key.position.z = Math.sin(this.orbitLightAngle) * radius;
      this.lights.key.position.y = height;
    }

    this.controls.update();

    // FPS & Render stats
    this.frameCount++;
    const now = performance.now();
    if (now - this.fpsStart >= 1000) {
      this.fps = Math.round((this.frameCount * 1000) / (now - this.fpsStart));
      this.frameCount = 0;
      this.fpsStart   = now;

      const fpsEl = document.getElementById('hudFps');
      if (fpsEl) fpsEl.textContent = `${this.fps}`;
    }

    this.renderer.render(this.scene, this.camera);
    this.drawCalls = this.renderer.info.render.calls;
  }

  onResize() {
    const container = this.canvas.parentElement;
    if (!container) return;
    const width  = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  resetCamera() {
    if (this.currentModel) {
      const box = new THREE.Box3().setFromObject(this.currentModel);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const fov = this.camera.fov * (Math.PI / 180);
      let cameraDistance = (maxDim / 2) / Math.tan(fov / 2) * 1.6;
      cameraDistance = Math.max(cameraDistance, 2.5);

      this.camera.position.set(cameraDistance * 0.7, cameraDistance * 0.5, cameraDistance);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    } else {
      this.camera.position.set(2.5, 2.0, 3.5);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
  }

  hasActiveMeshes() {
    if (!this.currentModel) return false;
    let count = 0;
    this.currentModel.traverse((child) => {
      if (child.isMesh && child.visible && child.geometry && child.geometry.attributes?.position?.count > 0) {
        count++;
      }
    });
    return count > 0;
  }

  /**
   * Export the active 3D model using Three.js GLTFExporter
   * @param {Object} options Options for export (format: 'glb'|'gltf', binary: boolean, embedImages: boolean)
   */
  exportModel(options = {}) {
    return new Promise((resolve, reject) => {
      if (!this.hasActiveMeshes()) {
        reject(new Error('Cannot export: scene contains no active 3D meshes or nodes.'));
        return;
      }

      const exporter = new GLTFExporter();
      const format = (options.format || 'glb').toLowerCase();
      const isBinary = format === 'glb';

      const exportOptions = {
        binary: isBinary,
        embedImages: options.embedImages !== false,
        truncateDrawRange: true,
        onlyVisible: true,
        maxSamples: 4,
      };

      const defaultName = this.currentModel.name && this.currentModel.name !== 'Scene'
        ? this.currentModel.name
        : 'CoreLink_Processed_Model';
      const filename = (options.filename || defaultName).replace(/\.[^/.]+$/, '');
      const ext = isBinary ? 'glb' : 'gltf';

      console.log(`[Viewer3D] Exporting 3D scene model as .${ext}...`);

      exporter.parse(
        this.currentModel,
        (result) => {
          let blob;
          if (result instanceof ArrayBuffer) {
            blob = new Blob([result], { type: 'model/gltf-binary' });
          } else {
            const output = JSON.stringify(result, null, 2);
            blob = new Blob([output], { type: 'application/json' });
          }

          const link = document.createElement('a');
          const blobUrl = URL.createObjectURL(blob);
          link.href = blobUrl;
          link.download = `${filename}_export.${ext}`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);

          console.log(`[Viewer3D] Successfully exported ${filename}_export.${ext} (${(blob.size / 1024).toFixed(1)} KB)`);
          resolve({ filename: `${filename}_export.${ext}`, size: blob.size });
        },
        (error) => {
          console.error('[Viewer3D] GLTFExporter failed:', error);
          reject(error);
        },
        exportOptions
      );
    });
  }

  /**
   * Export the active 3D model as an ArrayBuffer without triggering a browser download
   * @param {Object} options
   * @returns {Promise<{ buffer: ArrayBuffer, filename: string }>}
   */
  exportSceneGLBBuffer(options = {}) {
    return new Promise((resolve, reject) => {
      if (!this.hasActiveMeshes()) {
        reject(new Error('Cannot export: scene contains no active 3D meshes or nodes.'));
        return;
      }

      const exporter = new GLTFExporter();
      const exportOptions = {
        binary: true,
        embedImages: options.embedImages !== false,
        truncateDrawRange: true,
        onlyVisible: true,
        maxSamples: 4,
      };

      const defaultName = this.currentModel.name && this.currentModel.name !== 'Scene'
        ? this.currentModel.name
        : 'CoreLink_Model';
      const filename = (options.filename || defaultName).replace(/\.[^/.]+$/, '');

      exporter.parse(
        this.currentModel,
        (result) => {
          if (result instanceof ArrayBuffer) {
            resolve({ buffer: result, filename: `${filename}.glb` });
          } else {
            const output = JSON.stringify(result, null, 2);
            const enc = new TextEncoder();
            resolve({ buffer: enc.encode(output).buffer, filename: `${filename}.gltf` });
          }
        },
        (error) => {
          reject(error);
        },
        exportOptions
      );
    });
  }

  /**
   * Serialize current scene parameters (camera, lights, environment, materials, view flags)
   * @returns {Object} sceneState
   */
  getSceneState() {
    const cameraState = this.camera ? {
      position: this.camera.position.toArray(),
      fov: this.camera.fov,
      near: this.camera.near,
      far: this.camera.far,
    } : null;

    const controlsTarget = this.controls ? this.controls.target.toArray() : [0, 0, 0];

    const lightsState = {};
    for (const [name, light] of Object.entries(this.lights)) {
      if (light) {
        lightsState[name] = {
          intensity: light.intensity,
          visible: light.visible,
          color: '#' + light.color.getHexString(),
          position: light.position ? light.position.toArray() : undefined,
          castShadow: Boolean(light.castShadow),
        };
      }
    }

    const materialOverrides = [];
    if (this.currentModel) {
      this.currentModel.traverse((child) => {
        if (child.isMesh && child.material) {
          const mat = Array.isArray(child.material) ? child.material[0] : child.material;
          if (mat) {
            materialOverrides.push({
              meshName: child.name,
              color: mat.color ? '#' + mat.color.getHexString() : undefined,
              roughness: mat.roughness,
              metalness: mat.metalness,
              opacity: mat.opacity,
              transparent: mat.transparent,
              wireframe: mat.wireframe,
            });
          }
        }
      });
    }

    return {
      version: 1,
      camera: cameraState,
      target: controlsTarget,
      lights: lightsState,
      environment: {
        exposure: this.renderer ? this.renderer.toneMappingExposure : 1.1,
        environmentIntensity: this.environmentIntensity,
        shadows: this.renderer ? this.renderer.shadowMap.enabled : true,
      },
      view: {
        showGrid: this.showGrid,
        wireframeMode: this.wireframeMode,
      },
      materials: materialOverrides,
    };
  }

  /**
   * Restore scene configuration from state object
   * @param {Object} state
   */
  restoreSceneState(state) {
    if (!state) return;

    if (state.camera && this.camera) {
      if (Array.isArray(state.camera.position)) this.camera.position.fromArray(state.camera.position);
      if (state.camera.fov) this.camera.fov = state.camera.fov;
      this.camera.updateProjectionMatrix();
    }

    if (state.target && this.controls) {
      this.controls.target.fromArray(state.target);
      this.controls.update();
    }

    if (state.lights) {
      for (const [name, cfg] of Object.entries(state.lights)) {
        if (this.lights[name] && cfg) {
          if (cfg.intensity !== undefined) this.setLightIntensity(name, cfg.intensity);
          if (cfg.visible !== undefined) this.setLightEnabled(name, cfg.visible);
          if (cfg.color) this.setLightColor(name, cfg.color);
        }
      }
    }

    if (state.environment) {
      const env = state.environment;
      if (env.exposure !== undefined) this.setExposure(env.exposure);
      if (env.environmentIntensity !== undefined) this.setEnvironmentIntensity(env.environmentIntensity);
      if (env.shadows !== undefined) this.setShadows(env.shadows);
    }

    if (state.view) {
      if (state.view.showGrid !== undefined) this.setGridVisible(state.view.showGrid);
      if (state.view.wireframeMode !== undefined && state.view.wireframeMode !== this.wireframeMode) {
        this.toggleWireframe();
      }
    }

    if (Array.isArray(state.materials) && this.currentModel) {
      this.currentModel.traverse((child) => {
        if (child.isMesh && child.material) {
          const override = state.materials.find(m => m.meshName === child.name);
          if (override) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(m => {
              if (override.color && m.color) m.color.set(override.color);
              if (override.roughness !== undefined && 'roughness' in m) m.roughness = override.roughness;
              if (override.metalness !== undefined && 'metalness' in m) m.metalness = override.metalness;
              if (override.opacity !== undefined) m.opacity = override.opacity;
              if (override.transparent !== undefined) m.transparent = override.transparent;
              m.needsUpdate = true;
            });
          }
        }
      });
    }
  }

  toggleWireframe() {
    this.wireframeMode = !this.wireframeMode;
    if (this.currentModel) {
      this.currentModel.traverse((child) => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(m => { m.wireframe = this.wireframeMode; });
        }
      });
    }
    return this.wireframeMode;
  }

  setWireframe(enabled) {
    this.wireframeMode = Boolean(enabled);
    if (this.currentModel) {
      this.currentModel.traverse((child) => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(m => { m.wireframe = this.wireframeMode; });
        }
      });
    }
  }

  toggleGrid() {
    this.showGrid = !this.showGrid;
    if (this.gridHelper) this.gridHelper.visible = this.showGrid;
    return this.showGrid;
  }

  toggleAutoRotate() {
    this.isAutoRotating = !this.isAutoRotating;
    return this.isAutoRotating;
  }

  toggleOrbitLight() {
    this.isLightOrbiting = !this.isLightOrbiting;
    return this.isLightOrbiting;
  }

  setShadows(enabled) {
    this.renderer.shadowMap.enabled = Boolean(enabled);
    if (this.lights.key) this.lights.key.castShadow = Boolean(enabled);
  }

  setLightIntensity(name, value) {
    if (this.lights[name]) this.lights[name].intensity = THREE.MathUtils.clamp(Number(value), 0, 5);
  }

  setLightEnabled(name, enabled) {
    if (this.lights[name]) this.lights[name].visible = Boolean(enabled);
  }

  setLightColor(name, color) {
    if (this.lights[name] && /^#[0-9a-f]{6}$/i.test(color)) this.lights[name].color.set(color);
  }

  setExposure(value) {
    if (this.renderer) this.renderer.toneMappingExposure = THREE.MathUtils.clamp(Number(value), 0.1, 5);
  }

  setEnvironmentIntensity(value) {
    this.environmentIntensity = THREE.MathUtils.clamp(Number(value), 0, 3);
    this._applyEnvironmentSettings();
  }

  _applyEnvironmentSettings() {
    if (!this.currentModel) return;
    this.currentModel.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        if ('envMapIntensity' in material) material.envMapIntensity = this.environmentIntensity;
        material.needsUpdate = true;
      });
    });
  }

  setGridVisible(visible) {
    this.showGrid = Boolean(visible);
    if (this.gridHelper) this.gridHelper.visible = this.showGrid;
  }

  setHologram(enabled) {
    if (!this.currentModel) return;
    this.currentModel.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      if (enabled) {
        if (!this._originalMaterials.has(child.uuid)) {
          this._originalMaterials.set(child.uuid, child.material);
        }
        if (!this._hologramMaterials.has(child.uuid)) {
          const sourceMaterials = Array.isArray(child.material) ? child.material : [child.material];
          const hologramMaterials = sourceMaterials.map((source) => {
            const material = source.clone();
            material.transparent = true;
            material.opacity = 0.68;
            if (material.emissive) material.emissive.set(0x00f2fe);
            if ('emissiveIntensity' in material) material.emissiveIntensity = Math.max(material.emissiveIntensity || 0, 0.8);
            material.needsUpdate = true;
            return material;
          });
          const hologramMaterial = Array.isArray(child.material) ? hologramMaterials : hologramMaterials[0];
          this._hologramMaterials.set(child.uuid, hologramMaterial);
          child.material = hologramMaterial;
        }
      } else if (this._originalMaterials.has(child.uuid)) {
        const hologramMaterial = this._hologramMaterials.get(child.uuid);
        (Array.isArray(hologramMaterial) ? hologramMaterial : [hologramMaterial]).filter(Boolean).forEach((material) => material.dispose());
        child.material = this._originalMaterials.get(child.uuid);
        const originalMaterials = Array.isArray(child.material) ? child.material : [child.material];
        originalMaterials.forEach((material) => { material.needsUpdate = true; });
        this._hologramMaterials.delete(child.uuid);
        this._originalMaterials.delete(child.uuid);
      }
    });
  }

  _restoreOriginalMaterials() {
    if (!this.currentModel) return;
    this.currentModel.traverse((child) => {
      if (!child.isMesh || !this._originalMaterials.has(child.uuid)) return;
      const hologramMaterial = this._hologramMaterials.get(child.uuid);
      (Array.isArray(hologramMaterial) ? hologramMaterial : [hologramMaterial]).filter(Boolean).forEach((material) => material.dispose());
      child.material = this._originalMaterials.get(child.uuid);
      const originalMaterials = Array.isArray(child.material) ? child.material : [child.material];
      originalMaterials.forEach((material) => { material.needsUpdate = true; });
    });
  }

  _clearMaterialState() {
    this._hologramMaterials.clear();
    this._originalMaterials.clear();
  }

  getStats() {
    let meshCount = 0;
    let polyCount = 0;
    let vertCount = 0;

    if (this.currentModel) {
      this.currentModel.traverse((child) => {
        if (child.isMesh) {
          meshCount++;
          const geo = child.geometry;
          if (geo) {
            if (geo.index) {
              polyCount += geo.index.count / 3;
            } else if (geo.attributes?.position) {
              polyCount += geo.attributes.position.count / 3;
            }
            if (geo.attributes?.position) {
              vertCount += geo.attributes.position.count;
            }
          }
        }
      });
    }

    return {
      meshCount,
      polyCount: Math.round(polyCount),
      vertCount: Math.round(vertCount),
      drawCalls: this.drawCalls || meshCount,
      modelName: this.currentModel ? this.currentModel.name : 'None'
    };
  }

  clearModel() {
    if (this.currentModel) {
      this._restoreOriginalMaterials();
      this.scene.remove(this.currentModel);
      this._disposeObject(this.currentModel);
      this.currentModel = null;
    }
    this._clearMaterialState();
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
      this.animActions = [];
    }
  }

  _disposeObject(obj) {
    if (!obj) return;
    obj.traverse((child) => {
      if (child.isMesh) {
        if (child.geometry) {
          child.geometry.dispose();
        }
        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(m => {
            if (m) {
              Object.values(m).forEach((value) => {
                if (value && value.isTexture) {
                  value.dispose();
                }
              });
              m.dispose();
            }
          });
        }
      }
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.controls) this.controls.dispose();
    
    // Properly dispose of current model and all cached materials
    if (this.currentModel) {
      this._restoreOriginalMaterials();
      this._disposeObject(this.currentModel);
      this.currentModel = null;
    }

    // Dispose hologram materials
    this._hologramMaterials.forEach((materials) => {
      const mats = Array.isArray(materials) ? materials : [materials];
      mats.forEach(m => {
        if (m && m.dispose) m.dispose();
      });
    });
    this._hologramMaterials.clear();
    this._originalMaterials.clear();

    // Dispose grid and background
    if (this.gridHelper) this._disposeObject(this.gridHelper);
    // Dispose lights
    Object.values(this.lights).forEach(light => {
      if (light && this.scene && this.scene.remove) {
        this.scene.remove(light);
      }
    });

    // Dispose renderer
    if (this.renderer) {
      this.renderer.dispose();
      try {
        this.renderer.forceContextLoss();
      } catch (e) {
        console.warn('[Viewer3D] Could not force WebGL context loss:', e);
      }
    }

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.currentModel = null;
  }
}

const viewer3d = new Viewer3D('viewport3d');
export default viewer3d;
