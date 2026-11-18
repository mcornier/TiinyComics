// Stockage persistant des projets et de leurs images (IndexedDB).
// Contrairement à TiinyPaint, rien n'est purgé à la fermeture : tout ce qui est généré est conservé
// (rendus, versions, croquis, masques), tant que le projet existe.
'use strict';

const DB_NAME = 'tiinycomics';
const DB_VERSION = 1;

function idbDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function idbResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

class ComicStore {
  constructor() {
    this.db = null;
    // URL d'objet par image, pour l'affichage. Révoquées à la suppression.
    this.urls = new Map();
    this.meta = new Map();
  }

  async open() {
    if (this.db) return this.db;
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      const assets = db.createObjectStore('assets', { keyPath: 'id' });
      assets.createIndex('project', 'projectId');
    };
    this.db = await idbResult(request);
    return this.db;
  }

  /* ---------- Projets ---------- */

  async listProjects() {
    await this.open();
    const all = await idbResult(this.db.transaction('projects').objectStore('projects').getAll());
    return all
      .map(({ id, title, format, updatedAt, createdAt }) => ({ id, title, format, updatedAt, createdAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async loadProject(id) {
    await this.open();
    return idbResult(this.db.transaction('projects').objectStore('projects').get(id));
  }

  async saveProject(project) {
    await this.open();
    project.updatedAt = Date.now();
    const tx = this.db.transaction('projects', 'readwrite');
    // Copie JSON : le projet en mémoire peut changer pendant l'écriture.
    tx.objectStore('projects').put(JSON.parse(JSON.stringify(project)));
    await idbDone(tx);
  }

  async deleteProject(id) {
    await this.open();
    const tx = this.db.transaction(['projects', 'assets'], 'readwrite');
    tx.objectStore('projects').delete(id);
    const index = tx.objectStore('assets').index('project');
    index.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      tx.objectStore('assets').delete(cursor.primaryKey);
      this._forget(cursor.primaryKey);
      cursor.continue();
    };
    await idbDone(tx);
  }

  /* ---------- Images ---------- */

  // kind : 'ref' (référence importée), 'render' (rendu), 'sketch', 'mask', 'import'.
  async addAsset(projectId, blob, { kind = 'render', name = '', width = 0, height = 0 } = {}) {
    await this.open();
    if (!width || !height) ({ width, height } = await blobSize(blob));
    const asset = { id: TC_PROJECT.uid(), projectId, blob, kind, name, width, height, createdAt: Date.now() };
    const tx = this.db.transaction('assets', 'readwrite');
    tx.objectStore('assets').put(asset);
    await idbDone(tx);
    this.meta.set(asset.id, { width, height, kind, name });
    return asset;
  }

  async getAsset(id) {
    await this.open();
    const asset = await idbResult(this.db.transaction('assets').objectStore('assets').get(id));
    if (asset) this.meta.set(id, { width: asset.width, height: asset.height, kind: asset.kind, name: asset.name });
    return asset || null;
  }

  async blob(id) {
    return (await this.getAsset(id))?.blob || null;
  }

  // URL affichable (blob:). Mise en cache : un même rendu affiché partout ne coûte qu'une lecture.
  async url(id) {
    if (!id) return null;
    if (this.urls.has(id)) return this.urls.get(id);
    const asset = await this.getAsset(id);
    if (!asset) return null;
    const url = URL.createObjectURL(asset.blob);
    this.urls.set(id, url);
    return url;
  }

  cachedUrl(id) {
    return this.urls.get(id) || null;
  }

  size(id) {
    return this.meta.get(id) || null;
  }

  // Data URI PNG (ou JPEG pour réduire), éventuellement réduit : c'est ce qu'attend l'API du Tiiny.
  async dataUrl(id, { maxSide = 2048, type = 'image/png', quality } = {}) {
    const blob = await this.blob(id);
    if (!blob) return null;
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas.toDataURL(type, quality);
  }

  async projectAssets(projectId) {
    await this.open();
    return idbResult(this.db.transaction('assets').objectStore('assets').index('project').getAll(projectId));
  }

  async putAssetRecord(asset) {
    await this.open();
    const tx = this.db.transaction('assets', 'readwrite');
    tx.objectStore('assets').put(asset);
    await idbDone(tx);
  }

  // Suppression explicite seulement (jamais automatique) : l'image ne doit plus être référencée.
  async deleteAsset(id) {
    await this.open();
    const tx = this.db.transaction('assets', 'readwrite');
    tx.objectStore('assets').delete(id);
    await idbDone(tx);
    this._forget(id);
  }

  _forget(id) {
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    this.meta.delete(id);
  }

  // Le navigateur peut vider IndexedDB sous pression d'espace, sauf si le stockage est persistant.
  async requestPersistence() {
    try {
      return (await navigator.storage?.persist?.()) || false;
    } catch {
      return false;
    }
  }

  /* ---------- Fichier de projet ---------- */

  // Un fichier .tiinycomic : le projet et toutes ses images en data URI, dans un seul JSON.
  async exportProjectFile(project) {
    const assets = await this.projectAssets(project.id);
    const files = {};
    for (const a of assets) {
      files[a.id] = { kind: a.kind, name: a.name, width: a.width, height: a.height, createdAt: a.createdAt, data: await blobToDataUrl(a.blob) };
    }
    return new Blob([JSON.stringify({ app: 'tiinycomics', version: 1, project, assets: files })], { type: 'application/json' });
  }

  // Importe sous un nouvel identifiant de projet : on peut ouvrir deux fois le même fichier.
  async importProjectFile(file) {
    const data = JSON.parse(await file.text());
    if (data.app !== 'tiinycomics' || !data.project) throw new Error('Not a TiinyComics project');
    // Les images reçoivent aussi de nouveaux identifiants (des UUID : un remplacement textuel est sûr),
    // sinon un second import écraserait celles du premier.
    const remap = new Map(Object.keys(data.assets || {}).map((id) => [id, TC_PROJECT.uid()]));
    let json = JSON.stringify(data.project);
    for (const [from, to] of remap) json = json.split(from).join(to);
    const project = JSON.parse(json);
    project.id = TC_PROJECT.uid();
    for (const [oldId, a] of Object.entries(data.assets || {})) {
      const id = remap.get(oldId);
      const blob = await (await fetch(a.data)).blob();
      await this.putAssetRecord({ id, projectId: project.id, blob, kind: a.kind, name: a.name, width: a.width, height: a.height, createdAt: a.createdAt });
    }
    await this.saveProject(project);
    return project;
  }
}

async function blobSize(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
