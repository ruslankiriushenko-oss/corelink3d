/**
 * CoreLink 3D — UI Manager (ui.js)
 * Connects HTML UI elements, sliders, color pickers, buttons, file uploaders, and 3D engine managers.
 */

import viewer3d           from './viewer3d.js';
import materialManager    from './materialManager.js';
import environmentManager from './environmentManager.js';
import modelInspector     from './modelInspector.js';
import assetManager       from './assetManager.js';
import projectBundle      from './projectBundle.js';
import { saveModelFile }  from './modelStorage.js';
import { validateModelFile } from './modelValidation.js';

class UIManager {
  constructor() {
    this.sessionId = null;
    this.uploadedFiles = [];
    this.isUploadInProgress = false;
  }

  _escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
  }

  init(sessionId) {
    this.sessionId = sessionId;
    this._bindCollapsibleCards();
    this._bindMaterialControls();
    this._bindEnvironmentControls();
    this._bindViewportQuickTools();
    this._bindFileUploader();
    this._bindAssetTrashUI();
    assetManager.onChange(() => this.renderAssetList());
    this.renderAssetList();
    this.updateInspectorUI();
  }

  // ── 0. COLLAPSIBLE ACCORDION CARDS ─────────────────────────
  _bindCollapsibleCards() {
    const cards = document.querySelectorAll('.card.collapsible');
    cards.forEach((card, index) => {
      const header = card.querySelector('.card-header');
      if (header) {
        header.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          card.classList.toggle('collapsed');
        });
      }
    });
  }

  // ── 1. MATERIAL CONTROLS ─────────────────────────────────────
  _bindMaterialControls() {
    const meshSelect             = document.getElementById('meshSelect');
    const baseColorInput         = document.getElementById('baseColorInput');
    const baseColorHex           = document.getElementById('baseColorHex');
    const baseColorVal           = document.getElementById('baseColorVal');
    const metallicRange          = document.getElementById('metallicRange');
    const metallicVal            = document.getElementById('metallicVal');
    const roughnessRange         = document.getElementById('roughnessRange');
    const roughnessVal           = document.getElementById('roughnessVal');
    const normalScaleRange       = document.getElementById('normalScaleRange');
    const normalScaleVal         = document.getElementById('normalScaleVal');
    const emissiveColorInput     = document.getElementById('emissiveColorInput');
    const emissiveColorHex       = document.getElementById('emissiveColorHex');
    const emissiveIntensityRange = document.getElementById('emissiveIntensityRange');
    const emissiveVal            = document.getElementById('emissiveVal');
    const btnShaderPbr           = document.getElementById('btnShaderPbr');
    const btnShaderCustom        = document.getElementById('btnShaderCustom');

    // Target Mesh Dropdown
    if (meshSelect) {
      meshSelect.addEventListener('change', (e) => {
        this.selectedMeshTarget = e.target.value;
      });
    }

    // Base Color Picker
    if (baseColorInput && baseColorHex) {
      const updateColor = (hex) => {
        baseColorHex.value   = hex;
        if (baseColorVal) baseColorVal.textContent = hex;
        materialManager.setBaseColor(hex, meshSelect ? meshSelect.value : 'all');
      };

      baseColorInput.addEventListener('input', (e) => updateColor(e.target.value));
      baseColorHex.addEventListener('change', (e) => {
        let val = e.target.value.trim();
        if (!val.startsWith('#')) val = '#' + val;
        updateColor(val);
      });
    }

    // Metallic Slider
    if (metallicRange && metallicVal) {
      metallicRange.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value).toFixed(2);
        metallicVal.textContent = val;
        materialManager.setMetalness(val, meshSelect ? meshSelect.value : 'all');
      });
    }

    // Roughness Slider
    if (roughnessRange && roughnessVal) {
      roughnessRange.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value).toFixed(2);
        roughnessVal.textContent = val;
        materialManager.setRoughness(val, meshSelect ? meshSelect.value : 'all');
      });
    }

    // Normal Scale Slider
    if (normalScaleRange && normalScaleVal) {
      normalScaleRange.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value).toFixed(2);
        normalScaleVal.textContent = val;
        materialManager.setNormalScale(val, meshSelect ? meshSelect.value : 'all');
      });
    }

    // Emissive Controls
    if (emissiveIntensityRange && emissiveVal) {
      emissiveIntensityRange.addEventListener('input', (e) => {
        const intensity = parseFloat(e.target.value).toFixed(1);
        emissiveVal.textContent = intensity;
        const color = emissiveColorHex ? emissiveColorHex.value : '#00f2fe';
        materialManager.setEmissive(color, intensity, meshSelect ? meshSelect.value : 'all');
      });
    }

    if (emissiveColorInput) {
      emissiveColorInput.addEventListener('input', (e) => {
        const intensity = emissiveIntensityRange ? emissiveIntensityRange.value : 1.0;
        if (emissiveColorHex) emissiveColorHex.value = e.target.value.toUpperCase();
        materialManager.setEmissive(e.target.value, intensity, meshSelect ? meshSelect.value : 'all');
      });
    }
    if (emissiveColorHex) emissiveColorHex.addEventListener('change', () => materialManager.setEmissive(emissiveColorHex.value, emissiveIntensityRange ? emissiveIntensityRange.value : 1, meshSelect ? meshSelect.value : 'all'));

    // Shader Toggle Buttons
    if (btnShaderPbr && btnShaderCustom) {
      btnShaderPbr.addEventListener('click', () => {
        btnShaderPbr.classList.add('active');
        btnShaderCustom.classList.remove('active');
        materialManager.setShaderMode('pbr');
      });
      btnShaderCustom.addEventListener('click', () => {
        btnShaderCustom.classList.add('active');
        btnShaderPbr.classList.remove('active');
        materialManager.setShaderMode('custom');
      });
    }
  }

  // ── 2. ENVIRONMENT CONTROLS ──────────────────────────────────
  _bindEnvironmentControls() {
    const presetBtns           = document.querySelectorAll('.preset-btn');
    const ambientIntensity     = document.getElementById('ambientIntensity');
    const ambientIntensityVal  = document.getElementById('ambientIntensityVal');
    const shadowToggle         = document.getElementById('shadowToggle');
    const bindRange = (id, valueId, callback, digits = 2) => {
      const input = document.getElementById(id);
      const output = document.getElementById(valueId);
      if (!input || !output) return;
      input.addEventListener('input', () => { output.textContent = Number(input.value).toFixed(digits); callback(input.value); });
    };

    presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        presetBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const preset = btn.dataset.preset;
        environmentManager.setEnvironmentPreset(preset);
      });
    });

    if (ambientIntensity && ambientIntensityVal) {
      ambientIntensity.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value).toFixed(2);
        ambientIntensityVal.textContent = val;
        environmentManager.setAmbientIntensity(val);
      });
    }

    bindRange('keyLightIntensityControl', 'keyLightIntensityControlVal', (value) => environmentManager.setLightIntensity('key', value));
    bindRange('fillLightIntensity', 'fillLightIntensityVal', (value) => environmentManager.setLightIntensity('fill', value));
    bindRange('rimLightIntensity', 'rimLightIntensityVal', (value) => environmentManager.setLightIntensity('rim', value));
    ['key', 'fill', 'rim'].forEach((name) => document.getElementById(`${name}LightEnabled`)?.addEventListener('change', (event) => environmentManager.setLightEnabled(name, event.target.checked)));
    ['key', 'fill', 'rim'].forEach((name) => document.getElementById(`${name}LightColor`)?.addEventListener('change', (event) => environmentManager.setLightColor(name, event.target.value)));
    bindRange('exposureControl', 'exposureControlVal', (value) => environmentManager.setExposure(value));
    bindRange('environmentIntensity', 'environmentIntensityVal', (value) => environmentManager.setEnvironmentIntensity(value));

    document.getElementById('wireframeOverlayToggle')?.addEventListener('change', (event) => viewer3d.setWireframe(event.target.checked));
    document.getElementById('gridFloorToggle')?.addEventListener('change', (event) => viewer3d.setGridVisible(event.target.checked));
    document.getElementById('hologramToggle')?.addEventListener('change', (event) => viewer3d.setHologram(event.target.checked));

    if (shadowToggle) {
      shadowToggle.addEventListener('change', (e) => {
        environmentManager.setShadowsEnabled(e.target.checked);
      });
    }
  }

  // ── 3. VIEWPORT QUICK TOOLBAR & WINDOW ACTIONS ─────────────
  _bindViewportQuickTools() {
    const btnResetCamera      = document.getElementById('btnResetCamera');
    const btnToggleWireframe  = document.getElementById('btnToggleWireframe');
    const btnToggleGrid       = document.getElementById('btnToggleGrid');
    const btnToggleAutoRotate = document.getElementById('btnToggleAutoRotate');
    const btnToggleOrbitLight = document.getElementById('btnToggleOrbitLight');
    const btnExportGlb        = document.getElementById('btnExportGlb');
    const btnPanelExportGlb   = document.getElementById('btnPanelExportGlb');
    const exportFormatSelect  = document.getElementById('exportFormatSelect');

    // macOS Window Controls
    const btnWinClose         = document.getElementById('btnWinClose');
    const btnWinMinimize      = document.getElementById('btnWinMinimize');
    const btnWinFullscreen    = document.getElementById('btnWinFullscreen');
    const canvasContainer     = document.getElementById('canvasContainer');
    const viewportQuickTools  = document.getElementById('viewportQuickTools');
    const viewportHud         = document.querySelector('.viewport-hud');

    if (btnResetCamera) {
      btnResetCamera.addEventListener('click', () => viewer3d.resetCamera());
    }

    if (btnToggleWireframe) {
      btnToggleWireframe.addEventListener('click', () => {
        const active = viewer3d.toggleWireframe();
        btnToggleWireframe.classList.toggle('active', active);
      });
    }

    if (btnToggleGrid) {
      btnToggleGrid.addEventListener('click', () => {
        const active = viewer3d.toggleGrid();
        btnToggleGrid.classList.toggle('active', active);
      });
    }

    if (btnToggleAutoRotate) {
      btnToggleAutoRotate.addEventListener('click', () => {
        const active = viewer3d.toggleAutoRotate();
        btnToggleAutoRotate.classList.toggle('active', active);
      });
    }

    if (btnToggleOrbitLight) {
      btnToggleOrbitLight.addEventListener('click', () => {
        const active = viewer3d.toggleOrbitLight();
        btnToggleOrbitLight.classList.toggle('active', active);
      });
    }

    // ── Export Handlers ──
    const btnPanelExportLabel = document.getElementById('btnPanelExportLabel');

    const updateExportUI = () => {
      const format = exportFormatSelect ? exportFormatSelect.value : 'glb';
      let label = 'Export Model';
      if (format === 'cl3d') label = 'Export Project (.cl3d)';

      if (btnPanelExportLabel) btnPanelExportLabel.textContent = label;
    };

    if (exportFormatSelect) {
      exportFormatSelect.addEventListener('change', updateExportUI);
    }
    updateExportUI();

    const handleExport = async (buttonEl) => {
      const format = exportFormatSelect ? exportFormatSelect.value : 'glb';
      const origHtml = buttonEl ? buttonEl.innerHTML : '';
      if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.innerHTML = `⏳ Exporting...`;
      }

      try {
        if (format === 'cl3d') {
          await projectBundle.exportProject();
        } else {
          await viewer3d.exportModel({ format, binary: format === 'glb' });
        }

        if (buttonEl) {
          buttonEl.innerHTML = `✓ Exported!`;
          setTimeout(() => {
            buttonEl.disabled = false;
            buttonEl.innerHTML = origHtml;
          }, 2000);
        }
      } catch (err) {
        alert('Export failed: ' + err.message);
        if (buttonEl) {
          buttonEl.disabled = false;
          buttonEl.innerHTML = origHtml;
        }
      }
    };

    if (btnExportGlb) {
      btnExportGlb.addEventListener('click', () => handleExport(btnExportGlb));
    }

    if (btnPanelExportGlb) {
      btnPanelExportGlb.addEventListener('click', () => handleExport(btnPanelExportGlb));
    }

    // ── macOS Red / Yellow / Green Controls ──
    // Red Dot: Close / Hide Viewport HUD & Overlay Tools
    if (btnWinClose) {
      let overlayVisible = true;
      btnWinClose.addEventListener('click', () => {
        overlayVisible = !overlayVisible;
        if (viewportQuickTools) viewportQuickTools.style.display = overlayVisible ? 'flex' : 'none';
        if (viewportHud) viewportHud.style.display = overlayVisible ? 'flex' : 'none';
        btnWinClose.classList.toggle('active-dot', !overlayVisible);
      });
    }

    // Yellow Dot: Minimize / Reset Camera Focus
    if (btnWinMinimize) {
      btnWinMinimize.addEventListener('click', () => {
        viewer3d.resetCamera();
      });
    }

    // Green Dot: Toggle Fullscreen Mode for 3D Canvas
    if (btnWinFullscreen) {
      btnWinFullscreen.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          if (canvasContainer?.requestFullscreen) {
            canvasContainer.requestFullscreen();
          } else if (canvasContainer?.webkitRequestFullscreen) {
            canvasContainer.webkitRequestFullscreen();
          }
        } else {
          if (document.exitFullscreen) {
            document.exitFullscreen();
          } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
          }
        }
      });
    }
  }

  // ── 4. FILE UPLOADER & DRAG-AND-DROP ─────────────────────────
  // ── 4. FILE UPLOADER & DRAG-AND-DROP ─────────────────────────
  _bindFileUploader() {
    const uploadZone   = document.getElementById('uploadZone');
    const fileInput    = document.getElementById('fileInput');
    const uploadStatus = document.getElementById('uploadStatus');
    const canvasOverlay = document.getElementById('canvasDropOverlay');
    const canvasContainer = document.getElementById('canvasContainer');

    if (uploadZone && fileInput) {
      uploadZone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => {
        const file = e.target?.files?.[0];
        if (file) this.uploadAndLoadModel(file);
      });

      // Drag & Drop on Upload Zone directly
      ['dragenter', 'dragover'].forEach(eventName => {
        uploadZone.addEventListener(eventName, (e) => {
          e.preventDefault();
          uploadZone.classList.add('drag-over');
        });
      });

      ['dragleave', 'drop'].forEach(eventName => {
        uploadZone.addEventListener(eventName, (e) => {
          e.preventDefault();
          uploadZone.classList.remove('drag-over');
        });
      });

      uploadZone.addEventListener('drop', (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (file) {
          this.uploadAndLoadModel(file);
        }
      });
    }

    // Drag & Drop on Canvas
    if (canvasContainer) {
      ['dragenter', 'dragover'].forEach(eventName => {
        canvasContainer.addEventListener(eventName, (e) => {
          e.preventDefault();
          if (canvasOverlay) canvasOverlay.classList.add('active');
        });
      });

      ['dragleave', 'drop'].forEach(eventName => {
        canvasContainer.addEventListener(eventName, (e) => {
          e.preventDefault();
          if (canvasOverlay) canvasOverlay.classList.remove('active');
        });
      });

      canvasContainer.addEventListener('drop', (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (file) {
          this.uploadAndLoadModel(file);
        }
      });
    }
  }

  async uploadAndLoadModel(file) {
    if (!file) {
      console.warn('[UIManager] uploadAndLoadModel called with empty file');
      return;
    }

    // Routing check: If WebGPU Studio "Edit" mode is active, route import directly to editor
    if (window.webgpuEditor && window.webgpuEditor.isOpen) {
      try {
        await window.webgpuEditor.importEditorFile(file);
      } catch (err) {
        console.error('[UIManager] Editor routing import failed:', err);
      }
      return;
    }

    const fileInput = document.getElementById('fileInput');
    const uploadStatus = document.getElementById('uploadStatus');

    // Rate limiting check
    if (this.isUploadInProgress) {
      console.warn('[UIManager] Upload already in progress, ignoring new request');
      return;
    }

    const rawName = file.name || (file instanceof Blob ? 'model.glb' : '');
    if (!rawName) {
      if (uploadStatus) {
        uploadStatus.textContent = 'Invalid file object';
        uploadStatus.className = 'upload-status error';
      }
      if (fileInput) fileInput.value = '';
      return;
    }

    // File size validation (100MB limit)
    const maxSizeMB = 100;
    if (file.size && file.size > maxSizeMB * 1024 * 1024) {
      if (uploadStatus) {
        uploadStatus.textContent = `File size exceeds ${maxSizeMB}MB limit`;
        uploadStatus.className = 'upload-status error';
      }
      if (fileInput) fileInput.value = '';
      return;
    }

    // File extension validation - strict check
    const ext = (rawName ? rawName.split('.').pop() : '').toLowerCase();
    const allowedExts = ['glb', 'gltf', 'obj', 'fbx', 'cl3d'];
    if (!allowedExts.includes(ext)) {
      if (uploadStatus) {
        uploadStatus.textContent = 'Supported formats: .GLB, .GLTF, .OBJ, .FBX, .CL3D';
        uploadStatus.className = 'upload-status error';
      }
      if (fileInput) fileInput.value = '';
      return;
    }

    // Validate content before it reaches IndexedDB, Three.js, or the project loader.
    let safeFileName;
    try {
      const validation = await validateModelFile(file, rawName);
      safeFileName = validation.filename;
    } catch (error) {
      if (uploadStatus) {
        uploadStatus.textContent = `Rejected asset: ${this._escapeHtml(error.message)}`;
        uploadStatus.className = 'upload-status error';
      }
      if (fileInput) fileInput.value = '';
      return;
    }
    const sanitizedName = this._escapeHtml(safeFileName);

    if (ext === 'cl3d') {
      this.isUploadInProgress = true;
      if (uploadStatus) {
        uploadStatus.textContent = `Unpacking .cl3d project: ${sanitizedName}...`;
        uploadStatus.className = 'upload-status loading';
      }

      try {
        await projectBundle.loadProject(file, safeFileName);
        if (uploadStatus) {
          uploadStatus.textContent = `Loaded project: ${sanitizedName}`;
          uploadStatus.className = 'upload-status success';
        }
        this.updateInspectorUI();
      } catch (err) {
        console.error('[UIManager] Project load error:', err);
        if (uploadStatus) {
          uploadStatus.textContent = `Project Error: ${this._escapeHtml(err.message || 'Corrupted .cl3d bundle')}`;
          uploadStatus.className = 'upload-status error';
        }
      } finally {
        this.isUploadInProgress = false;
        if (fileInput) fileInput.value = '';
      }
      return;
    }

    this.isUploadInProgress = true;
    if (uploadStatus) {
      uploadStatus.textContent = `Uploading ${sanitizedName}...`;
      uploadStatus.className = 'upload-status loading';
    }

    try {
      await saveModelFile(file, safeFileName);

      if (uploadStatus) {
        uploadStatus.textContent = `Loading ${sanitizedName}...`;
        uploadStatus.className = 'upload-status loading';
      }

      await viewer3d.loadModelFromFile(file, (pct) => {
        if (uploadStatus) uploadStatus.textContent = `Loading ${sanitizedName} (${pct}%)`;
      }, safeFileName);

      if (uploadStatus) {
        uploadStatus.textContent = `Loaded: ${sanitizedName}`;
        uploadStatus.className = 'upload-status success';
      }

      this._addFileToList(safeFileName, null);
      this.updateInspectorUI();

    } catch (err) {
      console.error('[UIManager] Upload/Load error:', err);
      if (uploadStatus) {
        uploadStatus.textContent = `Error: ${this._escapeHtml(err.message || 'Unknown error')}`;
        uploadStatus.className = 'upload-status error';
      }
    } finally {
      this.isUploadInProgress = false;
      // Always reset file input to allow re-selection of same file
      if (fileInput) fileInput.value = '';
    }
  }

  _bindAssetTrashUI() {
    const btnOpenTrash = document.getElementById('btnOpenTrash');
    const btnCloseTrash = document.getElementById('trashModalClose');
    const modal = document.getElementById('trashModal');
    const btnEmptyTrash = document.getElementById('btnEmptyTrash');

    if (btnOpenTrash && modal) {
      btnOpenTrash.addEventListener('click', () => {
        modal.classList.add('open');
        this.renderTrashList();
      });
    }

    if (btnCloseTrash && modal) {
      btnCloseTrash.addEventListener('click', () => modal.classList.remove('open'));
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('open');
      });
    }

    if (btnEmptyTrash) {
      btnEmptyTrash.addEventListener('click', () => {
        assetManager.emptyTrash();
        this.renderTrashList();
      });
    }
  }

  async _activateAsset(assetId) {
    const ok = await assetManager.activateAsset(assetId);
    if (ok) {
      this.updateInspectorUI();
    }
  }

  renderAssetList() {
    const fileList = document.getElementById('fileList');
    const trashCount = document.getElementById('trashCount');
    if (!fileList) return;

    const { active, trash, activeId } = assetManager.getState();
    if (trashCount) trashCount.textContent = String(trash.length);

    if (!active.length) {
      fileList.innerHTML = '<li class="file-list-empty">No models loaded</li>';
      return;
    }

    fileList.innerHTML = active.map((asset) => {
      const isActive = asset.id === activeId;
      const safeName = this._escapeHtml(asset.name);
      return `
        <li class="file-item ${isActive ? 'active' : ''}" data-asset-id="${asset.id}">
          <span class="file-icon">📦</span>
          <span class="file-name" title="${safeName}">${safeName}</span>
          <span class="file-tag">${asset.type === 'demo' ? 'DEMO' : ((asset.name ? asset.name.split('.').pop() : '') || 'MODEL').toUpperCase()}</span>
          <button type="button" class="file-remove" data-remove-asset-id="${asset.id}" aria-label="Delete ${asset.name || 'Model'}">✕</button>
        </li>
      `;
    }).join('');

    fileList.querySelectorAll('.file-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.file-remove')) return;
        const assetId = item.dataset.assetId;
        this._activateAsset(assetId);
      });
    });

    fileList.querySelectorAll('.file-remove').forEach((button) => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const assetId = button.dataset.removeAssetId;
        if (assetId) {
          assetManager.moveToTrash(assetId);
        }
      });
    });
  }

  renderTrashList() {
    const trashList = document.getElementById('trashList');
    const trashCount = document.getElementById('trashCount');
    if (!trashList) return;

    const { trash } = assetManager.getState();
    if (trashCount) trashCount.textContent = String(trash.length);

    if (!trash.length) {
      trashList.innerHTML = '<li class="trash-empty">Trash is empty</li>';
      return;
    }

    trashList.innerHTML = trash.map((asset) => `
      <li class="trash-item" data-trash-id="${asset.id}">
        <div class="trash-meta">
          <span class="trash-name">${this._escapeHtml(asset.name)}</span>
          <span class="trash-type">${asset.type === 'demo' ? 'Demo asset' : 'Model file'}</span>
        </div>
        <div class="trash-actions">
          <button type="button" class="btn-restore" data-restore-id="${asset.id}">Restore</button>
          <button type="button" class="btn-delete" data-delete-id="${asset.id}">Delete</button>
        </div>
      </li>
    `).join('');

    trashList.querySelectorAll('.btn-restore').forEach((button) => {
      button.addEventListener('click', () => {
        const assetId = button.dataset.restoreId;
        const restored = assetManager.restoreFromTrash(assetId);
        if (restored) {
          this._activateAsset(restored.id);
          this.renderAssetList();
          this.renderTrashList();
        }
      });
    });

    trashList.querySelectorAll('.btn-delete').forEach((button) => {
      button.addEventListener('click', () => {
        const assetId = button.dataset.deleteId;
        assetManager.permanentlyDelete(assetId);
        this.renderTrashList();
      });
    });
  }

  _addFileToList(fileName, fileUrl) {
    assetManager.registerUpload(fileName, fileUrl);
    this.renderAssetList();
  }

  /**
   * Update 3D Inspector Analytics Panel.
   */
  updateInspectorUI() {
    const inspection = modelInspector.inspectModel();

    // Stats
    const infoModelName  = document.getElementById('infoModelName');
    const infoPolyCount  = document.getElementById('infoPolyCount');
    const infoDrawCalls  = document.getElementById('infoDrawCalls');
    const infoDimensions = document.getElementById('infoDimensions');
    const hudPolyCount   = document.getElementById('hudPolyCount');
    const hudMeshCount   = document.getElementById('hudMeshCount');
    const meshSelect     = document.getElementById('meshSelect');
    const meshCountBadge = document.getElementById('meshCountBadge');
    const meshTreeList   = document.getElementById('meshTreeList');
    const texturesList   = document.getElementById('texturesList');

    if (infoModelName)  infoModelName.textContent  = inspection.modelName;
    if (infoPolyCount)  infoPolyCount.textContent  = `${inspection.polyCount.toLocaleString()} Tris / ${inspection.vertCount.toLocaleString()} Verts`;
    if (infoDrawCalls)  infoDrawCalls.textContent  = inspection.drawCalls;
    if (infoDimensions) infoDimensions.textContent = inspection.dimensions;
    if (hudPolyCount)   hudPolyCount.textContent   = inspection.polyCount.toLocaleString();
    if (hudMeshCount)   hudMeshCount.textContent   = inspection.meshCount;
    if (meshCountBadge) meshCountBadge.textContent = `${inspection.meshCount} Nodes`;

    // Populate Target Mesh Dropdown & Node Hierarchy Tree
    if (meshSelect) {
      const currentSelected = meshSelect.value;
      const validTargets = modelInspector.getMaterialTargets();
      meshSelect.innerHTML = '<option value="all">Entire Model (All Meshes)</option>';

      validTargets.forEach((node) => {
        const opt = document.createElement('option');
        opt.value = node.name;
        opt.textContent = `${node.name} (${node.polys} polys)`;
        meshSelect.appendChild(opt);
      });

      const safeValue = validTargets.some((node) => node.name === currentSelected)
        ? currentSelected
        : 'all';
      meshSelect.value = safeValue;
    }

    if (meshTreeList) {
      if (inspection.meshTree.length === 0) {
        meshTreeList.innerHTML = '<div class="tree-empty">No active meshes</div>';
      } else {
        meshTreeList.innerHTML = inspection.meshTree.map(node => `
          <div class="tree-node-item">
            <span class="tree-node-name" title="${this._escapeHtml(node.name)}">${this._escapeHtml(node.name)}</span>
            <span class="tree-node-verts">${node.polys} tris</span>
            <label class="switch small">
              <input type="checkbox" data-mesh="${this._escapeHtml(node.name)}" ${node.visible ? 'checked' : ''} />
              <span class="slider round"></span>
            </label>
          </div>
        `).join('');

        // Wire mesh visibility switches
        meshTreeList.querySelectorAll('input[type="checkbox"]').forEach(chk => {
          chk.addEventListener('change', (e) => {
            modelInspector.toggleMeshVisibility(e.target.dataset.mesh, e.target.checked);
          });
        });
      }
    }

    // Populate Textures List
    if (texturesList) {
      texturesList.innerHTML = inspection.textures.map(tex => `
        <div class="texture-item">
          <span class="tex-type">${this._escapeHtml(tex.type)}</span>
          <span class="tex-info">${this._escapeHtml(tex.name)}</span>
        </div>
      `).join('');
    }
  }
}

const uiManager = new UIManager();
export default uiManager;
