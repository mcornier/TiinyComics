// Export des pages : rendu sur canvas, PNG, ZIP de PNG, PDF et bande webtoon.
// Le ZIP et le PDF sont écrits à la main (aucune dépendance) ; ces parties sont pures et testées avec Node.
'use strict';

// Module fermé : seuls les noms de ComicExport sont globaux (les scripts partagent la portée globale).
const ComicExport = (() => {
  // Résolution d'impression par format, pour la taille physique des pages PDF.
  // bd : 100 px/cm = 254 dpi. webtoon : lu à l'écran, 96 dpi.
  const EXPORT_DPI = { bd: 254, comics: 300, manga: 300, webtoon: 96 };

  // Hauteur maximale d'une image webtoon : Chrome refuse les canvas de plus de 32767 px de haut
  // ou de plus de ~268 millions de pixels.
  const MAX_CANVAS_HEIGHT = 32000;
  const MAX_CANVAS_AREA = 268000000;

  /* ---------- CRC-32 et ZIP ---------- */

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Date et heure au format DOS, celui des en-têtes ZIP.
  function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  // ZIP sans compression (méthode « store ») : les PNG sont déjà compressés.
  // entries : [{ name, data: Uint8Array }]. Noms en UTF-8 (bit 11 des drapeaux).
  function zipFiles(entries, date = new Date()) {
    const enc = new TextEncoder();
    const { time, day } = dosDateTime(date);
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
      const name = enc.encode(entry.name);
      const data = entry.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, time, true);
      lv.setUint16(12, day, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, day, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);
      locals.push(local, data);
      centrals.push(central);
      offset += local.length + data.length;
    }
    const centralSize = centrals.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return concatBytes([...locals, ...centrals, end]);
  }

  function concatBytes(chunks) {
    const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  /* ---------- PDF ---------- */

  // Chaîne PDF : littérale si ASCII imprimable, sinon UTF-16BE en hexadécimal avec BOM (seul encodage Unicode de PDF 1.4).
  function pdfString(text) {
    const s = String(text ?? '');
    if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
    let hex = 'FEFF';
    for (let i = 0; i < s.length; i += 1) hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    return `<${hex}>`;
  }

  const pdfNum = (n) => String(Math.round(n * 100) / 100);

  // PDF 1.4 : une page par image JPEG (DCTDecode), étirée sur toute la page.
  // pages : [{ jpeg: Uint8Array, pxW, pxH, ptW, ptH }]. Construit en octets : le JPEG est binaire et les
  // décalages de la table xref doivent être exacts.
  function buildPdf(pages, { title = '', rtl = false } = {}) {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let size = 0;
    const push = (bytes) => {
      chunks.push(bytes);
      size += bytes.length;
    };
    const text = (s) => push(enc.encode(s));
    const obj = (n, body) => {
      offsets[n] = size;
      text(`${n} 0 obj\n${body}\nendobj\n`);
    };
    // Objets : 1 catalogue, 2 arbre des pages, 3 infos, puis 3 objets par page (page, contenu, image).
    const pageObj = (i) => 4 + i * 3;
    // En-tête avec octets > 127 : signale aux outils que le fichier est binaire.
    push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    const prefs = rtl ? ' /ViewerPreferences << /Direction /R2L >>' : '';
    obj(1, `<< /Type /Catalog /Pages 2 0 R${prefs} >>`);
    obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`);
    obj(3, `<< /Title ${pdfString(title)} /Producer (TiinyComics) >>`);
    pages.forEach((p, i) => {
      const n = pageObj(i);
      const w = pdfNum(p.ptW);
      const h = pdfNum(p.ptH);
      obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
      const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
      obj(n + 1, `<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream`);
      offsets[n + 2] = size;
      text(`${n + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.pxW} /Height ${p.pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      text('\nendstream\nendobj\n');
    });
    const count = 4 + pages.length * 3;
    const xref = size;
    // Chaque entrée de la table fait exactement 20 octets.
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let n = 1; n < count; n += 1) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    text(`${table}trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return concatBytes(chunks);
  }

  /* ---------- Canvas ---------- */

  function makeExportCanvas(w, h) {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }
    return new OffscreenCanvas(w, h);
  }

  function canvasBlob(canvas, type = 'image/png', quality) {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), type, quality);
    });
  }

  const blobBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

  // Rendu d'une page : fond, images cadrées dans leurs cases, puis contour noir dessiné à l'intérieur des cases.
  async function renderPage(project, page, store, { scale = 1, background = '#ffffff', drawEmpty = false } = {}) {
    const P = TC_PROJECT;
    const { width, height } = P.pageSize(project, page);
    const canvas = makeExportCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const layout = P.computeLayout(project, page);
    const border = P.pageSpacing(project).border * scale;
    for (const rect of layout.panels) {
      const x = rect.x * scale;
      const y = rect.y * scale;
      const w = rect.w * scale;
      const h = rect.h * scale;
      const version = P.currentVersion(rect.panel);
      const blob = version?.assetId ? await store.blob(version.assetId) : null;
      let bitmap = null;
      try {
        bitmap = blob ? await createImageBitmap(blob) : null;
      } catch {
        bitmap = null; // image illisible : la case est rendue vide plutôt que de faire échouer l'export
      }
      // Les parties de la case non couvertes par l'image restent blanches, quel que soit le fond.
      ctx.fillStyle = bitmap || !drawEmpty ? '#ffffff' : '#e6e6e6';
      ctx.fillRect(x, y, w, h);
      if (bitmap) {
        const r = P.placeImage(bitmap.width, bitmap.height, rect.w, rect.h, rect.panel.placement);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.drawImage(bitmap, x + r.x * scale, y + r.y * scale, r.w * scale, r.h * scale);
        ctx.restore();
        bitmap.close();
      }
      if (border > 0) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = border;
        ctx.strokeRect(x + border / 2, y + border / 2, Math.max(0, w - border), Math.max(0, h - border));
      }
    }
    return canvas;
  }

  const pad3 = (n) => String(n).padStart(3, '0');

  async function exportPagePng(project, pageIndex, store, opts) {
    const canvas = await renderPage(project, project.pages[pageIndex], store, opts);
    return canvasBlob(canvas, 'image/png');
  }

  async function exportAllPng(project, store, opts) {
    const entries = [];
    for (let i = 0; i < project.pages.length; i += 1) {
      entries.push({ name: `page-${pad3(i + 1)}.png`, data: await blobBytes(await exportPagePng(project, i, store, opts)) });
    }
    return new Blob([zipFiles(entries)], { type: 'application/zip' });
  }

  async function exportPdf(project, store, { scale = 1, quality = 0.92 } = {}) {
    const P = TC_PROJECT;
    const dpi = EXPORT_DPI[project.format] || EXPORT_DPI.bd;
    const pages = [];
    for (const page of project.pages) {
      const canvas = await renderPage(project, page, store, { scale });
      const jpeg = await blobBytes(await canvasBlob(canvas, 'image/jpeg', quality));
      // Taille physique indépendante de l'échelle : l'échelle ne change que la résolution de l'image.
      const { width, height } = P.pageSize(project, page);
      pages.push({ jpeg, pxW: canvas.width, pxH: canvas.height, ptW: (width / dpi) * 72, ptH: (height / dpi) * 72 });
    }
    const bytes = buildPdf(pages, { title: project.title || '', rtl: !!P.formatOf(project).rtl });
    return new Blob([bytes], { type: 'application/pdf' });
  }

  // Webtoon : toutes les bandes empilées en une seule image. Au-delà des limites du canvas,
  // ZIP de tranches consécutives. Chaque bande n'est rendue qu'une fois.
  async function exportWebtoonLong(project, store, opts = {}) {
    const scale = opts.scale ?? 1;
    const P = TC_PROJECT;
    const width = Math.max(1, Math.round(P.formatOf(project).width * scale));
    const heights = project.pages.map((page) => Math.max(1, Math.round(P.pageSize(project, page).height * scale)));
    const total = heights.reduce((a, b) => a + b, 0);
    const sliceMax = Math.min(MAX_CANVAS_HEIGHT, Math.floor(MAX_CANVAS_AREA / width));
    const slices = [];
    for (let y = 0; y < total; y += sliceMax) slices.push([y, Math.min(total, y + sliceMax)]);
    const tops = [];
    heights.reduce((top, h, i) => ((tops[i] = top), top + h), 0);
    let cached = { index: -1, canvas: null };
    const pageCanvas = async (i) => {
      if (cached.index !== i) cached = { index: i, canvas: await renderPage(project, project.pages[i], store, opts) };
      return cached.canvas;
    };
    const blobs = [];
    for (const [y0, y1] of slices) {
      const canvas = makeExportCanvas(width, y1 - y0);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = opts.background || '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < heights.length; i += 1) {
        if (tops[i] + heights[i] <= y0 || tops[i] >= y1) continue;
        ctx.drawImage(await pageCanvas(i), 0, tops[i] - y0);
      }
      blobs.push(await canvasBlob(canvas, 'image/png'));
    }
    if (blobs.length === 1) return { blob: blobs[0], kind: 'png' };
    const entries = [];
    for (let i = 0; i < blobs.length; i += 1) entries.push({ name: `part-${pad3(i + 1)}.png`, data: await blobBytes(blobs[i]) });
    return { blob: new Blob([zipFiles(entries)], { type: 'application/zip' }), kind: 'zip' };
  }

  /* ---------- Fichiers ---------- */

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Révocation différée : le navigateur doit avoir commencé le téléchargement.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // Nom de fichier sûr tiré du titre : sans accents, minuscules, tirets.
  function fileName(project, suffix, ext) {
    const base = String(project?.title || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      .slice(0, 60).replace(/-+$/, '') || 'tiinycomics';
    return `${base}${suffix ? `-${suffix}` : ''}.${ext}`;
  }

  return {
    EXPORT_DPI, MAX_CANVAS_HEIGHT,
    crc32, zipFiles, buildPdf, pdfString, fileName,
    renderPage, exportPagePng, exportAllPng, exportPdf, exportWebtoonLong, download,
  };
})();

if (typeof module !== 'undefined') module.exports = ComicExport;
