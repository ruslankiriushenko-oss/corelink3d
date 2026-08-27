/**
 * CoreLink 3D — Viewport Module
 * Three.js renderer: GLB/GLTF, DRACO, OrbitControls, auto-rotation
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }   from 'three/addons/loaders/DRACOLoader.js';

class Viewport3D {
  constructor(canvasId) {
    this.canvas        = document.getElementById(canvasId);
    this.scene         = null;
    this.camera        = null;
    this.renderer      = null;
    this.controls      = null;
    this.currentModel  = null;
    this.mixer         = null;   // AnimationMixer for GLB animations
    this.animActions   = [];
    this.clock         = new THREE.Clock();
    this.gridHelper    = null;
    this.showGrid      = false;
    this.wireframeMode = false;
    this.autoRotateSpeed = 0;
    this.animFrameId   = null;
    this.frameCount    = 0;
    this.fpsStart      = performance.now();
    this.fps           = 0;

    this._init();
  }

  // ── Init ────────────────────────────────────────────────────
  _init() {
    const container = this.canvas.parentElement;
    const w = container.clientWidth  || 800;
    const h = container.clientHeight || 600;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.001, 5000);
    this.camera.position.set(0, 1.5, 5);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas:          this.canvas,
      antialias:       true,
      alpha:           false,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping          = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure   = 1.0;
    this.renderer.outputColorSpace      = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled     = true;
    this.renderer.shadowMap.type        = THREE.PCFSoftShadowMap;

    // OrbitControls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping    = true;
    this.controls.dampingFactor    = 0.06;
    this.controls.minDistance      = 0.001;
    this.controls.maxDistance      = 2000;
    this.controls.panSpeed         = 0.8;
    this.controls.rotateSpeed      = 0.7;
    this.controls.zoomSpeed        = 1.1;
    this.controls.screenSpacePanning = true;

    this._setupLights();

    // Grid (hidden by default — matches scene background)
    this.gridHelper = new THREE.GridHelper(30, 30, 0x1c1c1c, 0x111111);
    this.gridHelper.visible = false;
    this.scene.add(this.gridHelper);

    // ResizeObserver (more reliable than window resize for panel layouts)
    const ro = new ResizeObserver(() => this._onResize());
    ro.observe(container);

    this._loop();
  }

  // ── Lights ──────────────────────────────────────────────────
  _setupLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(5, 10, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias        = -0.0001;
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far  = 500;
    key.shadow.camera.left = key.shadow.camera.bottom = -20;
    key.shadow.camera.right = key.shadow.camera.top   = 20;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x8899ff, 0.25);
    fill.position.set(-6, 3, -5);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffeedd, 0.4);
    rim.position.set(0, -4, -10);
    this.scene.add(rim);
  }

  // ── Render loop ──────────────────────────────────────────────
  _loop() {
    this.animFrameId = requestAnimationFrame(() => this._loop());

    const delta = this.clock.getDelta();

    // Advance GLB animations
    if (this.mixer) this.mixer.update(delta);

    // Auto-rotate
    if (this.autoRotateSpeed > 0 && this.currentModel) {
      this.currentModel.rotation.y += this.autoRotateSpeed * delta;
    }

    this.controls.update();

    // FPS counter (updates every second)
    this.frameCount++;
    const now = performance.now();
    if (now - this.fpsStart >= 1000) {
      this.fps = Math.round((this.frameCount * 1000) / (now - this.fpsStart));
      this.frameCount = 0;
      this.fpsStart   = now;
      const el = document.getElementById('hudFps');
      if (el) el.textContent = `${this.fps} fps`;
    }

    this.renderer.render(this.scene, this.camera);
  }

  // ── Resize ──────────────────────────────────────────────────
  _onResize() {
    const el = this.canvas.parentElement;
    const w  = el.clientWidth;
    const h  = el.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // ── Load GLB / GLTF ─────────────────────────────────────────
  /**
   * Load a GLB/GLTF from URL.
   * @param {string}   url
   * @param {function} onProgress  (percent: number) => void
   * @returns {Promise<ModelInfo>}
   */
  loadModel(url, onProgress) {
    return new Promise((resolve, reject) => {
      // Dispose previous model
      if (this.currentModel) {
        this.scene.remove(this.currentModel);
        this._disposeObject(this.currentModel);
        this.currentModel = null;
      }
      if (this.mixer) {
        this.mixer.stopAllAction();
        this.mixer = null;
        this.animActions = [];
      }

      const draco = new DRACOLoader();
      draco.setDecoderPath(
        'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/'
      );

      const loader = new GLTFLoader();
      loader.setDRACOLoader(draco);

      loader.load(
        url,
        (gltf) => {
          const model = gltf.scene;

          // Center at origin
          const box    = new THREE.Box3().setFromObject(model);
          const center = box.getCenter(new THREE.Vector3());
          const size   = box.getSize(new THREE.Vector3());

          model.position.sub(center);   // move pivot to center

          // Normalise to 3-unit bounding box
          const maxDim = Math.max(size.x, size.y, size.z);
          if (maxDim > 0) model.scale.setScalar(3 / maxDim);

          // Enable shadows; apply wireframe if active
          model.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow    = true;
            child.receiveShadow = true;
            if (this.wireframeMode && child.material) {
              const mats = Array.isArray(child.material) ? child.material : [child.material];
              mats.forEach(m => { m.wireframe = true; });
            }
          });

          this.scene.add(model);
          this.currentModel = model;

          // Recalculate box AFTER all transforms for correct camera fit
          const boxFinal = new THREE.Box3().setFromObject(model);
          const sizeFinal = boxFinal.getSize(new THREE.Vector3());
          this._fitCamera(sizeFinal);

          // GLB animations
          if (gltf.animations?.length) {
            this.mixer = new THREE.AnimationMixer(model);
            this.animActions = gltf.animations.map(clip => {
              const action = this.mixer.clipAction(clip);
              action.play();
              return action;
            });
          }

          const info = this._collectInfo(gltf, sizeFinal);
          resolve(info);
        },
        (xhr) => {
          if (onProgress && xhr.lengthComputable) {
            onProgress(Math.round((xhr.loaded / xhr.total) * 100));
          }
        },
        (err) => reject(err)
      );
    });
  }

  // ── Camera fit ───────────────────────────────────────────────
  _fitCamera(size) {
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov    = this.camera.fov * (Math.PI / 180);
    const dist   = (maxDim / 2) / Math.tan(fov / 2) * 1.7;

    this.camera.position.set(dist * 0.45, maxDim * 0.35, dist);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  // ── Model stats ──────────────────────────────────────────────
  _collectInfo(gltf, size) {
    let meshes    = 0;
    let polygons  = 0;
    const matSet  = new Set();

    gltf.scene.traverse((child) => {
      if (!child.isMesh) return;
      meshes++;
      const geo = child.geometry;
      if (geo?.index)                       polygons += geo.index.count / 3;
      else if (geo?.attributes?.position)   polygons += geo.attributes.position.count / 3;
      (Array.isArray(child.material) ? child.material : [child.material])
        .forEach(m => m && matSet.add(m.uuid));
    });

    const info = {
      meshes,
      polygons:   Math.round(polygons),
      materials:  matSet.size,
      animations: gltf.animations?.length || 0,
      size:       size ? `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}` : '—',
    };

    // Update HUD
    const hudPoly = document.getElementById('hudPolyCount');
    const hudMesh = document.getElementById('hudMeshCount');
    if (hudPoly) hudPoly.textContent = `${info.polygons.toLocaleString()} polys`;
    if (hudMesh) hudMesh.textContent = `${info.meshes} meshes`;

    return info;
  }

  // ── Dispose ─────────────────────────────────────────────────
  _disposeObject(obj) {
    obj.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry?.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach(m => {
        if (!m) return;
        Object.values(m).forEach(v => { if (v?.isTexture) v.dispose(); });
        m.dispose();
      });
    });
  }

  // ── Public API ───────────────────────────────────────────────

  resetCamera() {
    if (this.currentModel) {
      const box  = new THREE.Box3().setFromObject(this.currentModel);
      const size = box.getSize(new THREE.Vector3());
      this._fitCamera(size);
    } else {
      this.camera.position.set(0, 1.5, 5);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
  }

  toggleGrid() {
    this.showGrid = !this.showGrid;
    this.gridHelper.visible = this.showGrid;
    return this.showGrid;
  }

  toggleWireframe() {
    this.wireframeMode = !this.wireframeMode;
    if (this.currentModel) {
      this.currentModel.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        (Array.isArray(child.material) ? child.material : [child.material])
          .forEach(m => { m.wireframe = this.wireframeMode; });
      });
    }
    return this.wireframeMode;
  }

  toggleAnimations() {
    if (!this.animActions.length) return false;
    const anyPlaying = this.animActions.some(a => a.isRunning());
    this.animActions.forEach(a => anyPlaying ? a.stop() : a.play());
    return !anyPlaying;
  }

  setBackground(hexColor) {
    this.scene.background = new THREE.Color(`#${hexColor}`);
  }

  setExposure(value) {
    this.renderer.toneMappingExposure = parseFloat(value);
  }

  setAutoRotate(speed) {
    this.autoRotateSpeed = parseFloat(speed);
  }

  destroy() {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    this.renderer.dispose();
  }
}

const viewport = new Viewport3D('viewport3d');
export default viewport;
