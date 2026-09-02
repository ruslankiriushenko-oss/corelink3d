const DB_NAME = 'corelink3d-storage';
const STORE_NAME = 'models';
const MODEL_KEY = 'last-model';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
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

export async function saveModelFile(file) {
  return runTransaction('readwrite', (store) => store.put({
    name: file.name,
    type: file.type || 'application/octet-stream',
    extension: file.name.split('.').pop().toLowerCase(),
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