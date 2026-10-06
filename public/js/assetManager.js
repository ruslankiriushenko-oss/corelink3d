/**
 * CoreLink 3D — Asset Library & Recycle Bin
 * Soft-delete assets to trash; restore or permanently purge.
 */

import viewer3d from './viewer3d.js';
import { clearSavedModelFile, getSavedModelFile } from './modelStorage.js';

class AssetManager {
  constructor() {
    /** @type {Array<{id:string,name:string,url:string|null,type:'demo'|'upload',addedAt:number}>} */
    this.activeAssets = [];
    /** @type {Array<{id:string,name:string,url:string|null,type:'demo'|'upload',deletedAt:number}>} */
    this.trashAssets = [];
    this.activeAssetId = null;
    this._listeners = [];
  }

  onChange(fn) {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter((f) => f !== fn);
    };
  }

  _notify() {
    this._listeners.forEach((fn) => fn(this.getState()));
  }

  getState() {
    return {
      active: [...this.activeAssets],
      trash: [...this.trashAssets],
      activeId: this.activeAssetId,
    };
  }

  registerDemo(name = 'SciFi_Core_Demo.glb') {
    const existing = this.activeAssets.find((a) => a.type === 'demo');
    if (existing) {
      this.activeAssetId = existing.id;
      return existing;
    }
    const asset = {
      id: `demo-${Date.now()}`,
      name,
      url: null,
      type: 'demo',
      addedAt: Date.now(),
    };
    this.activeAssets.unshift(asset);
    this.activeAssetId = asset.id;
    this._notify();
    return asset;
  }

  registerUpload(name, url) {
    const asset = {
      id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      url,
      type: 'upload',
      addedAt: Date.now(),
    };
    this.activeAssets.unshift(asset);
    this.activeAssetId = asset.id;
    this._notify();
    return asset;
  }

  getActiveAsset() {
    return this.activeAssets.find((a) => a.id === this.activeAssetId) || null;
  }

  async activateAsset(assetId) {
    const asset = this.activeAssets.find((a) => a.id === assetId);
    if (!asset) return false;

    this.activeAssetId = assetId;

    // Do NOT manipulate the Three.js viewer while the WebGPU editor is open.
    // The editor owns its own isolated scene and the viewer is paused.
    const editorIsOpen = window.webgpuEditor && window.webgpuEditor.isOpen;
    if (!editorIsOpen) {
      if (asset.type === 'demo') {
        clearSavedModelFile().catch((error) => console.warn('[AssetManager] Could not clear saved model:', error));
        viewer3d.createDemoModel();
      } else if (asset.url) {
        await viewer3d.loadModel(asset.url);
      } else {
        const savedModel = await getSavedModelFile();
        if (savedModel?.blob) await viewer3d.loadModelFromFile(savedModel.blob);
      }
    }

    this._notify();
    return true;
  }

  moveToTrash(assetId) {
    const idx = this.activeAssets.findIndex((a) => a.id === assetId);
    if (idx === -1) return false;

    const [asset] = this.activeAssets.splice(idx, 1);
    this.trashAssets.unshift({
      ...asset,
      deletedAt: Date.now(),
    });

    if (this.activeAssetId === assetId) {
      if (asset.type === 'upload') {
        clearSavedModelFile().catch((error) => console.warn('[AssetManager] Could not clear saved model:', error));
      }
      this.activeAssetId = this.activeAssets[0]?.id || null;

      // Do NOT manipulate the Three.js viewer while the WebGPU editor is open.
      // The editor owns its own isolated scene; the viewer is paused.
      const editorIsOpen = window.webgpuEditor && window.webgpuEditor.isOpen;
      if (!editorIsOpen) {
        if (this.activeAssets[0]) {
          this.activateAsset(this.activeAssets[0].id).catch(console.error);
        } else {
          viewer3d.clearModel();
        }
      }
    }

    this._notify();
    return true;
  }

  restoreFromTrash(assetId) {
    const idx = this.trashAssets.findIndex((a) => a.id === assetId);
    if (idx === -1) return false;

    const { deletedAt, ...asset } = this.trashAssets.splice(idx, 1)[0];
    this.activeAssets.unshift(asset);
    this.activeAssetId = asset.id;
    this._notify();
    return asset;
  }

  permanentlyDelete(assetId) {
    const idx = this.trashAssets.findIndex((a) => a.id === assetId);
    if (idx === -1) return false;
    this.trashAssets.splice(idx, 1);
    this._notify();
    return true;
  }

  emptyTrash() {
    this.trashAssets = [];
    this._notify();
  }
}

const assetManager = new AssetManager();
export default assetManager;
