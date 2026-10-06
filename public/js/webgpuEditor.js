import projectBundle from './projectBundle.js';
import { MAX_MODEL_FILE_SIZE_BYTES, validateModelFile } from './modelValidation.js';
import {
  saveEditorModelFile, getSavedEditorModelFile, clearSavedEditorModelFile,
  saveEditorSceneState, getSavedEditorSceneState, clearSavedEditorSceneState,
} from './modelStorage.js';

/**
 * CoreLink 3D — Babylon.js (WebGPU / WebGL2) Unified Professional 3D Scene Studio.
 * - Monolithic engineering workflow
 * - Outliner with search, hierarchy, and visibility toggles
 * - Transform gizmos (Translate, Rotate, Scale, Bounds)
 * - PBR Principled Material Editor & World Environment Editor
 * - Primitive / Light spawner, glTF/GLB/CL3D import & export
 * - Session auto-restore from IndexedDB
 */

const HELPER_MESHES = new Set(['StudioGround', 'StudioAxisX', 'StudioAxisZ']);

class WebGPUEditor {
  constructor() {
    this.root = null;
    this.canvas = null;
    this.loader = null;
    this.loaderText = null;
    this.engineBadge = null;
    this.modelInfo = null;

    // Engine & Scene
    this.engine = null;
    this.scene = null;
    this.camera = null;
    this.gizmoManager = null;
    this.isWebGPU = false;
    this.isOpen = false;
    this.selectedNode = null;

    // Telemetry
    this._lastFpsUpdate = 0;
    this._fps = 60;
    this._lastInspectorSync = 0;
    this._renderingFailed = false;
    this._engineLossObserver = null;
    this._saveTimer = null;
    this._savingScene = false;
    this._savePending = false;
    this._restoringScene = false;
    this._historyInProgress = false;
    this._historyBaseline = null;
    this.undoStack = [];
    this.redoStack = [];

    // Gizmo & Viewport State
    this.currentGizmo = 'position';
    this.snapEnabled = false;
    this.collapsedGraphGroups = new Set();
    this._activeGraphFilter = '';
    this.exportFormat = 'glb';

    this._resizeHandler = this._onResize.bind(this);
  }

