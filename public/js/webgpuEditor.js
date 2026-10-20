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
// Slicing duplicates/intersects vertex data and captures an Undo snapshot.
// Keep this synchronous editor action within a predictable frame budget.
const MAX_SLICE_TRIANGLES = 75_000;
const MAX_SLICE_VERTICES = 100_000;
const MAX_SLICE_CAP_SEGMENTS = 2_048;
// Imported assets can be made of several small meshes, but an occasional
// glTF mesh is denser than a primitive.  This allowance applies only to the
// dedicated GLB command; it never changes the responsive primitive command.
const MAX_GLB_SLICE_TRIANGLES = 150_000;
const MAX_GLB_SLICE_VERTICES = 200_000;

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
    this.highlightLayer = null;
    this.ssaoPipeline = null;
    this._ssaoPipelineType = null;
    this.shadowGenerators = new Map();
    this._iblEnvironmentTexture = null;
    this._iblLoadPromise = null;
    this._iblUnavailable = false;
    this.worldSettings = {
      ambientIntensity: 0.85,
      iblIntensity: 1.0,
      shadowQuality: 'medium',
      ssaoEnabled: false,
      ssaoRadius: 2.0,
    };
    this._worldSettingsInitialized = false;
    this._sliceInProgress = false;
    this._compositeSliceState = null;
    // glTF importers do not all build the same parent/child hierarchy. Keep
    // the exact imported mesh ids as a reliable fallback for GLB operations.
    this._activeGlbMeshIds = new Set();
    this.isWebGPU = false;
    this.isOpen = false;
    this.selectedNode = null;
    this.selectedNodes = [];
    this.selectionMode = 'whole';

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

    // Edit Menu Action Bindings
    const menuUndo = document.getElementById('menuUndo');
    const menuRedo = document.getElementById('menuRedo');
    if (menuUndo) menuUndo.addEventListener('click', () => this.undo());
    if (menuRedo) menuRedo.addEventListener('click', () => this.redo());

    // Mesh Menu Action Bindings
    const menuMeshJoin = document.getElementById('menuMeshJoin');
    const menuMeshFlatShading = document.getElementById('menuMeshFlatShading');
    const menuMeshSmoothShading = document.getElementById('menuMeshSmoothShading');
    const menuMeshFlipNormals = document.getElementById('menuMeshFlipNormals');
    const menuMeshSlice = document.getElementById('menuMeshSlice');
    const menuMeshDuplicateGlb = document.getElementById('menuMeshDuplicateGlb');
    const menuMeshToggleWireframe = document.getElementById('menuMeshToggleWireframe');

    if (menuMeshJoin) menuMeshJoin.addEventListener('click', () => this.joinSelected());
    if (menuMeshFlatShading) menuMeshFlatShading.addEventListener('click', () => this.setFlatShading());
    if (menuMeshSmoothShading) menuMeshSmoothShading.addEventListener('click', () => this.setSmoothShading());
    if (menuMeshFlipNormals) menuMeshFlipNormals.addEventListener('click', () => this.flipNormals());
    if (menuMeshSlice) menuMeshSlice.addEventListener('click', () => this.sliceMesh());
    if (menuMeshDuplicateGlb) menuMeshDuplicateGlb.addEventListener('click', () => this.duplicateGlbModel());
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
      } else if (ctrlOrMeta && keyLower === 'k') {
        e.preventDefault();
        this.sliceMesh();
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
        // Wireframe toggle removed with Solid/PBR Shading
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
      this._initAllSliders(); // Initialize all slider track fills
      this._initWorldSettings(); // Initialize World settings immediately
      this._updateWorldSettings();
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

    // Update backend indicator in status bar
    const backendText = document.getElementById('backendText');
    if (backendText) {
      backendText.textContent = this.isWebGPU ? 'WebGPU' : 'WebGL Fallback';
    }

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
    this._disposeHighlightLayer();
    this._disposeWorldEffects();
    // An environment request belongs to the scene that started it.  Do not
    // let a late response from a previous editor scene bleed into this one.
    this._iblLoadPromise = null;
    this._iblEnvironmentTexture = null;
    this._iblUnavailable = false;
    if (this.scene) {
      this.scene.dispose();
    }
    this._activeGlbMeshIds.clear();

    const scene = new BABYLON.Scene(this.engine);
    this.scene = scene;
    // Keep the neutral, light-gray editor background. It gives the grid and
    // model shadows enough contrast without turning the empty viewport black.
    scene.clearColor = new BABYLON.Color4(0.34, 0.34, 0.35, 1.0);

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
    hemi.intensity = 0.6;
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

    // Keep the baseline strengths separate from World Environment controls.
    hemi.metadata = { worldAmbientBase: hemi.intensity };
    dirKey.metadata = { worldShadowCaster: true };

    // Infinite Seamless Floor Grid (1000x1000 with distance/horizon fade)
    const ground = BABYLON.MeshBuilder.CreateGround('StudioGround', { width: 1000, height: 1000 }, scene);
    ground.position.y = 0;
    ground.isPickable = false;

    // GridMaterial does not consistently receive Babylon shadow maps across
    // the WebGL/WebGPU backends. Draw the grid into the same StandardMaterial
    // that receives shadows instead of stacking two near-coplanar planes.
    // One surface prevents z-fighting/light flicker while orbiting the camera.
    const groundMat = new BABYLON.StandardMaterial('GroundMat', scene);
    groundMat.diffuseColor = new BABYLON.Color3(0.72, 0.73, 0.76);
    groundMat.specularColor = new BABYLON.Color3(0, 0, 0);
    groundMat.ambientColor = new BABYLON.Color3(0.28, 0.28, 0.3);
    // A small self-lit component keeps the grid readable even when the user
    // lowers Ambient Intensity, while the diffuse component still receives
    // visible directional shadows.
    groundMat.emissiveColor = new BABYLON.Color3(0.11, 0.11, 0.12);
    groundMat.wireframe = false;
    const gridTexture = new BABYLON.DynamicTexture('StudioGridTexture', { width: 512, height: 512 }, scene, false);
    const gridContext = gridTexture.getContext();
    gridContext.fillStyle = '#737780';
    gridContext.fillRect(0, 0, 512, 512);
    for (let line = 0; line <= 16; line += 1) {
      const coordinate = line * 32;
      gridContext.beginPath();
      gridContext.strokeStyle = line % 4 === 0 ? '#292d35' : '#50545c';
      gridContext.lineWidth = line % 4 === 0 ? 2 : 1;
      gridContext.moveTo(coordinate, 0);
      gridContext.lineTo(coordinate, 512);
      gridContext.moveTo(0, coordinate);
      gridContext.lineTo(512, coordinate);
      gridContext.stroke();
    }
    gridTexture.hasAlpha = false;
    gridTexture.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    gridTexture.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    gridTexture.uScale = 62.5;
    gridTexture.vScale = 62.5;
    gridTexture.anisotropicFilteringLevel = 8;
    gridTexture.update(false);
    groundMat.diffuseTexture = gridTexture;
    ground.material = groundMat;

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

  _serializeScene(scene = this.scene) {
    if (!scene) return {};
    const serialized = BABYLON.SceneSerializer.Serialize(scene);

    // Удаляем любые HighlightLayer / EffectLayer подсветки из сериализации,
    // чтобы рамки выделения никогда не сохранялись как часть 3D-сцены
    if (Array.isArray(serialized.effectLayers)) {
      serialized.effectLayers = serialized.effectLayers.filter(l => l.name !== 'selectionHighlight');
      if (serialized.effectLayers.length === 0) delete serialized.effectLayers;
    }

    // Нормализуем параметры StudioOrbitCamera в снимке, чтобы вращение и зум камеры
    // не считались изменением содержимого 3D-сцены и не сбрасывали стек Redo
    if (Array.isArray(serialized.cameras)) {
      serialized.cameras.forEach(cam => {
        if (cam.name === 'StudioOrbitCamera') {
          cam.alpha = 0;
          cam.beta = 0;
          cam.radius = 10;
          cam.position = [0, 1, 0];
          cam.target = [0, 1, 0];
        }
      });
    }

    return serialized;
  }

  _captureSceneSnapshot() {
    return JSON.stringify(this._serializeScene(this.scene));
  }

  _commitSceneHistory() {
    if (!this.scene || this._historyInProgress) return;
    const currentSnapshot = this._captureSceneSnapshot();
    if (this._historyBaseline && currentSnapshot !== this._historyBaseline) {
      this.undoStack.push({
        scene: this._historyBaseline,
        selectedName: this.selectedNode?.name || null,
        selectionMode: this.selectionMode || 'whole',
        applyHighlight: Boolean(this.selectedNode && this.selectionMode === 'submesh')
      });
      if (this.undoStack.length > 50) this.undoStack.shift();
      this.redoStack = [];
    }
    this._historyBaseline = currentSnapshot;
  }

  /** Загружает сцену, сериализованную через SceneSerializer, и возвращает НОВУЮ Scene. */
  async _loadSerializedScene(serialized) {
    const json = typeof serialized === 'string' ? serialized : JSON.stringify(serialized);
    const loaded = await BABYLON.SceneLoader.LoadAsync('', 'data:' + json, this.engine);
    if (Array.isArray(loaded.effectLayers)) {
      loaded.effectLayers.slice().forEach(layer => {
        if (layer.name === 'selectionHighlight') {
          try { layer.dispose(); } catch (e) {}
        }
      });
    }
    return loaded;
  }

  async _restoreSceneSnapshot(entry) {
    const snapshot = typeof entry === 'string' ? entry : entry.scene;
    const selectedName = typeof entry === 'object' ? entry?.selectedName : null;
    const selectionMode = (typeof entry === 'object' && entry?.selectionMode) || 'whole';
    const applyHighlight = Boolean(typeof entry === 'object' && entry?.applyHighlight);

    const savedCamState = this.camera ? {
      alpha: this.camera.alpha,
      beta: this.camera.beta,
      radius: this.camera.radius,
      target: this.camera.target ? this.camera.target.clone() : null
    } : null;

    this._disposeWorldEffects();
    const restoredScene = await this._loadSerializedScene(snapshot);
    const previousScene = this.scene;
    this.gizmoManager?.dispose();
    this._disposeHighlightLayer();
    this.scene = restoredScene;
    this.camera = restoredScene.activeCamera || restoredScene.activeCameras?.[0] || restoredScene.cameras[0] || null;
    this.selectedNode = null;
    this.selectedNodes = [];
    previousScene?.dispose();

    if (this.camera) {
      if (savedCamState) {
        this.camera.alpha = savedCamState.alpha;
        this.camera.beta = savedCamState.beta;
        this.camera.radius = savedCamState.radius;
        if (savedCamState.target && this.camera.setTarget) {
          this.camera.setTarget(savedCamState.target);
        }
      }
      this.camera.attachControl(this.canvas, true);
    }

    HELPER_MESHES.forEach(name => {
      const m = restoredScene.getMeshByName(name);
      if (m) m.isPickable = false;
    });

    this._initGizmoManager();
    this._bindScenePicking(restoredScene);
    this._refreshSceneGraph();
    this._updateWorldSettings();

    const restoredSelection = selectedName ? (restoredScene.getNodeByName(selectedName) || restoredScene.getMeshByName(selectedName)) : null;
    this.selectNode(restoredSelection, selectionMode, applyHighlight && Boolean(restoredSelection));
  }

  async undo() {
    if (this._historyInProgress || !this.undoStack.length) return;
    clearTimeout(this._saveTimer);
    this._commitSceneHistory();
    const entry = this.undoStack.pop();
    if (!entry) return;

    this._historyInProgress = true;
    try {
      this.redoStack.push({
        scene: this._captureSceneSnapshot(),
        selectedName: this.selectedNode?.name || null,
        selectionMode: this.selectionMode || 'whole',
        applyHighlight: Boolean(this.selectedNode && this.selectionMode === 'submesh')
      });
      await this._restoreSceneSnapshot(entry);
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
    const entry = this.redoStack.pop();
    if (!entry) return;

    this._historyInProgress = true;
    try {
      this.undoStack.push({
        scene: this._captureSceneSnapshot(),
        selectedName: this.selectedNode?.name || null,
        selectionMode: this.selectionMode || 'whole',
        applyHighlight: Boolean(this.selectedNode && this.selectionMode === 'submesh')
      });
      await this._restoreSceneSnapshot(entry);
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
        const serialized = this._serializeScene(scene);
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
        this._disposeWorldEffects();
        const restoredScene = await this._loadSerializedScene(json);
        const previousScene = this.scene;
        this.gizmoManager?.dispose();
        this._disposeHighlightLayer();
        this.scene = restoredScene;
        this.camera = restoredScene.activeCamera
          || restoredScene.activeCameras?.[0]
          || restoredScene.cameras[0]
          || null;
        previousScene?.dispose();
        this.camera?.attachControl(this.canvas, true);
        HELPER_MESHES.forEach(name => {
          const m = restoredScene.getMeshByName(name);
          if (m) m.isPickable = false;
        });
        this._initGizmoManager();
        this._bindScenePicking(restoredScene);
        this.selectedNode = null;
        this._refreshSceneGraph();
        this._updateWorldSettings();
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
    this._disposeHighlightLayer();
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
    this._applyIblIntensity(this.worldSettings.iblIntensity);
    this._applyShadowQuality(this.worldSettings.shadowQuality);
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
      const serialized = this._serializeScene(this.scene);
      await saveEditorSceneState(JSON.stringify(serialized));
    } catch (err) {
      console.warn('[WebGPUEditor] Could not save current model as default:', err);
    }
  }

  /** Import a glTF model or CoreLink project bundle into the editor. */
  async importEditorFile(file) {
    if (!file) return;

    try {
      const { filename, extension: ext } = await validateModelFile(file, file.name);
      this.log(`Importing ${filename}...`, 'info');
      this._setLoader(`Loading ${file.name}...`);
      if (ext === 'cl3d') {
        const bundle = await projectBundle.importBundle(file);
        if (bundle.modelFile) {
          await this._loadModelFromBuffer(await bundle.modelFile.arrayBuffer(), bundle.modelFile.name);
        }
      } else if (['glb', 'gltf'].includes(ext)) {
        const buffer = await file.arrayBuffer();
        await this._loadModelFromBuffer(buffer, filename);
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
    this._activeGlbMeshIds.clear();

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
          m.metadata = { ...(m.metadata || {}), coreLinkAssetKind: 'glb-mesh' };
          if (m.computeWorldMatrix) m.computeWorldMatrix(true);
          if (m.refreshBoundingInfo) m.refreshBoundingInfo(true);
        });
        this._activeGlbMeshIds = new Set(
          result.meshes
            .filter((m) => m instanceof BABYLON.Mesh && m.getVerticesData(BABYLON.VertexBuffer.PositionKind)?.length)
            .map((m) => m.uniqueId)
        );
        root.metadata = { ...(root.metadata || {}), coreLinkAssetKind: 'glb-root' };

        if (this.scene.whenReadyAsync) {
          await this.scene.whenReadyAsync();
        }

        // Render warm-up frames
        if (this.scene.render) {
          this.scene.render();
          this.scene.render();
        }

        this.frameSelected(root);
        this._applyIblIntensity(this.worldSettings.iblIntensity);
        this._applyShadowQuality(this.worldSettings.shadowQuality);
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

  _disposeHighlightLayer() {
    if (this.highlightLayer) {
      try {
        this.highlightLayer.dispose();
      } catch (e) {}
      this.highlightLayer = null;
    }
  }

  _ensureHighlightLayer() {
    if (!this.scene || !BABYLON.HighlightLayer) return null;

    const isValid = this.highlightLayer &&
                    !this.highlightLayer.isDisposed &&
                    this.highlightLayer.getScene &&
                    this.highlightLayer.getScene() === this.scene;

    if (!isValid) {
      this._disposeHighlightLayer();
      try {
        const layer = new BABYLON.HighlightLayer('selectionHighlight', this.scene, {
          isStroke: true,
          mainTextureRatio: 1
        });
        layer.innerGlow = false;
        layer.outerGlow = true;
        layer.blurHorizontalSize = 0.5;
        layer.blurVerticalSize = 0.5;
        this.highlightLayer = layer;
      } catch (e) {
        console.warn('[WebGPUEditor] Could not initialize HighlightLayer:', e);
        this.highlightLayer = null;
      }
    }
    return this.highlightLayer;
  }

  _clearHighlight() {
    if (this.highlightLayer && !this.highlightLayer.isDisposed) {
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
    const layer = this._ensureHighlightLayer();
    if (!layer) return;

    try {
      layer.removeAllMeshes();
      if (!nodes || nodes.length === 0) return;

      const colorHex = mode === 'submesh' ? '#FFA500' : '#00BFFF';
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
            layer.addMesh(m, highlightColor);
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

  /**
   * Duplicate a compound imported GLB without copying GPU buffers, textures,
   * or materials. Babylon mesh clones safely share immutable geometry and
   * PBR resources, so this stays responsive even for detailed assets.
   */
  _duplicateGlbMeshes(target, sourceMeshes) {
    if (this._sliceInProgress || !this.scene || !sourceMeshes.length) return;
    this._sliceInProgress = true;
    const duplicates = [];
    try {
      sourceMeshes.forEach((mesh) => mesh.computeWorldMatrix(true));
      const triangleCount = sourceMeshes.reduce((total, mesh) => total + ((mesh.getIndices()?.length || 0) / 3), 0);
      // Scene serialization duplicates all vertex arrays. Keep Undo for small
      // assets, but do not lock the editor after duplicating a dense GLB.
      const historySnapshot = triangleCount <= 30_000 ? this._captureSceneSnapshot() : null;
      const bounds = sourceMeshes.map((mesh) => mesh.getBoundingInfo().boundingBox);
      const minX = Math.min(...bounds.map((box) => box.minimumWorld.x));
      const maxX = Math.max(...bounds.map((box) => box.maximumWorld.x));
      const offsetX = Math.max((maxX - minX) * 1.12, 0.5);
      const cloneBySource = new Map();
      const copyTag = `Copy_${Date.now()}`;

      // First clone every render mesh.  `clone` shares the original vertex
      // buffers and materials, avoiding the texture loss and frame hitch that
      // came from creating a second set of clip-plane materials.
      sourceMeshes.forEach((source, index) => {
        const copy = source.clone(`${source.name}_${copyTag}_${index}`, null, true);
        if (!copy) throw new Error(`Could not duplicate ${source.name}`);
        copy.metadata = { ...(source.metadata || {}), coreLinkAssetKind: 'glb-duplicate' };
        copy.isPickable = source.isPickable;
        duplicates.push(copy);
        cloneBySource.set(source, copy);
      });

      // Restore mesh-to-mesh parent relations inside the duplicate. Meshes
      // whose parent is a TransformNode remain under the original transform,
      // which is safe because only the duplicate root meshes are offset.
      sourceMeshes.forEach((source) => {
        const copy = cloneBySource.get(source);
        if (cloneBySource.has(source.parent)) {
          copy.parent = cloneBySource.get(source.parent);
        } else {
          copy.parent = source.parent || null;
        }
      });
      sourceMeshes.forEach((source) => {
        if (!cloneBySource.has(source.parent)) {
          cloneBySource.get(source).translate(BABYLON.Axis.X, offsetX, BABYLON.Space.WORLD);
        }
      });

      this._refreshSceneGraph();
      this.selectNodes(duplicates, 'whole', true);
      if (historySnapshot) {
        this.undoStack.push({
          scene: historySnapshot,
          selectedName: target.name,
          selectionMode: 'whole',
          applyHighlight: false,
        });
        if (this.undoStack.length > 50) this.undoStack.shift();
        this.redoStack = [];
      }
      this._historyBaseline = historySnapshot ? this._captureSceneSnapshot() : null;
      if (triangleCount <= 30_000) {
        this._scheduleSceneSave({ recordHistory: false });
      }
      const performanceNotice = historySnapshot ? '' : ' Session save and Undo were skipped to keep this dense GLB responsive.';
      this.log(`Duplicated GLB object: ${target.name}.${performanceNotice}`, 'info');
    } catch (error) {
      duplicates.forEach((mesh) => {
        try { mesh.dispose(true, false); } catch (_) { /* best effort */ }
      });
      console.error('[WebGPUEditor] GLB duplication failed:', error);
      this.log(`Duplicate Object GLB failed: ${error.message}`, 'error');
    } finally {
      this._sliceInProgress = false;
    }
  }

  /** Resolve the complete imported asset and duplicate it as one object. */
  duplicateGlbModel(target = this.selectedNode) {
    if (!target || !this.scene) {
      this.log('Select an imported GLB model to duplicate', 'warn');
      return;
    }

    let root = target;
    let cursor = target;
    while (cursor) {
      if (cursor.metadata?.coreLinkAssetKind === 'glb-root') {
        root = cursor;
        break;
      }
      cursor = cursor.parent;
    }
    // Restored sessions may predate the GLB metadata marker. In that case use
    // the highest scene-node ancestor as the imported-model root.
    if (root === target) {
      while (
        root.parent
        && (root.parent instanceof BABYLON.AbstractMesh || root.parent instanceof BABYLON.TransformNode)
        && !HELPER_MESHES.has(root.parent.name)
      ) {
        root = root.parent;
      }
    }

    const positionKind = BABYLON.VertexBuffer.PositionKind;
    // Some exporters place render meshes alongside the synthetic root rather
    // than beneath it.  Combine hierarchy discovery with the ids registered
    // when this GLB was imported, then de-duplicate the result.
    const hierarchyMeshes = [root, ...(root.getChildMeshes?.(false) || [])];
    const trackedImportedMeshes = this.scene.meshes.filter((mesh) => (
      this._activeGlbMeshIds.has(mesh.uniqueId)
      || mesh.metadata?.coreLinkAssetKind === 'glb-mesh'
    ));
    const candidates = [...hierarchyMeshes, ...trackedImportedMeshes]
      .filter((mesh, index, all) => (
        mesh instanceof BABYLON.Mesh
        && !HELPER_MESHES.has(mesh.name)
        && mesh.getVerticesData(positionKind)
        && mesh.getIndices()?.length
        && all.indexOf(mesh) === index
      ));

    if (!candidates.length) {
      this.log('Duplicate Object GLB could not find render geometry below the selected model', 'warn');
      return;
    }

    this._duplicateGlbMeshes(root, candidates);
  }

  /**
   * GLB-specific bisect. Every render mesh is clipped against one shared
   * world-space plane through the complete asset. This is equivalent to a
   * Blender group bisect: it preserves the source transforms/materials and
   * does not collapse an imported hierarchy into a lossy temporary mesh.
   */
  async _sliceGlbModelGeometry(root, sourceMeshes) {
    if (this._sliceInProgress) return;
    this._clearCompositeSlice();

    const triangleCount = sourceMeshes.reduce((total, mesh) => total + (mesh.getIndices()?.length || 0) / 3, 0);
    const vertexCount = sourceMeshes.reduce((total, mesh) => total + mesh.getTotalVertices(), 0);
    let minY = Infinity;
    let maxY = -Infinity;
    sourceMeshes.forEach((mesh) => {
      mesh.computeWorldMatrix(true);
      const box = mesh.getBoundingInfo().boundingBox;
      minY = Math.min(minY, box.minimumWorld.y);
      maxY = Math.max(maxY, box.maximumWorld.y);
    });
    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || Math.abs(maxY - minY) < 1e-6) {
      this.log('Slice Mesh GLB could not calculate a valid model height.', 'warn');
      return;
    }

    const planePointWorld = new BABYLON.Vector3(0, (minY + maxY) / 2, 0);
    // A GLB may consist of many meshes. Limit each operation instead of the
    // sum, so a normal multi-part character is not rejected just because all
    // of its parts together have a high triangle count.
    const sliceable = sourceMeshes.filter((mesh) => {
      const indices = mesh.getIndices();
      return indices?.length
        && mesh.getTotalVertices() <= MAX_GLB_SLICE_VERTICES
        && indices.length / 3 <= MAX_GLB_SLICE_TRIANGLES;
    });
    if (!sliceable.length) {
      this.log(`Slice Mesh GLB skipped: every render mesh exceeds the ${MAX_GLB_SLICE_TRIANGLES.toLocaleString()}-triangle limit.`, 'warn');
      return;
    }

    this._sliceInProgress = true;
    const keepHistory = triangleCount <= 30_000;
    const historyBeforeSlice = keepHistory ? this._captureSceneSnapshot() : null;
    try {
      const pieces = [];
      for (let index = 0; index < sliceable.length; index += 1) {
        const mesh = sliceable[index];
        const result = this.sliceMesh(mesh, {
          batch: true,
          forceTarget: true,
          skipHistory: true,
          skipFinalize: true,
          planePointWorld,
          maxTriangles: MAX_GLB_SLICE_TRIANGLES,
          maxVertices: MAX_GLB_SLICE_VERTICES,
        });
        if (result?.upperMesh) pieces.push(result.upperMesh);
        if (result?.lowerMesh) pieces.push(result.lowerMesh);
        // Do not monopolize the main thread for a multi-part imported model.
        // One mesh still slices atomically, but the viewport can paint between
        // components instead of appearing frozen for the entire GLB.
        if (index < sliceable.length - 1 && index % 2 === 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }
      if (!pieces.length) {
        this.log('Slice Mesh GLB did not produce valid geometric halves.', 'warn');
        return;
      }

      clearTimeout(this._saveTimer);
      if (historyBeforeSlice) {
        this.undoStack.push({
          scene: historyBeforeSlice,
          selectedName: root.name,
          selectionMode: 'whole',
          applyHighlight: true,
        });
        if (this.undoStack.length > 50) this.undoStack.shift();
        this.redoStack = [];
      }
      this._refreshSceneGraph();
      this.selectNodes(pieces, 'whole', true);
      this._historyBaseline = this._captureSceneSnapshot();
      this._scheduleSceneSave({ recordHistory: false });
      const skipped = sourceMeshes.length - sliceable.length;
      const historyNotice = keepHistory ? '' : ' Undo skipped for this dense model.';
      const skippedNotice = skipped ? ` ${skipped} over-limit mesh(es) were left unchanged.` : '';
      this.log(`Slice Mesh GLB completed: ${root.name} was bisected on one shared world plane.${skippedNotice}${historyNotice}`, 'info');
    } catch (error) {
      console.error('[WebGPUEditor] GLB slice failed:', error);
      this.log(`Slice Mesh GLB failed: ${error.message}`, 'error');
    } finally {
      this._sliceInProgress = false;
    }
  }

  /**
   * Blender-style group bisect: perform the real geometry operation on every
   * child mesh of an imported model, then update the editor only once.
   */
  _sliceCompoundGeometry(target, meshes) {
    if (this._sliceInProgress) return;
    this._clearCompositeSlice();
    const sliceable = meshes.filter((mesh) => {
      const indices = mesh.getIndices();
      return indices?.length
        && mesh.getTotalVertices() <= MAX_SLICE_VERTICES
        && indices.length / 3 <= MAX_SLICE_TRIANGLES;
    });
    if (!sliceable.length) {
      this.log(`Slice Mesh skipped: ${target.name} has no meshes within the safe geometry limit.`, 'warn');
      return;
    }

    const skippedCount = meshes.length - sliceable.length;
    const totalTriangles = sliceable.reduce((total, mesh) => total + mesh.getIndices().length / 3, 0);
    // A full serialized Undo snapshot of a large, newly doubled GLB is more
    // expensive than the cut itself. Keep Undo for normal assets; prioritise
    // responsiveness for dense imported scenes.
    const keepHistory = totalTriangles <= 30_000;
    if (keepHistory) {
      clearTimeout(this._saveTimer);
      this.undoStack.push({
        scene: this._captureSceneSnapshot(),
        selectedName: target.name,
        selectionMode: 'whole',
        applyHighlight: true,
      });
      if (this.undoStack.length > 50) this.undoStack.shift();
      this.redoStack = [];
    }

    this._sliceInProgress = true;
    const pieces = [];
    try {
      sliceable.forEach((mesh) => {
        const result = this.sliceMesh(mesh, { batch: true, forceTarget: true, skipHistory: true, skipFinalize: true });
        if (result?.upperMesh) pieces.push(result.upperMesh);
        if (result?.lowerMesh) pieces.push(result.lowerMesh);
      });
      if (!pieces.length) {
        this.log('Slice Mesh did not produce geometry for this model.', 'warn');
        return;
      }
      this._refreshSceneGraph();
      this.selectNodes(pieces, 'whole', true);
      if (keepHistory) {
        this._historyBaseline = this._captureSceneSnapshot();
        this._scheduleSceneSave({ recordHistory: false });
      }
      const capNotice = totalTriangles > 30_000 ? ' (history skipped to keep the editor responsive)' : '';
      const skippedNotice = skippedCount ? `; ${skippedCount} over-limit mesh(es) left unchanged` : '';
      this.log(`Sliced ${target.name}: ${pieces.length} real mesh parts created${skippedNotice}${capNotice}.`, 'info');
    } catch (error) {
      console.error('[WebGPUEditor] Compound slice failed:', error);
      this.log(`Slice failed: ${error.message}`, 'error');
    } finally {
      this._sliceInProgress = false;
    }
  }

  /**
   * Slice the selected mesh along a cutting plane through its center.
   * Full solid polygon clipping with automatic Cap Holes / Fill Caps generation,
   * proper normal orientation, planar UV mapping, and two-sided rendering.
   */
  sliceMesh(target = this.selectedNode, {
    batch = false,
    forceTarget = false,
    skipHistory = false,
    skipFinalize = false,
    planePointWorld = null,
    maxTriangles = MAX_SLICE_TRIANGLES,
    maxVertices = MAX_SLICE_VERTICES,
  } = {}) {
    if (!target) {
      this.log('Select a mesh to slice', 'warn');
      return null;
    }
    if (this._sliceInProgress && !batch) {
      this.log('Slice Mesh is already processing', 'warn');
      return null;
    }

    const positionKind = BABYLON.VertexBuffer.PositionKind;
    // Imported GLB roots are often Babylon Mesh objects themselves, but their
    // visible geometry lives in descendants. Prefer all real descendants over
    // the root wrapper; the old ternary selected the wrapper alone and made
    // Slice Mesh appear to do nothing for exactly this kind of asset.
    const descendantMeshes = forceTarget ? [] : (target.getChildMeshes?.(false) || []).filter((mesh) => (
      mesh instanceof BABYLON.Mesh
      && mesh !== target
      && mesh.getVerticesData(positionKind)
      && mesh.getIndices()?.length
    ));
    const candidates = descendantMeshes.length
      ? descendantMeshes
      : (target instanceof BABYLON.Mesh && target.getVerticesData(positionKind) && target.getIndices()?.length ? [target] : []);

    // The generic command is intentionally for one mesh/primitives only.
    // Compound imported assets use the dedicated Slice Mesh GLB menu action.
    if (candidates.length > 1) {
      if (!batch) this.log('This is a compound model. Use Mesh → Slice Mesh GLB.', 'warn');
      return null;
    }
    const meshToSlice = candidates[0] || null;

    if (!meshToSlice) {
      this.log('Selected object has no polygon geometry to slice', 'warn');
      return null;
    }

    const preflightIndices = meshToSlice.getIndices();
    const vertexCount = meshToSlice.getTotalVertices();
    const triangleCount = Math.floor((preflightIndices?.length || 0) / 3);
    if (!preflightIndices?.length || vertexCount > maxVertices || triangleCount > maxTriangles) {
      this.log(`Slice Mesh skipped: ${meshToSlice.name} exceeds the safe geometry limit (${triangleCount.toLocaleString()} triangles).`, 'warn');
      return null;
    }

    if (!batch) this._sliceInProgress = true;
    try {
      console.log('[WebGPUEditor] Starting solid mesh slice for:', meshToSlice.name);

      // Шаг 1: Секущая плоскость — горизонтальная через центр меша в мировом пространстве
      meshToSlice.computeWorldMatrix(true);
      const boundingInfo = meshToSlice.getBoundingInfo();
      // GLB group slicing passes one world-space center for every child mesh;
      // primitives simply use their own center as before.
      const centerWorld = planePointWorld?.clone() || boundingInfo.boundingBox.centerWorld.clone();
      const planeNormalWorld = new BABYLON.Vector3(0, 1, 0); // горизонтальный срез

      // Переводим секущую плоскость в локальное пространство меша
      const worldMatrix = meshToSlice.getWorldMatrix();
      const invWorldMatrix = BABYLON.Matrix.Invert(worldMatrix);

      const planePointLocal = BABYLON.Vector3.TransformCoordinates(centerWorld, invWorldMatrix);
      const planeNormalLocal = BABYLON.Vector3.TransformNormal(planeNormalWorld, invWorldMatrix).normalize();

      // Шаг 2: Извлекаем вершинные данные
      const origPositions = meshToSlice.getVerticesData(BABYLON.VertexBuffer.PositionKind);
      const origIndices = meshToSlice.getIndices();
      const origNormals = meshToSlice.getVerticesData(BABYLON.VertexBuffer.NormalKind);
      const origUVs = meshToSlice.getVerticesData(BABYLON.VertexBuffer.UVKind);

      if (!origPositions || !origIndices || origIndices.length === 0) {
        this.log('Mesh has no polygon geometry to slice', 'warn');
        return;
      }

      const numVertices = origPositions.length / 3;
      const distances = new Float64Array(numVertices);
      const px = planePointLocal.x, py = planePointLocal.y, pz = planePointLocal.z;
      const nx = planeNormalLocal.x, ny = planeNormalLocal.y, nz = planeNormalLocal.z;

      for (let i = 0; i < numVertices; i++) {
        const vx = origPositions[i * 3];
        const vy = origPositions[i * 3 + 1];
        const vz = origPositions[i * 3 + 2];
        distances[i] = (vx - px) * nx + (vy - py) * ny + (vz - pz) * nz;
      }

      // Шаг 3: Буферы для верхней и нижней частей
      const upperPositions = [], upperNormals = [], upperUVs = [], upperIndices = [];
      const lowerPositions = [], lowerNormals = [], lowerUVs = [], lowerIndices = [];
      const cutSegments = []; // Сегменты среза для крышек (Cap Holes)

      const addVertexTo = (posArr, normArr, uvArr, pos, norm, uv) => {
        const idx = posArr.length / 3;
        posArr.push(pos.x, pos.y, pos.z);
        normArr.push(norm.x, norm.y, norm.z);
        if (uv) {
          uvArr.push(uv.x, uv.y);
        } else {
          uvArr.push(0, 0);
        }
        return idx;
      };

      const getVertex = (idx) => {
        const pos = new BABYLON.Vector3(origPositions[idx * 3], origPositions[idx * 3 + 1], origPositions[idx * 3 + 2]);
        const norm = origNormals
          ? new BABYLON.Vector3(origNormals[idx * 3], origNormals[idx * 3 + 1], origNormals[idx * 3 + 2])
          : planeNormalLocal.clone();
        const uv = origUVs
          ? new BABYLON.Vector2(origUVs[idx * 2], origUVs[idx * 2 + 1])
          : new BABYLON.Vector2(0, 0);
        return { pos, norm, uv };
      };

      const interpolateVertex = (idxA, idxB, dA, dB) => {
        const denom = dA - dB;
        const t = Math.abs(denom) > 1e-12 ? Math.max(0, Math.min(1, dA / denom)) : 0.5;

        const ax = origPositions[idxA * 3], ay = origPositions[idxA * 3 + 1], az = origPositions[idxA * 3 + 2];
        const bx = origPositions[idxB * 3], by = origPositions[idxB * 3 + 1], bz = origPositions[idxB * 3 + 2];
        const pos = new BABYLON.Vector3(ax + t * (bx - ax), ay + t * (by - ay), az + t * (bz - az));

        let norm = planeNormalLocal.clone();
        if (origNormals) {
          const nax = origNormals[idxA * 3], nay = origNormals[idxA * 3 + 1], naz = origNormals[idxA * 3 + 2];
          const nbx = origNormals[idxB * 3], nby = origNormals[idxB * 3 + 1], nbz = origNormals[idxB * 3 + 2];
          norm = new BABYLON.Vector3(nax + t * (nbx - nax), nay + t * (nby - nay), naz + t * (nbz - naz)).normalize();
        }

        let uv = new BABYLON.Vector2(0, 0);
        if (origUVs) {
          const uax = origUVs[idxA * 2], uay = origUVs[idxA * 2 + 1];
          const ubx = origUVs[idxB * 2], uby = origUVs[idxB * 2 + 1];
          uv = new BABYLON.Vector2(uax + t * (ubx - uax), uay + t * (uby - uay));
        }

        return { pos, norm, uv };
      };

      const EPS = 1e-6;

      // Шаг 4: Разрезание каждого треугольника
      for (let i = 0; i < origIndices.length; i += 3) {
        const i0 = origIndices[i];
        const i1 = origIndices[i + 1];
        const i2 = origIndices[i + 2];

        const d0 = distances[i0];
        const d1 = distances[i1];
        const d2 = distances[i2];

        const s0 = d0 > EPS ? 1 : (d0 < -EPS ? -1 : 0);
        const s1 = d1 > EPS ? 1 : (d1 < -EPS ? -1 : 0);
        const s2 = d2 > EPS ? 1 : (d2 < -EPS ? -1 : 0);

        // Все вершины выше или на плоскости
        if (s0 >= 0 && s1 >= 0 && s2 >= 0) {
          const v0 = getVertex(i0), v1 = getVertex(i1), v2 = getVertex(i2);
          const u0 = addVertexTo(upperPositions, upperNormals, upperUVs, v0.pos, v0.norm, v0.uv);
          const u1 = addVertexTo(upperPositions, upperNormals, upperUVs, v1.pos, v1.norm, v1.uv);
          const u2 = addVertexTo(upperPositions, upperNormals, upperUVs, v2.pos, v2.norm, v2.uv);
          upperIndices.push(u0, u1, u2);
          continue;
        }

        // Все вершины ниже или на плоскости
        if (s0 <= 0 && s1 <= 0 && s2 <= 0) {
          const v0 = getVertex(i0), v1 = getVertex(i1), v2 = getVertex(i2);
          const l0 = addVertexTo(lowerPositions, lowerNormals, lowerUVs, v0.pos, v0.norm, v0.uv);
          const l1 = addVertexTo(lowerPositions, lowerNormals, lowerUVs, v1.pos, v1.norm, v1.uv);
          const l2 = addVertexTo(lowerPositions, lowerNormals, lowerUVs, v2.pos, v2.norm, v2.uv);
          lowerIndices.push(l0, l1, l2);
          continue;
        }

        // Треугольник пересекает плоскость: находим вершину-одиночку (solo)
        const tri = [i0, i1, i2];
        const dists = [d0, d1, d2];
        const signs = [s0, s1, s2];

        let soloIdx = 0;
        if (signs[0] === signs[1]) soloIdx = 2;
        else if (signs[0] === signs[2]) soloIdx = 1;
        else soloIdx = 0;

        const pair1Idx = (soloIdx + 1) % 3;
        const pair2Idx = (soloIdx + 2) % 3;

        const idxSolo = tri[soloIdx], dSolo = dists[soloIdx];
        const idxPair1 = tri[pair1Idx], dPair1 = dists[pair1Idx];
        const idxPair2 = tri[pair2Idx], dPair2 = dists[pair2Idx];

        const int1 = interpolateVertex(idxSolo, idxPair1, dSolo, dPair1);
        const int2 = interpolateVertex(idxSolo, idxPair2, dSolo, dPair2);

        const vSolo = getVertex(idxSolo);
        const vPair1 = getVertex(idxPair1);
        const vPair2 = getVertex(idxPair2);

        if (dSolo > 0) {
          // Solo вверху: верх получает 1 треугольник (vSolo, int1, int2)
          const u0 = addVertexTo(upperPositions, upperNormals, upperUVs, vSolo.pos, vSolo.norm, vSolo.uv);
          const u1 = addVertexTo(upperPositions, upperNormals, upperUVs, int1.pos, int1.norm, int1.uv);
          const u2 = addVertexTo(upperPositions, upperNormals, upperUVs, int2.pos, int2.norm, int2.uv);
          upperIndices.push(u0, u1, u2);

          // Низ получает 2 треугольника: (int1, vPair1, vPair2) и (int1, vPair2, int2)
          const l0 = addVertexTo(lowerPositions, lowerNormals, lowerUVs, int1.pos, int1.norm, int1.uv);
          const l1 = addVertexTo(lowerPositions, lowerNormals, lowerUVs, vPair1.pos, vPair1.norm, vPair1.uv);
          const l2 = addVertexTo(lowerPositions, lowerNormals, lowerUVs, vPair2.pos, vPair2.norm, vPair2.uv);
          const l3 = addVertexTo(lowerPositions, lowerNormals, lowerUVs, int2.pos, int2.norm, int2.uv);
          lowerIndices.push(l0, l1, l2);
          lowerIndices.push(l0, l2, l3);

          // Сегмент среза для крышек
          cutSegments.push({ p1: int1.pos.clone(), p2: int2.pos.clone() });
        } else {
          // Solo внизу: низ получает 1 треугольник (vSolo, int1, int2)
          const l0 = addVertexTo(lowerPositions, lowerNormals, lowerUVs, vSolo.pos, vSolo.norm, vSolo.uv);
          const l1 = addVertexTo(lowerPositions, lowerNormals, lowerUVs, int1.pos, int1.norm, int1.uv);
          const l2 = addVertexTo(lowerPositions, lowerNormals, lowerUVs, int2.pos, int2.norm, int2.uv);
          lowerIndices.push(l0, l1, l2);

          // Верх получает 2 треугольника: (int1, vPair1, vPair2) и (int1, vPair2, int2)
          const u0 = addVertexTo(upperPositions, upperNormals, upperUVs, int1.pos, int1.norm, int1.uv);
          const u1 = addVertexTo(upperPositions, upperNormals, upperUVs, vPair1.pos, vPair1.norm, vPair1.uv);
          const u2 = addVertexTo(upperPositions, upperNormals, upperUVs, vPair2.pos, vPair2.norm, vPair2.uv);
          const u3 = addVertexTo(upperPositions, upperNormals, upperUVs, int2.pos, int2.norm, int2.uv);
          upperIndices.push(u0, u1, u2);
          upperIndices.push(u0, u2, u3);

          // Сегмент среза для крышек (противоположное направление обхода)
          cutSegments.push({ p1: int2.pos.clone(), p2: int1.pos.clone() });
        }
      }

      // Шаг 5: Автоматическая генерация закрывающих крышек среза (Cap Holes / Fill Caps)
      if (cutSegments.length >= 3 && cutSegments.length <= MAX_SLICE_CAP_SEGMENTS) {
        let capX = 0, capY = 0, capZ = 0;
        for (const seg of cutSegments) {
          capX += seg.p1.x + seg.p2.x;
          capY += seg.p1.y + seg.p2.y;
          capZ += seg.p1.z + seg.p2.z;
        }
        const totalPoints = cutSegments.length * 2;
        const capCenter = new BABYLON.Vector3(capX / totalPoints, capY / totalPoints, capZ / totalPoints);

        // Локальный тангенциальный 2D-базис для планарного проецирования UV на срезе
        let tangentU = new BABYLON.Vector3(1, 0, 0);
        if (Math.abs(planeNormalLocal.x) > 0.8) {
          tangentU = new BABYLON.Vector3(0, 0, 1);
        }
        const basisU = BABYLON.Vector3.Cross(planeNormalLocal, tangentU).normalize();
        const basisV = BABYLON.Vector3.Cross(planeNormalLocal, basisU).normalize();

        let maxCapRadius = 0.001;
        for (const seg of cutSegments) {
          maxCapRadius = Math.max(
            maxCapRadius,
            BABYLON.Vector3.Distance(seg.p1, capCenter),
            BABYLON.Vector3.Distance(seg.p2, capCenter)
          );
        }
        const uvScale = Math.max(maxCapRadius * 2, 0.01);

        const getCapUV = (pt) => {
          const diff = pt.subtract(capCenter);
          return new BABYLON.Vector2(
            0.5 + BABYLON.Vector3.Dot(diff, basisU) / uvScale,
            0.5 + BABYLON.Vector3.Dot(diff, basisV) / uvScale
          );
        };

        const uvCenter = getCapUV(capCenter);
        const normCapUpper = planeNormalLocal.scale(-1); // смотрит наружу верхней части (вниз)
        const normCapLower = planeNormalLocal.clone();   // смотрит наружу нижней части (вверх)

        // Генерируем веер треугольников крышки
        for (const seg of cutSegments) {
          const uv1 = getCapUV(seg.p1);
          const uv2 = getCapUV(seg.p2);

          // Нижняя крышка (нормаль +N, обход Center -> p1 -> p2)
          const lC = addVertexTo(lowerPositions, lowerNormals, lowerUVs, capCenter, normCapLower, uvCenter);
          const l1 = addVertexTo(lowerPositions, lowerNormals, lowerUVs, seg.p1, normCapLower, uv1);
          const l2 = addVertexTo(lowerPositions, lowerNormals, lowerUVs, seg.p2, normCapLower, uv2);
          lowerIndices.push(lC, l1, l2);

          // Верхняя крышка (нормаль -N, обход Center -> p2 -> p1)
          const uC = addVertexTo(upperPositions, upperNormals, upperUVs, capCenter, normCapUpper, uvCenter);
          const u2 = addVertexTo(upperPositions, upperNormals, upperUVs, seg.p2, normCapUpper, uv2);
          const u1 = addVertexTo(upperPositions, upperNormals, upperUVs, seg.p1, normCapUpper, uv1);
          upperIndices.push(uC, u2, u1);
        }
      }

      // Шаг 6: Создание двух новых независимых мешей
      let upperMesh = null;
      let lowerMesh = null;
      // Apply the visual separation in the source mesh's local space. The old
      // implementation added a world-space Y value to a local position, which
      // rotated/skewed imported glTF nodes and made models appear to fall over.
      const localHeight = Math.max(meshToSlice.getBoundingInfo().boundingBox.extendSize.y * 2, 0.1);
      // Make an actual slice immediately legible, rather than leaving a
      // sub-pixel 0.04-unit gap on a normally scaled imported character.
      const separation = Math.min(Math.max(localHeight * 0.06, 0.03), 0.5);
      const offsetPositions = (positions, direction) => {
        for (let i = 0; i < positions.length; i += 3) {
          positions[i] += planeNormalLocal.x * separation * direction;
          positions[i + 1] += planeNormalLocal.y * separation * direction;
          positions[i + 2] += planeNormalLocal.z * separation * direction;
        }
      };
      offsetPositions(upperPositions, 1);
      offsetPositions(lowerPositions, -1);

      if (upperIndices.length > 0) {
        upperMesh = new BABYLON.Mesh(`${meshToSlice.name}_Upper`, this.scene);
        upperMesh.setVerticesData(BABYLON.VertexBuffer.PositionKind, new Float32Array(upperPositions), true);
        upperMesh.setIndices(new Uint32Array(upperIndices));
        upperMesh.setVerticesData(BABYLON.VertexBuffer.NormalKind, new Float32Array(upperNormals), true);
        upperMesh.setVerticesData(BABYLON.VertexBuffer.UVKind, new Float32Array(upperUVs), true);
      }

      if (lowerIndices.length > 0) {
        lowerMesh = new BABYLON.Mesh(`${meshToSlice.name}_Lower`, this.scene);
        lowerMesh.setVerticesData(BABYLON.VertexBuffer.PositionKind, new Float32Array(lowerPositions), true);
        lowerMesh.setIndices(new Uint32Array(lowerIndices));
        lowerMesh.setVerticesData(BABYLON.VertexBuffer.NormalKind, new Float32Array(lowerNormals), true);
        lowerMesh.setVerticesData(BABYLON.VertexBuffer.UVKind, new Float32Array(lowerUVs), true);
      }

      if (!upperMesh && !lowerMesh) {
        this.log('Slice did not produce any geometry', 'warn');
        return;
      }

      // Шаг 7: Настройка двухсторонних материалов (Backface Culling = false)
      const configureMaterial = (mesh) => {
        if (!mesh) return;
        if (meshToSlice.material) {
          const mat = meshToSlice.material.clone(`${mesh.name}_Mat`);
          mat.backFaceCulling = false;
          if (mat.twoSidedLighting !== undefined) {
            mat.twoSidedLighting = true;
          }
          mesh.material = mat;
        }
      };

      configureMaterial(upperMesh);
      configureMaterial(lowerMesh);

      // Шаг 8: Клонируем локальную трансформацию исходного mesh без смешения
      // координат parent/world. Это сохраняет ориентацию glTF-узлов.
      const copySourceTransform = (mesh) => {
        if (!mesh) return;
        mesh.parent = meshToSlice.parent || null;
        mesh.position.copyFrom(meshToSlice.position);
        mesh.scaling.copyFrom(meshToSlice.scaling);
        mesh.rotation.copyFrom(meshToSlice.rotation);
        mesh.rotationQuaternion = meshToSlice.rotationQuaternion?.clone() || null;
        mesh.visibility = meshToSlice.visibility;
        mesh.isPickable = meshToSlice.isPickable;
        mesh.computeWorldMatrix(true);
        mesh.refreshBoundingInfo();
      };
      copySourceTransform(upperMesh);
      copySourceTransform(lowerMesh);

      // Шаг 9: Запись в историю Undo/Redo и удаление исходного меша
      if (!skipHistory) {
        clearTimeout(this._saveTimer);
        this._commitSceneHistory();
        this.undoStack.push({
          scene: this._captureSceneSnapshot(),
          selectedName: meshToSlice.name,
          selectionMode: 'whole',
          applyHighlight: false
        });
        if (this.undoStack.length > 50) this.undoStack.shift();
        this.redoStack = [];
      }

      // Do not recursively dispose sibling/child glTF nodes during a grouped
      // bisect; each source mesh is processed independently above.
      meshToSlice.dispose(true, false);

      if (!skipFinalize) {
        this._refreshSceneGraph();
        if (upperMesh) {
          this.selectNode(upperMesh, 'whole', true);
        } else if (lowerMesh) {
          this.selectNode(lowerMesh, 'whole', true);
        }
        this._historyBaseline = this._captureSceneSnapshot();
        this._scheduleSceneSave({ recordHistory: false });
      }

      this.log(`Mesh cleanly sliced into solid parts with Fill Caps: ${upperMesh ? upperMesh.name : ''} & ${lowerMesh ? lowerMesh.name : ''}`, 'info');
      return { upperMesh, lowerMesh };

    } catch (e) {
      console.error('[WebGPUEditor] Slice failed:', e);
      this.log(`Slice failed: ${e.message}`, 'error');
      return null;
    } finally {
      if (!batch) this._sliceInProgress = false;
    }
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
    const currentMode = this.selectionMode || 'whole';
    const hadHighlight = Boolean(this.selectionMode === 'submesh');
    clearTimeout(this._saveTimer);
    this._commitSceneHistory();
    this.undoStack.push({
      scene: this._captureSceneSnapshot(),
      selectedName: name,
      selectionMode: currentMode,
      applyHighlight: hadHighlight
    });
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

  _initAllSliders() {
    // Initialize all sliders on page load to ensure correct track fill
    const sliders = document.querySelectorAll('.b-slider');
    sliders.forEach(slider => {
      this._updateSliderStyle(slider);
    });
  }

  _syncInspector() {
    // Initialize World settings event listeners once
    this._initWorldSettings();

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

    this._syncWorldSettingsUI();
  }

  _initWorldSettings() {
    // Initialize World settings event listeners once
    if (this._worldSettingsInitialized) return;
    this._worldSettingsInitialized = true;

    // Ambient Intensity
    const ambientIntensity = document.getElementById('inspAmbientIntensity');
    const ambientIntensityVal = document.getElementById('inspAmbientIntensityVal');
    if (ambientIntensity) {
      this._updateSliderStyle(ambientIntensity);
      ambientIntensity.addEventListener('input', () => {
        const val = parseFloat(ambientIntensity.value);
        if (ambientIntensityVal) ambientIntensityVal.textContent = val.toFixed(2);
        this._updateSliderStyle(ambientIntensity);
        this._applyAmbientIntensity(val);
      });
    }

    // IBL Intensity
    const iblIntensity = document.getElementById('inspIBLIntensity');
    const iblIntensityVal = document.getElementById('inspIBLIntensityVal');
    if (iblIntensity) {
      this._updateSliderStyle(iblIntensity);
      iblIntensity.addEventListener('input', () => {
        const val = parseFloat(iblIntensity.value);
        if (iblIntensityVal) iblIntensityVal.textContent = val.toFixed(2);
        this._updateSliderStyle(iblIntensity);
        this._applyIblIntensity(val);
      });
    }

    const shadowQuality = document.getElementById('inspShadowQuality');
    if (shadowQuality) {
      const applyQuality = () => this._applyShadowQuality(shadowQuality.value);
      shadowQuality.addEventListener('input', applyQuality);
      shadowQuality.addEventListener('change', applyQuality);
    }

    const ssaoCheck = document.getElementById('inspSSAO');
    if (ssaoCheck) {
      ssaoCheck.addEventListener('change', () => {
        this._setSSAOEnabled(ssaoCheck.checked);
      });
    }

    // SSAO Radius - Re-enabled with proper binding
    const ssaoRadius = document.getElementById('inspSSAORadius');
    const ssaoRadiusVal = document.getElementById('inspSSAORadiusVal');
    if (ssaoRadius) {
      this._updateSliderStyle(ssaoRadius);
      const applyRadius = () => {
        const val = parseFloat(ssaoRadius.value);
        if (ssaoRadiusVal) ssaoRadiusVal.textContent = val.toFixed(1);
        this._updateSliderStyle(ssaoRadius);
        this._applySSAORadius(val);
      };
      // Radius has no observable effect while SSAO is disabled. Make a direct
      // interaction with its control enable the effect first; this guarantees
      // a working slider rather than a value that appears to do nothing.
      ssaoRadius.addEventListener('pointerdown', () => {
        if (!this.worldSettings.ssaoEnabled) {
          this._setSSAOEnabled(true);
          const control = document.getElementById('inspSSAO');
          if (control) control.checked = this.worldSettings.ssaoEnabled;
        }
      });
      ssaoRadius.addEventListener('input', applyRadius);
      ssaoRadius.addEventListener('change', applyRadius);
    }
  }

  _updateWorldSettings() {
    this._applyAmbientIntensity(this.worldSettings.ambientIntensity);
    this._applyIblIntensity(this.worldSettings.iblIntensity);
    this._applyShadowQuality(this.worldSettings.shadowQuality);
    this._setSSAOEnabled(this.worldSettings.ssaoEnabled);
  }

  _syncWorldSettingsUI() {
    const controls = [
      ['inspAmbientIntensity', 'inspAmbientIntensityVal', this.worldSettings.ambientIntensity, 2],
      ['inspIBLIntensity', 'inspIBLIntensityVal', this.worldSettings.iblIntensity, 2],
      ['inspSSAORadius', 'inspSSAORadiusVal', this.worldSettings.ssaoRadius, 1],
    ];
    controls.forEach(([inputId, valueId, value, digits]) => {
      const input = document.getElementById(inputId);
      const label = document.getElementById(valueId);
      if (input) { input.value = value; this._updateSliderStyle(input); }
      if (label) label.textContent = Number(value).toFixed(digits);
    });
    const quality = document.getElementById('inspShadowQuality');
    if (quality) quality.value = this.worldSettings.shadowQuality;
    const ssao = document.getElementById('inspSSAO');
    if (ssao) ssao.checked = this.worldSettings.ssaoEnabled;
  }

  _applyAmbientIntensity(value) {
    const intensity = BABYLON.Scalar.Clamp(Number(value) || 0, 0, 3);
    this.worldSettings.ambientIntensity = intensity;
    if (!this.scene) return;
    // A hemispheric light affects Standard, PBR and imported glTF materials;
    // scene.ambientColor alone does not reliably do so for PBR.
    this.scene.lights
      .filter((light) => light instanceof BABYLON.HemisphericLight)
      .forEach((light) => {
        const base = Number(light.metadata?.worldAmbientBase ?? 1);
        light.intensity = base * intensity;
      });
    this.scene.ambientColor = new BABYLON.Color3(intensity, intensity, intensity);
  }

  _applyIblIntensity(value) {
    const intensity = BABYLON.Scalar.Clamp(Number(value) || 0, 0, 2);
    this.worldSettings.iblIntensity = intensity;
    if (!this.scene) return;
    this._ensureIblEnvironment();
    // Babylon PBRMaterial owns the IBL multiplier. Apply it to every material
    // so imported models respond immediately, whether or not an environment is set.
    this.scene.materials.forEach((material) => {
      if (!('environmentIntensity' in material)) return;
      material.environmentIntensity = intensity;
      // A GLB can have PBR materials but no environment texture. In that case
      // environmentIntensity alone is mathematically invisible. Preserve the
      // intended physical IBL path, but provide a reversible luminance fallback
      // so this control still responds for every imported model.
      const metadata = material.metadata || (material.metadata = {});
      if (metadata.worldIblDirectBase === undefined) {
        metadata.worldIblDirectBase = Number(material.directIntensity ?? 1);
      }
      material.directIntensity = this.scene.environmentTexture && !this._iblUnavailable
        ? metadata.worldIblDirectBase
        : metadata.worldIblDirectBase * (0.55 + intensity * 0.45);
    });
    // Retain the value on the scene for subsequently imported PBR materials.
    this.scene.metadata = { ...(this.scene.metadata || {}), worldIblIntensity: intensity };
  }

  _ensureIblEnvironment() {
    if (!this.scene || this.scene.environmentTexture || this._iblLoadPromise) return;
    // PBR's IBL multiplier has no visible effect without a reflection source.
    // This neutral, prefiltered Babylon environment is applied only to the
    // editor scene, never to the separate preview workspace.
    const targetScene = this.scene;
    this._iblLoadPromise = new Promise((resolve) => {
      try {
        const texture = BABYLON.CubeTexture.CreateFromPrefilteredData(
          'https://assets.babylonjs.com/environments/environmentSpecular.env',
          this.scene,
          1,
          () => {
            const sceneDisposed = typeof targetScene?.isDisposed === 'function'
              ? targetScene.isDisposed()
              : Boolean(targetScene?.isDisposed);
            if (this.scene === targetScene && !sceneDisposed) {
              targetScene.environmentTexture = texture;
              this._iblEnvironmentTexture = texture;
              this._iblUnavailable = false;
              // Reapply both the physical IBL value and the fallback direct
              // lighting multiplier.  The latter must return to its baseline
              // once a real environment becomes available.
              this._applyIblIntensity(this.worldSettings.iblIntensity);
            } else {
              texture.dispose();
            }
            resolve();
          },
          () => {
            texture.dispose();
            this._iblUnavailable = true;
            this._applyIblIntensity(this.worldSettings.iblIntensity);
            resolve();
          }
        );
      } catch (error) {
        console.warn('[WebGPUEditor] Default IBL environment could not be loaded:', error);
        resolve();
      }
    }).finally(() => { this._iblLoadPromise = null; });
  }

  _applyShadowQuality(quality) {
    const sizes = { off: 0, low: 1024, medium: 2048, high: 4096 };
    const selected = Object.hasOwn(sizes, quality) ? quality : 'medium';
    this.worldSettings.shadowQuality = selected;
    this._disposeShadowGenerators();
    if (!this.scene || sizes[selected] === 0 || !BABYLON.ShadowGenerator) return;

    const casters = this.scene.meshes.filter((mesh) => !HELPER_MESHES.has(mesh.name) && mesh.getTotalVertices?.() > 0);
    const ground = this.scene.getMeshByName('StudioGround');
    if (ground) ground.receiveShadows = true;
    this.scene.lights
      .filter((light) => light instanceof BABYLON.DirectionalLight || light instanceof BABYLON.SpotLight)
      .forEach((light) => {
        try {
          const generator = new BABYLON.ShadowGenerator(sizes[selected], light);
          light.autoCalcShadowZBounds = true;
          // The default shadow-map path is supported by both WebGL2 and
          // WebGPU. Blur filters are backend-dependent and were the reason
          // quality changes could be accepted in the UI yet never render.
          generator.bias = selected === 'low' ? 0.0015 : selected === 'medium' ? 0.001 : 0.0005;
          generator.normalBias = selected === 'low' ? 0.03 : selected === 'medium' ? 0.02 : 0.01;
          casters.forEach((mesh) => {
            mesh.receiveShadows = true;
            generator.addShadowCaster(mesh, true);
          });
          this.shadowGenerators.set(light.uniqueId, generator);
        } catch (error) {
          console.warn('[WebGPUEditor] Shadow generator unavailable for light:', light.name, error);
        }
      });
    // The normal render loop will present the rebuilt generators. Rendering
    // once here gives immediate feedback without allowing a transient engine
    // error to break the settings control.
    try { this.scene.render(); } catch (_) { /* render loop recovers next frame */ }
  }

  _disposeShadowGenerators() {
    this.shadowGenerators.forEach((generator) => {
      try { generator.dispose(); } catch (_) { /* best effort */ }
    });
    this.shadowGenerators.clear();
  }

  _setSSAOEnabled(enabled) {
    this.worldSettings.ssaoEnabled = Boolean(enabled);
    this._disposeSSAO();
    if (!enabled || !this.scene || !this.camera) return;
    try {
      if (BABYLON.SSAO2RenderingPipeline) {
        const pipeline = new BABYLON.SSAO2RenderingPipeline('world-ssao', this.scene, {
          ssaoRatio: 0.5,
          blurRatio: 0.75,
        }, [this.camera]);
        pipeline.radius = this.worldSettings.ssaoRadius;
        pipeline.base = 0.0;
        pipeline.totalStrength = 0.65;
        pipeline.expensive = false;
        this.ssaoPipeline = pipeline;
        this._ssaoPipelineType = 'ssao2';
      } else if (BABYLON.DefaultRenderingPipeline) {
        // Some Babylon builds do not expose SSAO2. The default pipeline has
        // an equivalent AO pass and is a safe rendering fallback.
        const pipeline = new BABYLON.DefaultRenderingPipeline('world-ssao-fallback', true, this.scene, [this.camera]);
        pipeline.fxaaEnabled = false;
        pipeline.bloomEnabled = false;
        pipeline.chromaticAberrationEnabled = false;
        pipeline.grainEnabled = false;
        pipeline.sharpenEnabled = false;
        pipeline.imageProcessingEnabled = false;
        pipeline.ambientOcclusionEnabled = true;
        pipeline.ambientOcclusionRadius = this.worldSettings.ssaoRadius;
        pipeline.ambientOcclusionStrength = 0.65;
        this.ssaoPipeline = pipeline;
        this._ssaoPipelineType = 'default';
      } else {
        throw new Error('No ambient-occlusion pipeline is available');
      }
    } catch (error) {
      this.worldSettings.ssaoEnabled = false;
      const control = document.getElementById('inspSSAO');
      if (control) control.checked = false;
      console.warn('[WebGPUEditor] SSAO is unavailable on this graphics backend:', error);
    }
  }

  _disposeSSAO() {
    if (!this.ssaoPipeline) return;
    try {
      this.scene?.postProcessRenderPipelineManager?.detachCamerasFromRenderPipeline(this.ssaoPipeline.name, this.camera ? [this.camera] : undefined);
      this.ssaoPipeline.dispose();
    } catch (error) {
      console.warn('[WebGPUEditor] SSAO cleanup notice:', error);
    }
    this.ssaoPipeline = null;
    this._ssaoPipelineType = null;
  }

  _applySSAORadius(value) {
    const radius = BABYLON.Scalar.Clamp(Number(value) || 0.5, 0.5, 5);
    this.worldSettings.ssaoRadius = radius;
    if (this.ssaoPipeline) {
      if (this._ssaoPipelineType === 'default') {
        this.ssaoPipeline.ambientOcclusionRadius = radius;
      } else {
        this.ssaoPipeline.radius = radius;
      }
    }
  }

  _disposeWorldEffects() {
    this._disposeSSAO();
    this._disposeShadowGenerators();
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
