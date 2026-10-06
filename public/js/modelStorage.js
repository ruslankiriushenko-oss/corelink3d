import { sanitizeModelFilename, validateModelFile } from './modelValidation.js';

const DB_NAME = 'corelink3d-storage';
const DB_VERSION = 3; // Увеличил версию, чтобы пересоздать базу
const STORE_NAME = 'models';
const MODEL_KEY = 'last-model';
const SCENE_KEY = 'editor-scene';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function runTransaction(mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function saveModelFile(file, optionalName) {
  if (!file) return;
  const fileName = sanitizeModelFilename(optionalName || file.name || (file instanceof File ? file.name : 'model.glb'));
  await validateModelFile(file, fileName);
  const extension = (fileName ? fileName.split('.').pop() : 'glb').toLowerCase();
  return runTransaction('readwrite', (store) => store.put({
    name: fileName,
    type: file.type || 'application/octet-stream',
    extension,
    blob: file,
    savedAt: Date.now(),
  }, MODEL_KEY));
}

export async function getSavedModelFile() {
  return runTransaction('readonly', (store) => store.get(MODEL_KEY));
}

export async function clearSavedModelFile() {
  return runTransaction('readwrite', (store) => store.delete(MODEL_KEY));
}

export async function saveEditorSceneState(scene) {
  return runTransaction('readwrite', (store) => store.put({
    scene,
    savedAt: Date.now(),
  }, SCENE_KEY));
}

export async function getSavedEditorSceneState() {
  return runTransaction('readonly', (store) => store.get(SCENE_KEY));
}

export async function clearSavedEditorSceneState() {
  return runTransaction('readwrite', (store) => store.delete(SCENE_KEY));
}

export async function saveEditorModelFile(file, optionalName) {
  if (!file) return;
  const fileName = sanitizeModelFilename(optionalName || file.name || (file instanceof File ? file.name : 'Editor_Model.glb'));
  const extension = (fileName ? fileName.split('.').pop() : 'glb').toLowerCase();
  return runTransaction('readwrite', (store) => store.put({
    name: fileName,
    type: file.type || 'application/octet-stream',
    extension,
    blob: file,
    savedAt: Date.now(),
  }, MODEL_KEY));
}

export async function getSavedEditorModelFile() {
  return runTransaction('readonly', (store) => store.get(MODEL_KEY));
}

export async function clearSavedEditorModelFile() {
  return runTransaction('readwrite', (store) => store.delete(MODEL_KEY));
}