  /**
   * Bind DOM elements and attach event handlers
   */
  init() {
    if (this._initialized) return;
    this._initialized = true;

    this.root = document.getElementById('app');
    this.canvas = document.getElementById('webgpuCanvas');
    this.loader = document.getElementById('editorLoader');
    this.loaderText = document.getElementById('editorLoaderText');
    this.engineBadge = document.getElementById('editorEngineBadge');
    this.modelInfo = document.getElementById('editorModelInfo');

    // Native Babylon Inspector button
    const btnInspector = document.getElementById('btnToggleInspector');
    if (btnInspector) btnInspector.addEventListener('click', () => this.toggleNativeInspector());

    // Top menu exports
    document.querySelectorAll('[data-export]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.exportActiveScene(btn.dataset.export);
      });
    });

    // Import inputs
    const importInput = document.getElementById('editorImportInput');
    if (importInput) {
      const triggerImport = () => importInput.click();
      const menuImport = document.getElementById('menuImportFile');
      if (menuImport) menuImport.addEventListener('click', triggerImport);

      importInput.addEventListener('change', async () => {
        const [file] = importInput.files || [];
        importInput.value = '';
        if (file) await this.importEditorFile(file);
      });
    }

    // Viewport Drag & Drop
    const viewport = document.getElementById('editorViewportContainer');
    if (viewport) {
      ['dragenter', 'dragover'].forEach((eventName) => viewport.addEventListener(eventName, (event) => {
        event.preventDefault();
        viewport.classList.add('drag-over');
      }));
      ['dragleave', 'drop'].forEach((eventName) => viewport.addEventListener(eventName, (event) => {
        event.preventDefault();
        viewport.classList.remove('drag-over');
      }));
      viewport.addEventListener('drop', async (event) => {
        const [file] = event.dataTransfer?.files || [];
        if (file) await this.importEditorFile(file);
      });
    }

    // Outliner Graph search
    const graphSearch = document.getElementById('editorGraphSearch');
    if (graphSearch) {
      graphSearch.addEventListener('input', (e) => this._filterSceneGraph(e.target.value));
    }

    // Tool Shelf Gizmos
    const toolShelf = document.getElementById('toolShelf');
    if (toolShelf) {
      toolShelf.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-gizmo]');
        if (!btn) return;
        const mode = btn.dataset.gizmo;
        if (mode) this.setGizmoMode(mode);
      });
    }

    this.canvas?.addEventListener('pointerup', () => this._scheduleSceneSave());
    this.root?.addEventListener('input', (event) => {
      if (event.target.closest('.b-tab-pane')) this._scheduleSceneSave();
    });
    this.root?.addEventListener('change', (event) => {
      if (event.target.closest('.b-tab-pane')) this._scheduleSceneSave();
    });

    // Save before page unload
    window.addEventListener('beforeunload', () => {
      this._persistSceneState();
    });

    // Grid snapping toggle
    const snapBtn = document.getElementById('editorSnapBtn');
    if (snapBtn) {
      snapBtn.addEventListener('click', () => {
        this.snapEnabled = !this.snapEnabled;
        snapBtn.classList.toggle('active', this.snapEnabled);
        this._updateGizmoSnapping();
      });
    }

    // Focus camera buttons
    const btnShelfFocus = document.getElementById('btnShelfFocus');
    const menuFocus = document.getElementById('menuFocusSelected');
    [btnShelfFocus, menuFocus].forEach(btn => {
      if (btn) btn.addEventListener('click', () => this.frameSelected());
    });

    // Delete buttons
    const menuDelete = document.getElementById('menuDeleteSelected');
    if (menuDelete) {
      menuDelete.addEventListener('click', () => this.deleteSelectedNode());
    }

    // Duplicate button
    const menuDuplicate = document.getElementById('menuDuplicateSelected');
    if (menuDuplicate) menuDuplicate.addEventListener('click', () => this.duplicateSelected());

    // Deselect button
    const menuDeselect = document.getElementById('menuDeselect');
    if (menuDeselect) menuDeselect.addEventListener('click', () => this.selectNode(null));

    // New Scene & Reset
    const menuNewScene = document.getElementById('menuNewScene');
    const menuResetScene = document.getElementById('menuResetScene');
    if (menuNewScene) menuNewScene.addEventListener('click', () => this.newScene());
    if (menuResetScene) menuResetScene.addEventListener('click', () => this.resetWorkspace());

    // Shading Mode buttons
    const shadingGroup = document.getElementById('shadingGroup');
    if (shadingGroup) {
      shadingGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-shading]');
        if (!btn) return;
        shadingGroup.querySelectorAll('.b-shading-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.setShadingMode(btn.dataset.shading);
      });
    }

    // View Menu camera shortcuts
    const menuCamOrbit = document.getElementById('menuCamOrbit');
    const menuCamTop = document.getElementById('menuCamTop');
    const menuCamFront = document.getElementById('menuCamFront');
    const menuCamFree = document.getElementById('menuCamFree');
    if (menuCamOrbit) menuCamOrbit.addEventListener('click', () => this.switchCamera('orbit'));
    if (menuCamTop) menuCamTop.addEventListener('click', () => this.switchCamera('top'));
    if (menuCamFront) menuCamFront.addEventListener('click', () => this.switchCamera('front'));
    if (menuCamFree) menuCamFree.addEventListener('click', () => this.switchCamera('free'));

    // Floor Grid toggle
    const menuToggleGrid = document.getElementById('menuToggleGrid');
    const envShowGrid = document.getElementById('envShowGrid');
    const checkMenuGrid = document.getElementById('checkMenuGrid');
    const toggleGridFn = () => {
      const grid = this.scene?.getMeshByName('StudioGround');
      const axisX = this.scene?.getMeshByName('StudioAxisX');
      const axisZ = this.scene?.getMeshByName('StudioAxisZ');
      if (grid) {
        const isEnabled = !grid.isEnabled();
        grid.setEnabled(isEnabled);
        if (axisX) axisX.setEnabled(isEnabled);
        if (axisZ) axisZ.setEnabled(isEnabled);
        if (envShowGrid) envShowGrid.checked = isEnabled;
        if (checkMenuGrid) {
          checkMenuGrid.innerHTML = isEnabled ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : '';
        }
      }
    };
    if (menuToggleGrid) menuToggleGrid.addEventListener('click', toggleGridFn);
    if (envShowGrid) envShowGrid.addEventListener('change', () => toggleGridFn());

    const menuToggleStats = document.getElementById('menuToggleStats');
    const performanceOverlay = document.getElementById('performanceOverlay');
    const checkMenuStats = document.getElementById('checkMenuStats');
    if (menuToggleStats && performanceOverlay) {
      menuToggleStats.addEventListener('click', () => {
        const isVisible = performanceOverlay.hidden;
        performanceOverlay.hidden = !isVisible;
        menuToggleStats.setAttribute('aria-pressed', String(isVisible));
        if (checkMenuStats) {
          checkMenuStats.innerHTML = isVisible ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : '';
        }
      });
    }

    // Fullscreen toggle
    const menuToggleFullscreen = document.getElementById('menuToggleFullscreen');
    if (menuToggleFullscreen) {
      menuToggleFullscreen.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      });
    }

    // Mesh Menu Action Bindings
    const menuMeshJoin = document.getElementById('menuMeshJoin');
    const menuMeshFlatShading = document.getElementById('menuMeshFlatShading');
    const menuMeshSmoothShading = document.getElementById('menuMeshSmoothShading');
    const menuMeshFlipNormals = document.getElementById('menuMeshFlipNormals');
    const menuMeshToggleWireframe = document.getElementById('menuMeshToggleWireframe');

    if (menuMeshJoin) menuMeshJoin.addEventListener('click', () => this.joinSelected());
    if (menuMeshFlatShading) menuMeshFlatShading.addEventListener('click', () => this.setFlatShading());
    if (menuMeshSmoothShading) menuMeshSmoothShading.addEventListener('click', () => this.setSmoothShading());
    if (menuMeshFlipNormals) menuMeshFlipNormals.addEventListener('click', () => this.flipNormals());
    if (menuMeshToggleWireframe) menuMeshToggleWireframe.addEventListener('click', () => this.toggleWireframeMesh());

    // Left Shelf: Reset Material to Default Gray
    const btnResetMaterialGray = document.getElementById('btnResetMaterialGray');
    if (btnResetMaterialGray) {
      btnResetMaterialGray.addEventListener('click', () => this.resetToDefaultGrayMaterial());
    }

    // Primitive & Light Spawners
    document.querySelectorAll('[data-create]').forEach((item) => {
      item.addEventListener('click', () => this.createPrimitive(item.dataset.create));
    });

    // World / Environment controls
    const envIntensity = document.getElementById('envIntensity');
    const envIntensityVal = document.getElementById('envIntensityVal');
    if (envIntensity) {
      this._updateSliderStyle(envIntensity);
      envIntensity.addEventListener('input', () => {
        const val = parseFloat(envIntensity.value);
        if (envIntensityVal) envIntensityVal.textContent = val.toFixed(2);
        this._updateSliderStyle(envIntensity);
        if (this.scene) this.scene.environmentIntensity = val;
      });
    }

    const bgColor = document.getElementById('envBackgroundColor');
    const bgColorHex = document.getElementById('envBackgroundColorHex');
    const applyBg = (hex) => {
      if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
      if (bgColor) bgColor.value = hex;
      if (bgColorHex) bgColorHex.value = hex;
      if (this.scene && window.BABYLON) {
        this.scene.clearColor = BABYLON.Color4.FromColor3(BABYLON.Color3.FromHexString(hex), 1);
      }
    };
    if (bgColor) bgColor.addEventListener('input', (e) => applyBg(e.target.value));
    if (bgColorHex) bgColorHex.addEventListener('change', (e) => applyBg(e.target.value));

    // Bind Inspector Form inputs
    this._bindInspectorInputs();

    // X key tracking for Box Selection & Camera locking + Global shortcuts
    this.isXKeyPressed = false;
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (document.querySelector('.b-modal-overlay.open')) return;

      if (e.key === 'x' || e.key === 'X') {
        if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
          if (!this.isXKeyPressed) {
            this.isXKeyPressed = true;
            if (this.camera && this.canvas) {
              this.camera.detachControl();
            }
          }
        }
      }

      const key = e.key;
      const keyLower = key.toLowerCase();
      const ctrlOrMeta = e.ctrlKey || e.metaKey;

      if (ctrlOrMeta && keyLower === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (ctrlOrMeta && keyLower === 'y') {
        e.preventDefault();
        this.redo();
      } else if (ctrlOrMeta && keyLower === 's') {
        e.preventDefault();
        this._scheduleSceneSave({ recordHistory: true });
        this.log('Scene saved', 'info');
      } else if (ctrlOrMeta && keyLower === 'n') {
        e.preventDefault();
        this.resetScene();
      } else if (ctrlOrMeta && keyLower === 'o') {
        e.preventDefault();
        document.getElementById('fileInput')?.click();
      } else if (ctrlOrMeta && keyLower === 'd') {
        e.preventDefault();
        this.duplicateSelected();
      } else if (ctrlOrMeta && keyLower === 'j') {
        e.preventDefault();
        this.joinSelected();
      } else if (ctrlOrMeta && keyLower === 'f') {
        e.preventDefault();
        document.getElementById('menuToggleStats')?.click();
      } else if (e.shiftKey && keyLower === 'a') {
        e.preventDefault();
        this.createPrimitive('box');
      } else if (e.shiftKey && keyLower === 's') {
        e.preventDefault();
        this.createPrimitive('sphere');
      } else if (e.shiftKey && keyLower === 'c') {
        e.preventDefault();
        this.createPrimitive('cylinder');
      } else if (e.shiftKey && keyLower === 'k') {
        e.preventDefault();
        this.createPrimitive('capsule');
      } else if (e.shiftKey && keyLower === 't') {
        e.preventDefault();
        this.createPrimitive('torus');
      } else if (e.shiftKey && keyLower === 'p') {
        e.preventDefault();
        this.createPrimitive('plane');
      } else if (e.shiftKey && keyLower === 'l') {
        e.preventDefault();
        this.createPrimitive('dirLight');
      } else if (e.shiftKey && keyLower === 'i') {
        e.preventDefault();
        this.createPrimitive('pointLight');
      } else if (e.shiftKey && keyLower === 'o') {
        e.preventDefault();
        this.createPrimitive('spotLight');
      } else if (e.altKey && e.key === 'F2') {
        e.preventDefault();
        this.setFlatShading();
      } else if (e.altKey && e.key === 'F3') {
        e.preventDefault();
        this.setSmoothShading();
      } else if (e.altKey && keyLower === 'f') {
        e.preventDefault();
        this.flipNormals();
      } else if (key === 'Escape') {
        this.selectNode(null);
      } else if (!ctrlOrMeta && !e.shiftKey && !e.altKey && keyLower === 'f') {
        this.frameSelected();
      } else if (!ctrlOrMeta && !e.shiftKey && !e.altKey && keyLower === 'q') {
        this.setGizmoMode('select');
      } else if (!ctrlOrMeta && !e.shiftKey && !e.altKey && keyLower === 'w') {
        this.setGizmoMode('position');
      } else if (!ctrlOrMeta && !e.shiftKey && !e.altKey && keyLower === 'e') {
        this.setGizmoMode('rotation');
      } else if (!ctrlOrMeta && !e.shiftKey && !e.altKey && keyLower === 'r') {
        this.setGizmoMode('scaling');
      } else if (!ctrlOrMeta && !e.shiftKey && !e.altKey && keyLower === 'z') {
        this.toggleWireframeMode();
      } else if (!ctrlOrMeta && !e.shiftKey && !e.altKey && keyLower === 'g') {
        this.toggleGrid();
      } else if (key === 'F1') {
        e.preventDefault();
        document.getElementById('btnMenuShortcuts')?.click();
      } else if (key === 'Delete' || key === 'Backspace') {
        if (this.selectedNode && this.selectedNode !== this.scene) {
          e.preventDefault();
          this.deleteSelectedNode();
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.key === 'x' || e.key === 'X') {
        this.isXKeyPressed = false;
        if (this.camera && this.canvas) {
          this.camera.attachControl(this.canvas, true);
        }
        const selectionBox = document.getElementById('selectionBox');
        if (selectionBox) selectionBox.style.display = 'none';
      }
    });
  }

  _setLoader(text) {
    if (this.loaderText) this.loaderText.textContent = text;
    if (this.loader) this.loader.style.display = 'flex';
  }

  _hideLoader() {
    if (this.loader) this.loader.style.display = 'none';
  }

  log(msg, type = 'info') {
    const out = document.getElementById('editorConsoleOutput');
    if (!out) {
      const logger = type === 'error' ? console.error : type === 'warn' ? console.warn : console.info;
      logger(`[CoreLink 3D] ${msg}`);
      return;
    }
    const time = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.className = `console-log ${type}`;
    div.textContent = `[${time}] ${msg}`;
    out.appendChild(div);
    out.scrollTop = out.scrollHeight;
  }

  _setExportMenu(open) {
    const button = document.getElementById('btnEditorExport');
    const popover = document.getElementById('editorExportPopover');
    if (!button || !popover) return;
    popover.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }

  _updateExportFormatOptions() {
    document.querySelectorAll('[data-export-format]').forEach((item) => {
      item.classList.toggle('is-active', item.dataset.exportFormat === this.exportFormat);
    });
  }

  /**
   * Start the single-screen Babylon 3D editor
   */
  async start() {
    if (this.isOpen) return;
    this.init();
    this.isOpen = true;

    try {
      this._setLoader('Loading Babylon.js WebGPU Engine...');
      await this._ensureBabylonLoaded();

      this._setLoader('Initializing 3D Pipeline...');
      if (!this.engine) {
        await this._initEngine();
      }

      this._setLoader('Setting up Scene & Studio Lighting...');
      await this._initScene();

      this._setLoader('Restoring Workspace...');
      await this._restoreOrCreateDefault();
      this._historyBaseline = this._captureSceneSnapshot();

      this._refreshSceneGraph();
      this._hideLoader();
      this.log('Studio initialized successfully.', 'info');

      window.addEventListener('resize', this._resizeHandler);
      this._onResize();
    } catch (err) {
      console.error('[WebGPUEditor] Error during start:', err);
      this.log(`Init error: ${err.message}`, 'error');
      this._hideLoader();
    }
  }

  async _ensureBabylonLoaded() {
    let tries = 0;
    while ((!window.BABYLON || !window.BABYLON.Engine) && tries < 50) {
      await new Promise(r => setTimeout(r, 100));
      tries++;
    }
    if (!window.BABYLON || !window.BABYLON.Engine) {
      throw new Error('Babylon.js engine library is loading. Please verify network connection.');
    }
  }

  async _initEngine() {
    const canvas = this.canvas;
    const engineOptions = {
      preserveDrawingBuffer: true,
      stencil: true,
      adaptToDeviceRatio: true,
      powerPreference: 'high-performance'
    };

    this.isWebGPU = false;
    this._renderingFailed = false;

    if (navigator.gpu && BABYLON.WebGPUEngine) {
      let webgpuEngine = null;
      const originalLoggerError = (window.BABYLON && BABYLON.Logger) ? BABYLON.Logger.Error : null;
      try {
        if (BABYLON.Logger) BABYLON.Logger.Error = () => {};
        const isSupported = await BABYLON.WebGPUEngine.IsSupportedAsync;
        if (isSupported) {
          webgpuEngine = new BABYLON.WebGPUEngine(canvas, engineOptions);
          await webgpuEngine.initAsync();
          this.engine = webgpuEngine;
          this.isWebGPU = true;
          this.log('WebGPU Native Engine started.', 'info');
        } else {
          console.warn('[WebGPUEditor] WebGPU adapter unavailable. Falling back to WebGL2.');
        }
      } catch (error) {
        if (webgpuEngine) {
          try { webgpuEngine.dispose(); } catch (_) {}
        }
        console.warn('[WebGPUEditor] WebGPU fallback to WebGL2.');
      } finally {
        if (BABYLON.Logger && originalLoggerError) {
          BABYLON.Logger.Error = originalLoggerError;
        }
      }
    }

    if (!this.engine) {
      this.engine = new BABYLON.Engine(canvas, true, engineOptions);
      this.log('WebGL2 Engine started.', 'info');
    }

    const badgeText = document.getElementById('engineBadgeText');
    if (badgeText) badgeText.textContent = this.isWebGPU ? 'WebGPU Native' : 'WebGL 2.0';
    if (this.engineBadge) this.engineBadge.className = `b-engine-badge ${this.isWebGPU ? 'webgpu' : 'webgl'}`;

    this.engine.runRenderLoop(() => {
      if (!this.scene || !this.isOpen || this._renderingFailed) return;
      try {
        this.scene.render();
        this._updateTelemetry();
      } catch (error) {
        this._handleViewportFailure(error);
      }
    });
  }

  _handleViewportFailure(error) {
    if (this._renderingFailed) return;
    this._renderingFailed = true;
    console.error('[WebGPUEditor] Viewport render error:', error);
    this.log(`Viewport paused safely: ${error.message || 'graphics device lost'}`, 'error');
  }

  /**
   * Setup Scene, Lights, Camera, Gizmos, and Default Meshes
   */
  async _initScene() {
    if (this.scene) {
      this.scene.dispose();
    }

    const scene = new BABYLON.Scene(this.engine);
    this.scene = scene;
    scene.clearColor = new BABYLON.Color4(0.34, 0.34, 0.34, 1.0); // Light neutral Blender gray

    // Perspective / Orbit Camera
    const camera = new BABYLON.ArcRotateCamera(
      'StudioOrbitCamera',
      -Math.PI / 2.5,
      Math.PI / 3,
      10,
      new BABYLON.Vector3(0, 1.0, 0),
      scene
    );
    camera.attachControl(this.canvas, true);
    camera.wheelPrecision = 40;
    camera.minZ = 0.05;
    camera.maxZ = 2500;
    camera.lowerRadiusLimit = 0.2;
    this.camera = camera;

    // Soft Studio Lighting
    const hemi = new BABYLON.HemisphericLight('AmbientLight', new BABYLON.Vector3(0, 1, 0), scene);
    hemi.intensity = 0.85;
    hemi.groundColor = new BABYLON.Color3(0.18, 0.18, 0.2);
    hemi.diffuse = new BABYLON.Color3(0.9, 0.9, 0.92);

    const dirKey = new BABYLON.DirectionalLight('SunLight', new BABYLON.Vector3(-0.6, -1.2, -0.7), scene);
    dirKey.position = new BABYLON.Vector3(12, 24, 15);
    dirKey.intensity = 1.2;
    dirKey.diffuse = new BABYLON.Color3(0.95, 0.95, 0.95);

    const dirFill = new BABYLON.DirectionalLight('FillLight', new BABYLON.Vector3(0.6, -0.8, 0.6), scene);
    dirFill.position = new BABYLON.Vector3(-12, 16, -12);
    dirFill.intensity = 0.45;
    dirFill.diffuse = new BABYLON.Color3(0.85, 0.9, 0.95);

    // Infinite Seamless Floor Grid (1000x1000 with distance/horizon fade)
    const ground = BABYLON.MeshBuilder.CreateGround('StudioGround', { width: 1000, height: 1000 }, scene);
    ground.position.y = 0;
    ground.isPickable = false;

    if (BABYLON.GridMaterial) {
      const gridMat = new BABYLON.GridMaterial('GroundGridMat', scene);
      gridMat.majorUnitFrequency = 5;
      gridMat.minorUnitVisibility = 0.55;
      gridMat.gridRatio = 1.0;
      gridMat.mainColor = new BABYLON.Color4(0.34, 0.34, 0.34, 1.0);
      gridMat.lineColor = new BABYLON.Color4(0.12, 0.12, 0.12, 0.95);
      gridMat.opacity = 0.98;
      gridMat.fadeDistance = 150;
      ground.material = gridMat;
    } else {
      const groundMat = new BABYLON.StandardMaterial('GroundMat', scene);
      groundMat.diffuseColor = new BABYLON.Color3(0.34, 0.34, 0.34);
      groundMat.specularColor = new BABYLON.Color3(0, 0, 0);
      groundMat.wireframe = false;
      ground.material = groundMat;
    }

    // Bold, Vibrant Self-Illuminated Red X-Axis
    const axisXPath = [new BABYLON.Vector3(-500, 0.003, 0), new BABYLON.Vector3(500, 0.003, 0)];
    const axisX = BABYLON.MeshBuilder.CreateTube('StudioAxisX', {
      path: axisXPath,
      radius: 0.005,
      tessellation: 8,
      updatable: false
    }, scene);
    const matX = new BABYLON.StandardMaterial('MatAxisX', scene);
    matX.diffuseColor = new BABYLON.Color3(1.0, 0.2, 0.2);
    matX.emissiveColor = new BABYLON.Color3(0.95, 0.15, 0.15);
    matX.disableLighting = true;
    axisX.material = matX;
    axisX.isPickable = false;

    // Bold, Vibrant Self-Illuminated Green Z-Axis
    const axisZPath = [new BABYLON.Vector3(0, 0.003, -500), new BABYLON.Vector3(0, 0.003, 500)];
    const axisZ = BABYLON.MeshBuilder.CreateTube('StudioAxisZ', {
      path: axisZPath,
      radius: 0.005,
      tessellation: 8,
      updatable: false
    }, scene);
    const matZ = new BABYLON.StandardMaterial('MatAxisZ', scene);
    matZ.diffuseColor = new BABYLON.Color3(0.2, 0.95, 0.2);
    matZ.emissiveColor = new BABYLON.Color3(0.15, 0.85, 0.15);
    matZ.disableLighting = true;
    axisZ.material = matZ;
    axisZ.isPickable = false;

    // Initialize Gizmo Manager
    this._initGizmoManager();

    this._bindScenePicking(scene);
  }

  _bindScenePicking(scene) {
    this._lastClickTime = 0;
    this._lastClickMesh = null;
    let isMouseDown = false;
    let startX = 0;
    let startY = 0;
    let isBoxSelecting = false;
    let initialPick = null;
    const viewportContainer = document.getElementById('editorViewportContainer') || this.canvas.parentElement;
    const selectionBox = document.getElementById('selectionBox');

    scene.onPointerDown = (evt, pickResult) => {
      if (evt.button !== 0) return;
      isMouseDown = true;
      startX = evt.clientX;
      startY = evt.clientY;
      isBoxSelecting = false;
      initialPick = pickResult;

      if (this.isXKeyPressed && this.camera && this.canvas) {
        this.camera.detachControl();
      }
    };

    scene.onPointerMove = (evt) => {
      if (!isMouseDown) return;
      const dx = evt.clientX - startX;
      const dy = evt.clientY - startY;

      // Box selection requires X key to be held down!
      if (this.isXKeyPressed && !isBoxSelecting && Math.hypot(dx, dy) > 5) {
        isBoxSelecting = true;
      }

      if (isBoxSelecting && selectionBox && viewportContainer) {
        const rect = viewportContainer.getBoundingClientRect();
        const currentX = evt.clientX;
        const currentY = evt.clientY;

        const left = Math.min(startX, currentX) - rect.left;
        const top = Math.min(startY, currentY) - rect.top;
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);

        selectionBox.style.left = `${left}px`;
        selectionBox.style.top = `${top}px`;
        selectionBox.style.width = `${width}px`;
        selectionBox.style.height = `${height}px`;
        selectionBox.style.display = 'block';
      }
    };

    scene.onPointerUp = (evt) => {
      if (evt.button !== 0) return;

      if (isBoxSelecting && selectionBox && viewportContainer) {
        const rect = viewportContainer.getBoundingClientRect();
        const currentX = evt.clientX;
        const currentY = evt.clientY;

        const boxMinX = Math.min(startX, currentX) - rect.left;
        const boxMaxX = Math.max(startX, currentX) - rect.left;
        const boxMinY = Math.min(startY, currentY) - rect.top;
        const boxMaxY = Math.max(startY, currentY) - rect.top;

        selectionBox.style.display = 'none';

        const selected = this._performBoxSelection(boxMinX, boxMinY, boxMaxX, boxMaxY);
        if (selected.length > 0) {
          this.selectNodes(selected, 'whole', true);
        } else {
          this.selectNode(null, 'whole', false);
        }

        isMouseDown = false;
        isBoxSelecting = false;

        if (this.camera && this.canvas && !this.isXKeyPressed) {
          this.camera.attachControl(this.canvas, true);
        }
        return;
      }

      isMouseDown = false;

      if (this.camera && this.canvas && !this.isXKeyPressed) {
        this.camera.attachControl(this.canvas, true);
      }

      if (!initialPick || !initialPick.hit || !initialPick.pickedMesh || HELPER_MESHES.has(initialPick.pickedMesh.name)) {
        this.selectNode(null, 'whole', false);
        return;
      }

      const picked = initialPick.pickedMesh;
      const now = Date.now();
      const timeDiff = now - this._lastClickTime;

      if (timeDiff < 300 && this._lastClickMesh === picked) {
        this.selectNode(picked, 'submesh', true);
        this._lastClickTime = 0;
        this._lastClickMesh = null;
      } else {
        this._lastClickTime = now;
        this._lastClickMesh = picked;

        let rootNode = picked;
        while (rootNode.parent && rootNode.parent instanceof BABYLON.AbstractMesh && !HELPER_MESHES.has(rootNode.parent.name)) {
          rootNode = rootNode.parent;
        }
        this.selectNode(rootNode, 'whole', false);
      }
    };
  }

  _performBoxSelection(boxMinX, boxMinY, boxMaxX, boxMaxY) {
    if (!this.scene || !this.camera || !this.engine) return [];

    const width = this.engine.getRenderWidth();
    const height = this.engine.getRenderHeight();
    const transformMatrix = this.scene.getTransformMatrix();
    const viewport = this.camera.viewport.toGlobal(width, height);
    const canvasRect = this.canvas.getBoundingClientRect();
    const selectedMeshes = [];

    this.scene.meshes.forEach(mesh => {
      if (!mesh.isEnabled() || HELPER_MESHES.has(mesh.name) || mesh.name === 'StudioGround') return;

      let rootNode = mesh;
      while (rootNode.parent && rootNode.parent instanceof BABYLON.AbstractMesh && !HELPER_MESHES.has(rootNode.parent.name)) {
        rootNode = rootNode.parent;
      }

      const bInfo = mesh.getBoundingInfo();
      if (!bInfo) return;

      const vectorsWorld = bInfo.boundingBox.vectorsWorld;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

      for (let i = 0; i < vectorsWorld.length; i++) {
        const proj = BABYLON.Vector3.Project(vectorsWorld[i], BABYLON.Matrix.Identity(), transformMatrix, viewport);
        const screenX = proj.x * (canvasRect.width / width);
        const screenY = proj.y * (canvasRect.height / height);

        if (screenX < minX) minX = screenX;
        if (screenX > maxX) maxX = screenX;
        if (screenY < minY) minY = screenY;
        if (screenY > maxY) maxY = screenY;
      }

      const overlaps = !(maxX < boxMinX || minX > boxMaxX || maxY < boxMinY || minY > boxMaxY);
      if (overlaps && !selectedMeshes.includes(rootNode)) {
        selectedMeshes.push(rootNode);
      }
    });

    return selectedMeshes;
  }

  _initGizmoManager() {
    if (!BABYLON.GizmoManager) {
      console.warn('[WebGPUEditor] GizmoManager not available, skipping gizmo initialization');
      return;
    }
    try {
      this.gizmoManager = new BABYLON.GizmoManager(this.scene);
      this.gizmoManager.usePointerToAttachGizmos = false;
      this.gizmoManager.clearGizmoOnEmptyPointerEvent = false;

      this.gizmoManager.positionGizmoEnabled = true;
      this.gizmoManager.rotationGizmoEnabled = false;
      this.gizmoManager.scaleGizmoEnabled = false;
      this.gizmoManager.boundingBoxGizmoEnabled = false;

      // Auto-save on gizmo drag end
      if (this.gizmoManager.onDragEndObservable) {
        this.gizmoManager.onDragEndObservable.add(() => {
          this._scheduleSceneSave({ recordHistory: true });
        });
      }

      this._updateGizmoCoordinates();
      this._updateGizmoSnapping();
      console.log('[WebGPUEditor] GizmoManager initialized successfully');
    } catch (error) {
      console.error('[WebGPUEditor] Could not initialize GizmoManager:', error);
    }
  }

  _setSaveStatus(status) {
    // Removed - save status indicator no longer needed
  }

  _scheduleSceneSave({ recordHistory = true } = {}) {
    if (!this.scene || this._restoringScene) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      if (recordHistory) this._commitSceneHistory();
      this._persistSceneState();
    }, 400);
  }

  _captureSceneSnapshot() {
    return JSON.stringify(BABYLON.SceneSerializer.Serialize(this.scene));
  }

  _commitSceneHistory() {
    if (!this.scene || this._historyInProgress) return;
    const currentSnapshot = this._captureSceneSnapshot();
    if (this._historyBaseline && currentSnapshot !== this._historyBaseline) {
      this.undoStack.push({
        scene: this._historyBaseline,
        selectedName: this.selectedNode?.name || null,
      });
      if (this.undoStack.length > 50) this.undoStack.shift();
      this.redoStack = [];
    }
    this._historyBaseline = currentSnapshot;
  }

  /** Загружает сцену, сериализованную через SceneSerializer, и возвращает НОВУЮ Scene. */
  async _loadSerializedScene(serialized) {
    const json = typeof serialized === 'string' ? serialized : JSON.stringify(serialized);
    return BABYLON.SceneLoader.LoadAsync('', 'data:' + json, this.engine);
  }

  async _restoreSceneSnapshot(snapshot, selectedName = null) {
    const restoredScene = await this._loadSerializedScene(snapshot);
    const previousScene = this.scene;
    this.gizmoManager?.dispose();
    this.scene = restoredScene;
    this.camera = restoredScene.activeCamera || restoredScene.activeCameras?.[0] || restoredScene.cameras[0] || null;
    this.selectedNode = null;
    previousScene?.dispose();
    this.camera?.attachControl(this.canvas, true);
    this._initGizmoManager();
    this._bindScenePicking(restoredScene);
    this._refreshSceneGraph();
    this.selectNode(selectedName ? restoredScene.getNodeByName(selectedName) : null);
  }

  async undo() {
    if (this._historyInProgress || !this.undoStack.length) return;
    clearTimeout(this._saveTimer);
    this._commitSceneHistory();
    const entry = this.undoStack.pop();
    if (!entry) return;

    this._historyInProgress = true;
    try {
      this.redoStack.push({ scene: this._captureSceneSnapshot(), selectedName: entry.selectedName });
      await this._restoreSceneSnapshot(entry.scene, entry.selectedName);
      this.log('Undo', 'info');
    } catch (error) {
      this.undoStack.push(entry);
      this.redoStack.pop();
      this.log(`Undo failed: ${error.message}`, 'error');
    } finally {
      this._historyInProgress = false;
      this._historyBaseline = this._captureSceneSnapshot();
      this._scheduleSceneSave({ recordHistory: false });
    }
  }

  async redo() {
    if (this._historyInProgress || !this.redoStack.length) return;
    clearTimeout(this._saveTimer);
    this._commitSceneHistory();
    const entry = this.redoStack.pop();
    if (!entry) return;

    this._historyInProgress = true;
    try {
      this.undoStack.push({ scene: this._captureSceneSnapshot(), selectedName: entry.selectedName });
      await this._restoreSceneSnapshot(entry.scene, entry.selectedName);
      this.log('Redo', 'info');
    } catch (error) {
      this.redoStack.push(entry);
      this.undoStack.pop();
      this.log(`Redo failed: ${error.message}`, 'error');
    } finally {
      this._historyInProgress = false;
      this._historyBaseline = this._captureSceneSnapshot();
      this._scheduleSceneSave({ recordHistory: false });
    }
  }

  async _persistSceneState() {
    if (!this.scene || this._restoringScene) return;
    if (this._savingScene) {
      this._savePending = true;
      return;
    }

    this._savingScene = true;
    try {
      do {
        this._savePending = false;
        const scene = this.scene;
        const serialized = BABYLON.SceneSerializer.Serialize(scene);
        const serializedString = JSON.stringify(serialized);
        
        console.log('[WebGPUEditor] Saving scene, length:', serializedString.length);
        
        // Основное хранилище — IndexedDB (сцена может быть десятки МБ,
        // localStorage не подходит из-за лимита ~5 МБ)
        await saveEditorSceneState(serializedString);
        console.log('[WebGPUEditor] Saved to IndexedDB successfully');
        
        if (scene !== this.scene) this._savePending = true;
      } while (this._savePending);
    } catch (error) {
      console.error('[WebGPUEditor] Could not save scene:', error);
    } finally {
      this._savingScene = false;
    }
  }

  async _restoreOrCreateDefault() {
    // Try to restore the last saved scene from IndexedDB
    try {
      const saved = await getSavedEditorSceneState().catch(() => null);
      if (saved && saved.scene) {
        console.log('[WebGPUEditor] Restoring saved scene from IndexedDB...');
        const json = typeof saved.scene === 'string' ? saved.scene : JSON.stringify(saved.scene);
        const restoredScene = await this._loadSerializedScene(json);
        const previousScene = this.scene;
        this.gizmoManager?.dispose();
        this.scene = restoredScene;
        this.camera = restoredScene.activeCamera
          || restoredScene.activeCameras?.[0]
          || restoredScene.cameras[0]
          || null;
        previousScene?.dispose();
        this.camera?.attachControl(this.canvas, true);
        this._initGizmoManager();
        this._bindScenePicking(restoredScene);
        this.selectedNode = null;
        this._refreshSceneGraph();
        this.log('Session restored successfully.', 'info');
        return;
      }
    } catch (err) {
      console.warn('[WebGPUEditor] Could not restore scene, starting fresh:', err);
    }

    // Fallback: clean empty scene
    console.log('[WebGPUEditor] Starting with a clean empty scene.');
    this.selectedNode = null;
    this._refreshSceneGraph();
    this.log('Clean empty scene ready.', 'info');
  }

  newScene() {
    if (!confirm('Create a new scene? Unsaved changes will be cleared.')) return;
    this.resetWorkspace();
  }

  resetScene() {
    this.resetWorkspace();
  }

  resetWorkspace() {
    this.undoStack = [];
    this.redoStack = [];
    this._historyBaseline = null;
    clearSavedEditorModelFile().catch(() => {});
    clearSavedEditorSceneState().catch(() => {});
    localStorage.removeItem('corelink-scene-backup');
    this._initScene().then(() => {
      this.selectedNode = null;
      this._refreshSceneGraph();
      this.log('Workspace reset — Clean empty scene.', 'info');
    });
  }

  /**
   * Spawns standard 3D primitives and lights
   */
  createPrimitive(type) {
    if (!this.scene) return;
    let node = null;
    const pbrMat = new BABYLON.PBRMaterial(`Mat_${type}_${Date.now()}`, this.scene);
    pbrMat.albedoColor = new BABYLON.Color3(0.65, 0.65, 0.65);
    pbrMat.roughness = 0.5;
    pbrMat.metallic = 0.0;

    switch (type) {
      case 'box':
        node = BABYLON.MeshBuilder.CreateBox(`Cube_${this._getMeshCount()}`, { size: 2.0 }, this.scene);
        node.position.y = 1.0;
        node.material = pbrMat;
        break;
      case 'sphere':
        node = BABYLON.MeshBuilder.CreateSphere(`Sphere_${this._getMeshCount()}`, { diameter: 2.0, segments: 32 }, this.scene);
        node.position.y = 1.0;
        node.material = pbrMat;
        break;
      case 'cylinder':
        node = BABYLON.MeshBuilder.CreateCylinder(`Cylinder_${this._getMeshCount()}`, { height: 2.0, diameter: 1.5, tessellation: 32 }, this.scene);
        node.position.y = 1.0;
        node.material = pbrMat;
        break;
      case 'capsule':
        node = BABYLON.MeshBuilder.CreateCapsule(`Capsule_${this._getMeshCount()}`, { radius: 0.6, height: 2.4 }, this.scene);
        node.position.y = 1.2;
        node.material = pbrMat;
        break;
      case 'torus':
        node = BABYLON.MeshBuilder.CreateTorus(`Torus_${this._getMeshCount()}`, { diameter: 2.0, thickness: 0.5, tessellation: 32 }, this.scene);
        node.position.y = 1.0;
        node.material = pbrMat;
        break;
      case 'plane':
        node = BABYLON.MeshBuilder.CreatePlane(`Plane_${this._getMeshCount()}`, { size: 4.0 }, this.scene);
        node.rotation.x = Math.PI / 2;
        node.position.y = 0.005;
        node.material = pbrMat;
        break;
      case 'pointLight':
        node = new BABYLON.PointLight(`PointLight_${Date.now() % 1000}`, new BABYLON.Vector3(0, 3, 0), this.scene);
        node.intensity = 1.0;
        break;
      case 'dirLight':
        node = new BABYLON.DirectionalLight(`SunLight_${Date.now() % 1000}`, new BABYLON.Vector3(-1, -2, -1), this.scene);
        node.position = new BABYLON.Vector3(5, 10, 5);
        node.intensity = 1.2;
        break;
      case 'spotLight':
        node = new BABYLON.SpotLight(`SpotLight_${Date.now() % 1000}`, new BABYLON.Vector3(0, 4, 0), new BABYLON.Vector3(0, -1, 0), Math.PI / 3, 2, this.scene);
        node.intensity = 1.5;
        break;
      default:
        return;
    }

    this._refreshSceneGraph();
    this.selectNode(node, 'whole', false);
    this._scheduleSceneSave();
    this._saveCurrentModelAsDefault();
    this.log(`Created ${node.name}`, 'info');
  }

  _getMeshCount() {
    return this.scene.meshes.filter(m => !HELPER_MESHES.has(m.name)).length + 1;
  }

  async _saveCurrentModelAsDefault() {
    try {
      const serialized = BABYLON.SceneSerializer.Serialize(this.scene);
      await saveEditorSceneState(JSON.stringify(serialized));
    } catch (err) {
      console.warn('[WebGPUEditor] Could not save current model as default:', err);
    }
  }

  /** Import a glTF model or CoreLink project bundle into the editor. */
  async importEditorFile(file) {
    if (!file) return;
    this.log(`Importing ${file.name}...`, 'info');
    const ext = file.name.split('.').pop().toLowerCase();

    try {
      this._setLoader(`Loading ${file.name}...`);
      if (ext === 'cl3d') {
        const bundle = await projectBundle.importBundle(file);
        if (bundle.modelFile) {
          await this._loadModelFromBuffer(await bundle.modelFile.arrayBuffer(), bundle.modelFile.name);
        }
      } else if (['glb', 'gltf'].includes(ext)) {
        const buffer = await file.arrayBuffer();
        await this._loadModelFromBuffer(buffer, file.name);
      } else {
        throw new Error('Supported formats: .glb, .gltf, .cl3d');
      }
      this._refreshSceneGraph();
      this._hideLoader();
      this._scheduleSceneSave();
      this._saveCurrentModelAsDefault();
      this.log(`Successfully loaded ${file.name}`, 'info');
    } catch (err) {
      console.error('[WebGPUEditor] Import error:', err);
      this.log(`Failed to import ${file.name}: ${err.message}`, 'error');
      this._hideLoader();
    }
  }

  async _loadModelFromBuffer(buffer, filename) {
    if (!this.scene) return;
    // Remove previous user meshes
    this.scene.meshes.slice().forEach(m => {
      if (!HELPER_MESHES.has(m.name)) m.dispose();
    });

    const blob = new Blob([buffer], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    try {
      const result = await BABYLON.SceneLoader.ImportMeshAsync('', '', url, this.scene, null, '.glb');
      if (result.meshes.length > 0) {
        const root = result.meshes[0];
        root.name = filename.replace(/\.[^/.]+$/, '');

        // Pre-compute matrices, refresh bounding info & pre-warm GPU pipelines
        // to eliminate initial micro-stutter / lag on first interaction
        result.meshes.forEach(m => {
          if (m.computeWorldMatrix) m.computeWorldMatrix(true);
          if (m.refreshBoundingInfo) m.refreshBoundingInfo(true);
        });

        if (this.scene.whenReadyAsync) {
          await this.scene.whenReadyAsync();
        }

        // Render warm-up frames
        if (this.scene.render) {
          this.scene.render();
          this.scene.render();
        }

        this.frameSelected(root);
        this.selectNode(root, 'whole', false);
        if (this.modelInfo) this.modelInfo.textContent = `Scene: ${filename}`;
        saveEditorModelFile({ name: filename, buffer, size: buffer.byteLength }).catch(() => {});
        this._saveCurrentModelAsDefault();
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Export active scene (.glb, .gltf, .cl3d)
   */
  async exportActiveScene(format = 'glb') {
    if (!this.scene || !BABYLON.GLTF2Export) return;
    this.log(`Exporting scene as .${format}...`, 'info');
    try {
      this._setLoader(`Exporting .${format}...`);
      if (format === 'cl3d') {
        const glbBlob = await this._exportSceneToGlbBlob();
        const modelFile = new File([glbBlob], 'scene.glb', { type: 'model/gltf-binary' });
        const bundleBlob = await projectBundle.createBundle({ modelFile, metadata: { name: 'CoreLink Project', timestamp: Date.now() } });
        this._downloadBlob(bundleBlob, 'scene.cl3d');
      } else if (format === 'gltf') {
        await BABYLON.GLTF2Export.GLTFAsync(this.scene, 'scene', {
          shouldExportNode: (node) => !HELPER_MESHES.has(node.name)
        }).then((gltf) => gltf.downloadFiles());
      } else {
        await BABYLON.GLTF2Export.GLBAsync(this.scene, 'scene', {
          shouldExportNode: (node) => !HELPER_MESHES.has(node.name)
        }).then((glb) => glb.downloadFiles());
      }
      this._hideLoader();
      this.log(`Scene exported successfully as .${format}`, 'info');
    } catch (err) {
      console.error('[WebGPUEditor] Export error:', err);
      this.log(`Export failed: ${err.message}`, 'error');
      this._hideLoader();
    }
  }

  _exportSceneToGlbBlob() {
    return new Promise((resolve, reject) => {
      BABYLON.GLTF2Export.GLBAsync(this.scene, 'scene', {
        shouldExportNode: (node) => !HELPER_MESHES.has(node.name)
      }).then(glb => {
        const file = glb.glTFFiles['scene.glb'];
        if (file) resolve(file);
        else reject(new Error('GLB generation failed'));
      }).catch(reject);
    });
  }

  _downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /**
   * Node selection & synchronization
   */
  selectNodes(nodes, mode = 'whole', applyHighlight = false) {
    this.selectedNodes = Array.isArray(nodes) ? nodes : (nodes ? [nodes] : []);
    this.selectedNode = this.selectedNodes[0] || null;
    this.selectionMode = mode;

    if (this.gizmoManager) {
      this.gizmoManager.attachToMesh(this.selectedNode instanceof BABYLON.AbstractMesh ? this.selectedNode : null);
    }

    if (applyHighlight && this.selectedNodes.length > 0) {
      this._applyHighlightMulti(this.selectedNodes, mode);
    } else {
      this._clearHighlight();
    }

    this._updateOutlinerSelection();
    this._syncInspector();
  }

  selectNode(node, mode = 'whole', applyHighlight = false) {
    this.selectNodes(node ? [node] : [], mode, applyHighlight);
  }

  _clearHighlight() {
    if (this.highlightLayer) {
      try {
        this.highlightLayer.removeAllMeshes();
      } catch (e) {}
    }
  }

  _applyHighlight(node, mode = 'whole') {
    this._applyHighlightMulti(node ? [node] : [], mode);
  }

  _applyHighlightMulti(nodes, mode = 'whole') {
    if (!this.scene) return;

    if (!this.highlightLayer && BABYLON.HighlightLayer) {
      try {
        this.highlightLayer = new BABYLON.HighlightLayer("selectionHighlight", this.scene, { 
          isStroke: true,
          mainTextureRatio: 1
        });
        this.highlightLayer.innerGlow = false;
        this.highlightLayer.outerGlow = true;
        this.highlightLayer.blurHorizontalSize = 0.5;
        this.highlightLayer.blurVerticalSize = 0.5;
      } catch (e) {
        console.warn('[WebGPUEditor] Could not initialize HighlightLayer:', e);
      }
    }

    if (!this.highlightLayer) return;

    try {
      this.highlightLayer.removeAllMeshes();
      if (!nodes || nodes.length === 0) return;

      const colorHex = mode === 'submesh' ? "#FFA500" : "#00BFFF";
      const highlightColor = BABYLON.Color3.FromHexString(colorHex);

      const meshesToHighlight = new Set();
      nodes.forEach(node => {
        if (!node || !(node instanceof BABYLON.AbstractMesh)) return;
        if (node.isDisposed && node.isDisposed()) return;
        if (mode === 'submesh') {
          if (node instanceof BABYLON.Mesh && !HELPER_MESHES.has(node.name)) meshesToHighlight.add(node);
        } else {
          if (node instanceof BABYLON.Mesh && !HELPER_MESHES.has(node.name)) meshesToHighlight.add(node);
          if (node.getChildMeshes) {
            node.getChildMeshes(false).forEach(child => {
              if (child instanceof BABYLON.Mesh && (!child.isDisposed || !child.isDisposed()) && !HELPER_MESHES.has(child.name)) {
                meshesToHighlight.add(child);
              }
            });
          }
        }
      });

      meshesToHighlight.forEach(m => {
        try {
          if (m && (!m.isDisposed || !m.isDisposed())) {
            this.highlightLayer.addMesh(m, highlightColor);
          }
        } catch (e) {}
      });
    } catch (err) {
      console.warn('[WebGPUEditor] Multi-Highlight error:', err);
    }
  }


  joinSelected() {
    let meshesToMerge = [];

    if (this.selectedNodes && this.selectedNodes.length > 1) {
      this.selectedNodes.forEach(node => {
        if (node instanceof BABYLON.Mesh && !HELPER_MESHES.has(node.name)) {
          meshesToMerge.push(node);
        }
        if (node.getChildMeshes) {
          node.getChildMeshes(false).forEach(m => {
            if (m instanceof BABYLON.Mesh && !HELPER_MESHES.has(m.name)) meshesToMerge.push(m);
          });
        }
      });
    } else if (this.selectedNode) {
      if (this.selectedNode instanceof BABYLON.Mesh) meshesToMerge.push(this.selectedNode);
      if (this.selectedNode.getChildMeshes) {
        this.selectedNode.getChildMeshes(false).forEach(m => {
          if (m instanceof BABYLON.Mesh && !HELPER_MESHES.has(m.name)) meshesToMerge.push(m);
        });
      }
    }

    meshesToMerge = Array.from(new Set(meshesToMerge));

    if (meshesToMerge.length <= 1) {
      this.log('Select multiple objects or a model with sub-meshes to Join', 'warn');
      return;
    }

    try {
      const primaryName = meshesToMerge[0].name;
      const newName = `${primaryName}_Joined`;

      // Merge meshes with material preservation (mergeMaterials: true)
      const merged = BABYLON.Mesh.MergeMeshes(meshesToMerge, true, true, undefined, false, true);
      if (merged) {
        merged.name = newName;

        // Compute geometric center of merged geometry
        merged.computeWorldMatrix(true);
        const bInfo = merged.getBoundingInfo();
        const centerWorld = bInfo.boundingBox.centerWorld.clone();

        // Reposition mesh position to geometric center and offset vertex positions
        const positions = merged.getVerticesData(BABYLON.VertexBuffer.PositionKind);
        if (positions && (centerWorld.x !== 0 || centerWorld.y !== 0 || centerWorld.z !== 0)) {
          for (let i = 0; i < positions.length; i += 3) {
            positions[i] -= centerWorld.x;
            positions[i + 1] -= centerWorld.y;
            positions[i + 2] -= centerWorld.z;
          }
          merged.setVerticesData(BABYLON.VertexBuffer.PositionKind, positions, true);
          merged.position = centerWorld;
          merged.refreshBoundingInfo();
        }

        // Delete original meshes from scene
        meshesToMerge.forEach(m => {
          if (m !== merged) {
            m.dispose();
          }
        });

        this._refreshSceneGraph();
        this.selectNodes([merged], 'whole', true);

        // Force gizmo to re-attach directly at geometric center of merged mesh
        if (this.gizmoManager) {
          this.gizmoManager.attachToMesh(null);
          this.gizmoManager.attachToMesh(merged);
        }

        this._scheduleSceneSave();
        this.log(`Joined ${meshesToMerge.length} meshes into ${newName}`, 'info');
      }
    } catch (e) {
      console.error('[WebGPUEditor] Join error:', e);
      this.log(`Failed to join meshes: ${e.message}`, 'error');
    }
  }

  /**
   * Apply Flat Shading to the selected mesh(es).
   * Manually duplicates vertices so each face has unique vertices with flat normals.
   * This creates the faceted/ribbed appearance like in Blender.
   * Original smooth geometry is saved in metadata for restoration.
   * Uses mesh.metadata for persistence during scene serialization.
   */
  setFlatShading(target = this.selectedNode) {
    console.log('[WebGPUEditor] setFlatShading called, target:', target?.name);

    if (!target) {
      this.log('Select a mesh to apply Flat Shading', 'warn');
      return;
    }
    const meshes = this._collectShadingMeshes(target);
    console.log('[WebGPUEditor] Meshes to process:', meshes.length);

    let applied = 0;
    meshes.forEach(m => {
      console.log('[WebGPUEditor] Processing mesh:', m.name);

      // Check metadata for existing flat shading state
      if (!m.metadata) m.metadata = {};
      if (m.metadata.isFlatShaded) {
        console.log('[WebGPUEditor] Mesh already flat shaded, skipping:', m.name);
        return;
      }

      // Save original smooth mesh data for restoration
      if (!m.metadata.smoothNormals) {
        const existing = m.getVerticesData(BABYLON.VertexBuffer.NormalKind);
        m.metadata.smoothNormals = existing ? Array.from(existing) : null;
      }
      // Save original vertex positions and indices
      if (!m.metadata.smoothPositions) {
        const positions = m.getVerticesData(BABYLON.VertexBuffer.PositionKind);
        m.metadata.smoothPositions = positions ? Array.from(positions) : null;
      }
      if (!m.metadata.smoothIndices) {
        const indices = m.getIndices();
        m.metadata.smoothIndices = indices ? Array.from(indices) : null;
      }

      try {
        console.log('[WebGPUEditor] Converting mesh to flat shading:', m.name);

        // Manual flat shading: duplicate vertices so each face has unique vertices
        const positions = m.getVerticesData(BABYLON.VertexBuffer.PositionKind);
        const indices = m.getIndices();
        const normals = m.getVerticesData(BABYLON.VertexBuffer.NormalKind);
        const uvs = m.getVerticesData(BABYLON.VertexBuffer.UVKind);

        if (!positions || !indices) {
          console.warn('[WebGPUEditor] Mesh has no geometry data:', m.name);
          return;
        }

        // Create new arrays with duplicated vertices (one vertex per face vertex)
        const newPositions = [];
        const newNormals = [];
        const newUVs = uvs ? [] : null;
        const newIndices = [];

        for (let i = 0; i < indices.length; i++) {
          const vertexIndex = indices[i];
          const vi = vertexIndex * 3;

          // Copy position
          newPositions.push(positions[vi], positions[vi + 1], positions[vi + 2]);

          // Copy normal (will be overwritten with flat normals)
          newNormals.push(normals[vi], normals[vi + 1], normals[vi + 2]);

          // Copy UV if present
          if (uvs) {
            const uvi = vertexIndex * 2;
            newUVs.push(uvs[uvi], uvs[uvi + 1]);
          }

          // New index is just the sequential position
          newIndices.push(i);
        }

        // Now compute flat normals for each triangle
        for (let t = 0; t < newIndices.length / 3; t++) {
          const i0 = newIndices[t * 3] * 3;
          const i1 = newIndices[t * 3 + 1] * 3;
          const i2 = newIndices[t * 3 + 2] * 3;

          const ax = newPositions[i1] - newPositions[i0];
          const ay = newPositions[i1 + 1] - newPositions[i0 + 1];
          const az = newPositions[i1 + 2] - newPositions[i0 + 2];
          const bx = newPositions[i2] - newPositions[i0];
          const by = newPositions[i2 + 1] - newPositions[i0 + 1];
          const bz = newPositions[i2 + 2] - newPositions[i0 + 2];

          // Cross product
          let nx = ay * bz - az * by;
          let ny = az * bx - ax * bz;
          let nz = ax * by - ay * bx;

          // Normalize
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= len; ny /= len; nz /= len;

          // Assign same normal to all 3 vertices of this triangle
          newNormals[i0] = nx; newNormals[i0 + 1] = ny; newNormals[i0 + 2] = nz;
          newNormals[i1] = nx; newNormals[i1 + 1] = ny; newNormals[i1 + 2] = nz;
          newNormals[i2] = nx; newNormals[i2 + 1] = ny; newNormals[i2 + 2] = nz;
        }

        // Update the mesh with new data
        m.setVerticesData(BABYLON.VertexBuffer.PositionKind, new Float32Array(newPositions), true);
        m.setIndices(new Uint32Array(newIndices));
        m.setVerticesData(BABYLON.VertexBuffer.NormalKind, new Float32Array(newNormals), true);
        if (newUVs) {
          m.setVerticesData(BABYLON.VertexBuffer.UVKind, new Float32Array(newUVs), true);
        }

        m.metadata.isFlatShaded = true;

        console.log('[WebGPUEditor] Flat shading applied successfully to:', m.name);
        applied++;

      } catch (e) {
        console.error('[WebGPUEditor] setFlatShading failed for mesh:', m.name, e);
      }
    });

    if (applied > 0) {
      this._refreshSceneGraph();
      // Re-attach gizmo to the mesh
      if (this.selectedNode && this.gizmoManager) {
        this.gizmoManager.attachToMesh(this.selectedNode);
      }
      this.log(`Flat Shading applied to ${target.name}`, 'info');
    } else {
      this.log(`${target.name} is already in Flat Shading mode`, 'info');
    }
  }

  /**
   * Collect meshes eligible for shading operations:
   * target itself + all child meshes, excluding helper meshes with no geometry.
   */
  _collectShadingMeshes(target) {
    const meshes = [];
    if (target instanceof BABYLON.Mesh && !HELPER_MESHES.has(target.name)) {
      meshes.push(target);
    }
    if (target.getChildMeshes) {
      target.getChildMeshes(false).forEach(m => {
        if (m instanceof BABYLON.Mesh && !HELPER_MESHES.has(m.name)) meshes.push(m);
      });
    }
    return meshes;
  }

  /**
   * Restore Smooth Shading for the selected mesh(es).
   * Restores the original smooth vertex data from metadata.
   * This is necessary because flat shading duplicates vertices.
   * Uses mesh.metadata for persistence during scene serialization.
   */
  setSmoothShading(target = this.selectedNode) {
    console.log('[WebGPUEditor] setSmoothShading called, target:', target?.name);

    if (!target) {
      this.log('Select a mesh to apply Smooth Shading', 'warn');
      return;
    }
    const meshes = this._collectShadingMeshes(target);
    console.log('[WebGPUEditor] Meshes to process:', meshes.length);

    let applied = 0;
    meshes.forEach(m => {
      console.log('[WebGPUEditor] Processing mesh:', m.name);

      if (!m.metadata) m.metadata = {};
      if (!m.metadata.isFlatShaded) {
        console.log('[WebGPUEditor] Mesh not flat shaded, skipping:', m.name);
        return;
      }

      try {
        if (m.metadata.smoothPositions && m.metadata.smoothIndices) {
          console.log('[WebGPUEditor] Restoring smooth geometry for:', m.name);

          // Restore original smooth vertex data
          m.setVerticesData(BABYLON.VertexBuffer.PositionKind, new Float32Array(m.metadata.smoothPositions), true);
          m.setIndices(new Uint32Array(m.metadata.smoothIndices));

          // Restore smooth normals
          if (m.metadata.smoothNormals) {
            m.setVerticesData(BABYLON.VertexBuffer.NormalKind, new Float32Array(m.metadata.smoothNormals), true);
          } else {
            // Recompute smooth normals
            const normals = [];
            BABYLON.VertexData.ComputeNormals(m.metadata.smoothPositions, m.metadata.smoothIndices, normals);
            m.setVerticesData(BABYLON.VertexBuffer.NormalKind, normals, true);
          }

          m.metadata.isFlatShaded = false;

          console.log('[WebGPUEditor] Smooth shading restored for:', m.name);
          applied++;
        } else {
          console.warn('[WebGPUEditor] No saved smooth geometry data for mesh:', m.name);
        }
      } catch (e) {
        console.error('[WebGPUEditor] setSmoothShading failed for mesh:', m.name, e);
      }
    });

    if (applied > 0) {
      this._refreshSceneGraph();
      // Re-attach gizmo to the mesh
      if (this.selectedNode && this.gizmoManager) {
        this.gizmoManager.attachToMesh(this.selectedNode);
      }
      this.log(`Smooth Shading applied to ${target.name}`, 'info');
    } else {
      this.log(`${target.name} is already in Smooth Shading mode`, 'info');
    }
  }


  flipNormals(target = this.selectedNode) {
    if (!target) {
      this.log('Select a mesh to flip normals', 'warn');
      return;
    }
    const meshes = [];
    if (target instanceof BABYLON.Mesh) meshes.push(target);
    if (target.getChildMeshes) {
      target.getChildMeshes(false).forEach(m => { if (m instanceof BABYLON.Mesh) meshes.push(m); });
    }
    meshes.forEach(m => {
      const normals = m.getVerticesData(BABYLON.VertexBuffer.NormalKind);
      if (normals) {
        for (let i = 0; i < normals.length; i++) {
          normals[i] = -normals[i];
        }
        m.setVerticesData(BABYLON.VertexBuffer.NormalKind, normals, true);
      }
    });
    this.log(`Flipped normals for ${target.name}`, 'info');
  }

  toggleWireframeMesh(target = this.selectedNode) {
    if (!target) {
      this.log('Select a mesh to toggle wireframe', 'warn');
      return;
    }
    const meshes = [];
    if (target instanceof BABYLON.Mesh) meshes.push(target);
    if (target.getChildMeshes) {
      target.getChildMeshes(false).forEach(m => { if (m instanceof BABYLON.Mesh) meshes.push(m); });
    }
    meshes.forEach(m => {
      if (m.material) {
        m.material.wireframe = !m.material.wireframe;
      }
    });
    this.log(`Toggled wireframe display for ${target.name}`, 'info');
  }

  resetToDefaultGrayMaterial(target = this.selectedNode) {
    if (!target) {
      this.log('Select a mesh or model to reset material', 'warn');
      return;
    }
    try {
      const defaultMat = new BABYLON.PBRMaterial(`Mat_DefaultGray_${Date.now()}`, this.scene);
      defaultMat.albedoColor = new BABYLON.Color3(0.65, 0.65, 0.65);
      defaultMat.roughness = 0.5;
      defaultMat.metallic = 0.0;

      const applyToMesh = (m) => {
        if (m instanceof BABYLON.Mesh && !HELPER_MESHES.has(m.name)) {
          m.material = defaultMat;
        }
      };

      if (target instanceof BABYLON.Mesh) applyToMesh(target);
      if (target.getChildMeshes) {
        target.getChildMeshes(false).forEach(applyToMesh);
      }

      this._syncInspector();
      this._scheduleSceneSave();
      this.log(`Reset material to default gray for ${target.name}`, 'info');
    } catch (e) {
      console.error('[WebGPUEditor] resetToDefaultGrayMaterial error:', e);
      this.log(`Failed to reset material: ${e.message}`, 'error');
    }
  }

  deleteSelectedNode() {
    if (!this.selectedNode || HELPER_MESHES.has(this.selectedNode.name)) return;
    const name = this.selectedNode.name;
    clearTimeout(this._saveTimer);
    this._commitSceneHistory();
    this.undoStack.push({ scene: this._historyBaseline || this._captureSceneSnapshot(), selectedName: name });
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    this.selectedNode.dispose();
    this.selectNode(null);
    this._refreshSceneGraph();
    this._historyBaseline = this._captureSceneSnapshot();
    this._scheduleSceneSave({ recordHistory: false });
    this.log(`Deleted ${name}`, 'info');
  }

  duplicateSelected() {
    if (!this.selectedNode || !(this.selectedNode instanceof BABYLON.Mesh)) return;
    const clone = this.selectedNode.clone(`${this.selectedNode.name}_Copy`);
    clone.position.x += 1;
    clone.position.z += 1;
    this._refreshSceneGraph();
    this.selectNode(clone);
    this._scheduleSceneSave();
    this.log(`Duplicated ${clone.name}`, 'info');
  }

  frameSelected(targetNode = this.selectedNode) {
    const node = targetNode || this.scene.meshes.find(m => !HELPER_MESHES.has(m.name));
    if (!node || !this.camera) return;

    if (node instanceof BABYLON.AbstractMesh && node.getBoundingInfo) {
      const bInfo = node.getBoundingInfo();
      const center = bInfo.boundingBox.centerWorld;
      const radius = Math.max(bInfo.boundingSphere.radiusWorld * 2.5, 3);
      this.camera.setTarget(center);
      this.camera.radius = radius;
    }
  }

  setGizmoMode(mode) {
    this.currentGizmo = mode;
    document.querySelectorAll('[data-gizmo]').forEach(b => {
      b.classList.toggle('active', b.dataset.gizmo === mode);
    });

    if (!this.gizmoManager) return;
    this.gizmoManager.positionGizmoEnabled = (mode === 'position');
    this.gizmoManager.rotationGizmoEnabled = (mode === 'rotation');
    this.gizmoManager.scaleGizmoEnabled = (mode === 'scaling');
    this.gizmoManager.boundingBoxGizmoEnabled = (mode === 'bounds');
    this._updateGizmoCoordinates();
  }

  _updateGizmoCoordinates() {
    if (!this.gizmoManager) return;
    const coords = BABYLON.GizmoCoordinatesMode.World;
    Object.values(this.gizmoManager.gizmos).forEach((gizmo) => {
      if (gizmo) gizmo.coordinatesMode = coords;
    });
  }

  _updateGizmoSnapping() {
    if (!this.gizmoManager) return;
    const snapPos = this.snapEnabled ? 0.5 : 0;
    const snapRot = this.snapEnabled ? Math.PI / 12 : 0;
    const snapScale = this.snapEnabled ? 0.25 : 0;

    if (this.gizmoManager.gizmos.positionGizmo) this.gizmoManager.gizmos.positionGizmo.snapDistance = snapPos;
    if (this.gizmoManager.gizmos.rotationGizmo) this.gizmoManager.gizmos.rotationGizmo.snapDistance = snapRot;
    if (this.gizmoManager.gizmos.scaleGizmo) this.gizmoManager.gizmos.scaleGizmo.snapDistance = snapScale;
  }

  switchCamera(type) {
    if (!this.camera || !this.scene) return;
    const select = document.getElementById('editorCameraSelect');
    if (select) select.value = type;

    switch (type) {
      case 'top':
        this.camera.alpha = -Math.PI / 2;
        this.camera.beta = 0.001;
        break;
      case 'front':
        this.camera.alpha = -Math.PI / 2;
        this.camera.beta = Math.PI / 2;
        break;
      case 'free':
        break;
      case 'orbit':
      default:
        this.camera.alpha = -Math.PI / 2.5;
        this.camera.beta = Math.PI / 3;
        break;
    }
  }

  setShadingMode(mode) {
    if (!this.scene) return;
    this.scene.meshes.forEach(m => {
      if (HELPER_MESHES.has(m.name)) return;
      if (m.material) {
        if (mode === 'wireframe') {
          m.material.wireframe = true;
        } else {
          m.material.wireframe = false;
        }
      }
    });
  }

  toggleWireframeMode() {
    const isWire = this.scene?.meshes.some(m => !HELPER_MESHES.has(m.name) && m.material?.wireframe);
    this.setShadingMode(isWire ? 'pbr' : 'wireframe');
  }

  toggleNativeInspector() {
    if (!this.scene) return;
    if (this.scene.debugLayer.isVisible()) {
      this.scene.debugLayer.hide();
    } else {
      this.scene.debugLayer.show({ embedMode: true }).catch(() => {
        this.log('Native Babylon Inspector loaded.', 'info');
      });
    }
  }

  /**
   * Outliner & Scene Hierarchy Graph
   */
  _refreshSceneGraph() {
    const container = document.getElementById('editorSceneTree');
    const countBadge = document.getElementById('editorGraphCount');
    if (!container || !this.scene) return;

    container.innerHTML = '';
    const nodes = [];

    const camSvg = `<svg class="b-tree-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
    const lightSvg = `<svg class="b-tree-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M15 9a3 3 0 1 0-6 0c0 2 2 3 2 5h2c0-2 2-3 2-5z"/></svg>`;
    const meshSvg = `<svg class="b-tree-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
    const eyeOpenSvg = `<svg class="b-tree-eye-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const eyeClosedSvg = `<svg class="b-tree-eye-svg eye-hidden" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

    // Collect Cameras
    this.scene.cameras.forEach(cam => nodes.push({ type: 'camera', iconHtml: camSvg, node: cam }));
    // Collect Lights
    this.scene.lights.forEach(light => nodes.push({ type: 'light', iconHtml: lightSvg, node: light }));
    // Collect Meshes
    this.scene.meshes.forEach(mesh => {
      if (!HELPER_MESHES.has(mesh.name)) {
        nodes.push({ type: 'mesh', iconHtml: meshSvg, node: mesh });
      }
    });

    if (countBadge) countBadge.textContent = `${nodes.length} nodes`;

    nodes.forEach(item => {
      const row = document.createElement('div');
      row.className = `b-tree-item ${this.selectedNode === item.node ? 'selected' : ''}`;
      row.dataset.nodeName = item.node.name;

      const isEnabled = item.node.isEnabled ? item.node.isEnabled() : true;

      row.innerHTML = `
        <span class="b-tree-icon">${item.iconHtml}</span>
        <span class="b-tree-name">${this._escapeHtml(item.node.name)}</span>
        <span class="b-tree-eye" title="Toggle Visibility">${isEnabled ? eyeOpenSvg : eyeClosedSvg}</span>
      `;

      row.addEventListener('click', () => this.selectNode(item.node));
      const eye = row.querySelector('.b-tree-eye');
      if (eye && item.node.setEnabled) {
        eye.addEventListener('click', (e) => {
          e.stopPropagation();
          const enabled = !item.node.isEnabled();
          item.node.setEnabled(enabled);
          eye.innerHTML = enabled ? eyeOpenSvg : eyeClosedSvg;
          eye.classList.toggle('hidden', !enabled);
          this._scheduleSceneSave();
        });
      }

      container.appendChild(row);
    });
  }

  _filterSceneGraph(filterText) {
    const text = (filterText || '').toLowerCase().trim();
    document.querySelectorAll('.b-tree-item').forEach(row => {
      const name = (row.dataset.nodeName || '').toLowerCase();
      row.style.display = name.includes(text) ? 'flex' : 'none';
    });
  }

  _updateOutlinerSelection() {
    document.querySelectorAll('.b-tree-item').forEach(row => {
      const isSel = this.selectedNode && row.dataset.nodeName === this.selectedNode.name;
      row.classList.toggle('selected', Boolean(isSel));
    });
  }

  /**
   * Properties Panel Synchronization
   */
  _bindInspectorInputs() {
    const bindVal = (id, prop, transformType, isAngle = false) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener('input', () => {
        if (!this.selectedNode || !this.selectedNode[transformType]) return;
        const val = parseFloat(input.value) || 0;
        this.selectedNode[transformType][prop] = isAngle ? (val * Math.PI / 180) : val;
      });
    };

    // Location
    bindVal('inspPosX', 'x', 'position');
    bindVal('inspPosY', 'y', 'position');
    bindVal('inspPosZ', 'z', 'position');

    // Rotation
    bindVal('inspRotX', 'x', 'rotation', true);
    bindVal('inspRotY', 'y', 'rotation', true);
    bindVal('inspRotZ', 'z', 'rotation', true);

    // Scale
    bindVal('inspScaleX', 'x', 'scaling');
    bindVal('inspScaleY', 'y', 'scaling');
    bindVal('inspScaleZ', 'z', 'scaling');

    // Name
    const nameInput = document.getElementById('inspNodeName');
    if (nameInput) {
      nameInput.addEventListener('change', () => {
        if (this.selectedNode) {
          this.selectedNode.name = nameInput.value.trim() || this.selectedNode.name;
          this._refreshSceneGraph();
        }
      });
    }

    // Material controls
    const matColor = document.getElementById('inspMatColor');
    const matHex = document.getElementById('inspMatColorHex');
    const applyMatColor = (hex) => {
      if (!/^#[0-9a-f]{6}$/i.test(hex) || !this.selectedNode?.material) return;
      if (matColor) matColor.value = hex;
      if (matHex) matHex.value = hex;
      const c = BABYLON.Color3.FromHexString(hex);
      if (this.selectedNode.material.albedoColor) this.selectedNode.material.albedoColor = c;
      if (this.selectedNode.material.diffuseColor) this.selectedNode.material.diffuseColor = c;
    };
    if (matColor) matColor.addEventListener('input', (e) => applyMatColor(e.target.value));
    if (matHex) matHex.addEventListener('change', (e) => applyMatColor(e.target.value));

    const rough = document.getElementById('inspRoughness');
    const roughVal = document.getElementById('inspRoughnessVal');
    if (rough) {
      this._updateSliderStyle(rough);
      rough.addEventListener('input', () => {
        const val = parseFloat(rough.value);
        if (roughVal) roughVal.textContent = val.toFixed(2);
        this._updateSliderStyle(rough);
        if (this.selectedNode?.material?.roughness !== undefined) {
          this.selectedNode.material.roughness = val;
        }
      });
    }

    const metal = document.getElementById('inspMetallic');
    const metalVal = document.getElementById('inspMetallicVal');
    if (metal) {
      this._updateSliderStyle(metal);
      metal.addEventListener('input', () => {
        const val = parseFloat(metal.value);
        if (metalVal) metalVal.textContent = val.toFixed(2);
        this._updateSliderStyle(metal);
        if (this.selectedNode?.material?.metallic !== undefined) {
          this.selectedNode.material.metallic = val;
        }
      });
    }

    const alpha = document.getElementById('inspAlpha');
    const alphaVal = document.getElementById('inspAlphaVal');
    if (alpha) {
      this._updateSliderStyle(alpha);
      alpha.addEventListener('input', () => {
        const val = parseFloat(alpha.value);
        if (alphaVal) alphaVal.textContent = val.toFixed(2);
        this._updateSliderStyle(alpha);
        if (this.selectedNode?.material) {
          this.selectedNode.material.alpha = val;
        }
      });
    }

    const lightIntensity = document.getElementById('inspLightIntensity');
    const lightIntensityVal = document.getElementById('inspLightIntensityVal');
    if (lightIntensity) {
      this._updateSliderStyle(lightIntensity);
      lightIntensity.addEventListener('input', () => {
        const val = parseFloat(lightIntensity.value);
        if (lightIntensityVal) lightIntensityVal.textContent = val.toFixed(2);
        this._updateSliderStyle(lightIntensity);
        if (this.selectedNode instanceof BABYLON.Light || this.selectedNode?.intensity !== undefined) {
          this.selectedNode.intensity = val;
        }
      });
    }

    const lightColor = document.getElementById('inspLightColor');
    const lightHex = document.getElementById('inspLightColorHex');
    const applyLightColor = (hex) => {
      if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
      if (lightColor) lightColor.value = hex;
      if (lightHex) lightHex.value = hex;
      if (this.selectedNode?.diffuse) {
        this.selectedNode.diffuse = BABYLON.Color3.FromHexString(hex);
      }
    };
    if (lightColor) lightColor.addEventListener('input', (e) => applyLightColor(e.target.value));
    if (lightHex) lightHex.addEventListener('change', (e) => applyLightColor(e.target.value));

    const emissiveColor = document.getElementById('inspEmissiveColor');
    const emissiveHex = document.getElementById('inspEmissiveColorHex');
    const applyEmissive = (hex) => {
      if (!/^#[0-9a-f]{6}$/i.test(hex) || !this.selectedNode?.material) return;
      if (emissiveColor) emissiveColor.value = hex;
      if (emissiveHex) emissiveHex.value = hex;
      const c = BABYLON.Color3.FromHexString(hex);
      if (this.selectedNode.material.emissiveColor) this.selectedNode.material.emissiveColor = c;
    };
    if (emissiveColor) emissiveColor.addEventListener('input', (e) => applyEmissive(e.target.value));
    if (emissiveHex) emissiveHex.addEventListener('change', (e) => applyEmissive(e.target.value));

    const wireCheck = document.getElementById('inspWireframe');
    if (wireCheck) {
      wireCheck.addEventListener('change', () => {
        if (this.selectedNode?.material) this.selectedNode.material.wireframe = wireCheck.checked;
      });
    }

    const backfaceCheck = document.getElementById('inspBackface');
    if (backfaceCheck) {
      backfaceCheck.addEventListener('change', () => {
        if (this.selectedNode?.material) this.selectedNode.material.backFaceCulling = backfaceCheck.checked;
      });
    }
  }

  _updateSliderStyle(slider) {
    if (!slider) return;
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 1;
    const val = parseFloat(slider.value) || 0;
    const percent = Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100));
    slider.style.setProperty('--val-percent', `${percent}%`);
  }

  _syncInspector() {
    const emptyState = document.getElementById('inspectorEmptyState');
    const content = document.getElementById('inspectorContent');
    if (!this.selectedNode) {
      if (emptyState) emptyState.style.display = 'block';
      if (content) content.style.display = 'none';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    if (content) content.style.display = 'block';

    const nameInput = document.getElementById('inspNodeName');
    if (nameInput) nameInput.value = this.selectedNode.name || '';

    const typeBadge = document.getElementById('inspNodeType');
    if (typeBadge) {
      typeBadge.textContent = this.selectedNode instanceof BABYLON.Light ? 'Light' :
        (this.selectedNode instanceof BABYLON.Camera ? 'Camera' : 'Mesh');
    }

    // Transforms
    if (this.selectedNode.position) {
      const px = document.getElementById('inspPosX');
      const py = document.getElementById('inspPosY');
      const pz = document.getElementById('inspPosZ');
      if (px) px.value = this.selectedNode.position.x.toFixed(2);
      if (py) py.value = this.selectedNode.position.y.toFixed(2);
      if (pz) pz.value = this.selectedNode.position.z.toFixed(2);
    }
    if (this.selectedNode.rotation) {
      const rx = document.getElementById('inspRotX');
      const ry = document.getElementById('inspRotY');
      const rz = document.getElementById('inspRotZ');
      if (rx) rx.value = (this.selectedNode.rotation.x * 180 / Math.PI).toFixed(0);
      if (ry) ry.value = (this.selectedNode.rotation.y * 180 / Math.PI).toFixed(0);
      if (rz) rz.value = (this.selectedNode.rotation.z * 180 / Math.PI).toFixed(0);
    }
    if (this.selectedNode.scaling) {
      const sx = document.getElementById('inspScaleX');
      const sy = document.getElementById('inspScaleY');
      const sz = document.getElementById('inspScaleZ');
      if (sx) sx.value = this.selectedNode.scaling.x.toFixed(2);
      if (sy) sy.value = this.selectedNode.scaling.y.toFixed(2);
      if (sz) sz.value = this.selectedNode.scaling.z.toFixed(2);
    }

    // Material
    const rough = document.getElementById('inspRoughness');
    const roughVal = document.getElementById('inspRoughnessVal');
    const metal = document.getElementById('inspMetallic');
    const metalVal = document.getElementById('inspMetallicVal');
    const alpha = document.getElementById('inspAlpha');
    const alphaVal = document.getElementById('inspAlphaVal');
    const matColor = document.getElementById('inspMatColor');
    const matHex = document.getElementById('inspMatColorHex');
    const wireCheck = document.getElementById('inspWireframe');
    const backfaceCheck = document.getElementById('inspBackface');

    if (this.selectedNode.material) {
      const mat = this.selectedNode.material;
      const matName = document.getElementById('inspMatName');
      if (matName) matName.value = mat.name || 'Default Material';

      if (rough && mat.roughness !== undefined) {
        rough.value = mat.roughness;
        if (roughVal) roughVal.textContent = Number(mat.roughness).toFixed(2);
        this._updateSliderStyle(rough);
      }
      if (metal && mat.metallic !== undefined) {
        metal.value = mat.metallic;
        if (metalVal) metalVal.textContent = Number(mat.metallic).toFixed(2);
        this._updateSliderStyle(metal);
      }
      if (alpha && mat.alpha !== undefined) {
        alpha.value = mat.alpha;
        if (alphaVal) alphaVal.textContent = Number(mat.alpha).toFixed(2);
        this._updateSliderStyle(alpha);
      }
      if (mat.albedoColor || mat.diffuseColor) {
        const c = mat.albedoColor || mat.diffuseColor;
        const hex = c.toHexString ? c.toHexString() : '#cccccc';
        if (matColor) matColor.value = hex;
        if (matHex) matHex.value = hex;
      }
      if (wireCheck && mat.wireframe !== undefined) wireCheck.checked = Boolean(mat.wireframe);
      if (backfaceCheck && mat.backFaceCulling !== undefined) backfaceCheck.checked = Boolean(mat.backFaceCulling);
    }

    // Light
    const lightSection = document.getElementById('inspLightSection');
    const lightIntensity = document.getElementById('inspLightIntensity');
    const lightIntensityVal = document.getElementById('inspLightIntensityVal');
    const lightColor = document.getElementById('inspLightColor');
    const lightHex = document.getElementById('inspLightColorHex');

    if (this.selectedNode instanceof BABYLON.Light) {
      if (lightSection) lightSection.style.display = 'block';
      if (lightIntensity && this.selectedNode.intensity !== undefined) {
        lightIntensity.value = this.selectedNode.intensity;
        if (lightIntensityVal) lightIntensityVal.textContent = Number(this.selectedNode.intensity).toFixed(2);
        this._updateSliderStyle(lightIntensity);
      }
      if (this.selectedNode.diffuse) {
        const hex = this.selectedNode.diffuse.toHexString ? this.selectedNode.diffuse.toHexString() : '#ffffff';
        if (lightColor) lightColor.value = hex;
        if (lightHex) lightHex.value = hex;
      }
    }
  }

  _updateTelemetry() {
    const now = performance.now();
    if (now - this._lastFpsUpdate > 500) {
      this._lastFpsUpdate = now;
      const fps = Math.round(this.engine.getFps());
      const fpsEl = document.getElementById('editorFpsCounter');
      if (fpsEl) fpsEl.textContent = fps;

      if (this.scene) {
        const polyEl = document.getElementById('headerPolyCount');
        const meshEl = document.getElementById('headerMeshCount');
        const totalVerts = this.scene.totalVertices || 0;
        const totalMeshes = this.scene.meshes.length;

        if (polyEl) polyEl.textContent = totalVerts.toLocaleString();
        if (meshEl) meshEl.textContent = totalMeshes;
      }
    }
  }

  _onResize() {
    if (this.engine) this.engine.resize();
  }

  _escapeHtml(val) {
    return String(val).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
}

export const webgpuEditor = new WebGPUEditor();
