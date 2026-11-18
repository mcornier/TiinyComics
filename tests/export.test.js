// Tests de l'export (ZIP, PDF, noms de fichiers, rendu avec un faux canvas) : node tests/export.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
globalThis.crypto ??= require('crypto').webcrypto;
globalThis.TC_PROJECT = require('../web/project.js');
const E = require('../web/export.js');

const enc = new TextEncoder();
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

// CRC-32 : valeurs de référence
assert.strictEqual(E.crc32(enc.encode('123456789')), 0xcbf43926);
assert.strictEqual(E.crc32(new Uint8Array(0)), 0);
assert.strictEqual(E.crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);

// ZIP : relu par le module zipfile de Python
const files = [
  { name: 'page-001.png', data: enc.encode('hello') },
  { name: 'page-002.png', data: new Uint8Array([0, 1, 2, 255, 254]) },
  { name: 'déjà-vu.txt', data: new Uint8Array(0) },
];
const zip = E.zipFiles(files);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-export-'));
const zipPath = path.join(dir, 'test.zip');
fs.writeFileSync(zipPath, zip);
let python = null;
for (const cmd of ['python', 'python3', 'py']) {
  try {
    execFileSync(cmd, ['-I', '-c', 'pass'], { stdio: 'ignore' });
    python = cmd;
    break;
  } catch { /* essai suivant */ }
}
if (python) {
  const script = 'import sys,zipfile,json\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\n'
    + 'print(json.dumps([[i.filename,i.compress_type,list(z.read(i))] for i in z.infolist()]))';
  const out = JSON.parse(execFileSync(python, ['-I', '-c', script, zipPath], { encoding: 'utf8' }));
  assert.deepStrictEqual(out.map((e) => e[0]), files.map((f) => f.name), 'UTF-8 names');
  out.forEach((e, i) => {
    assert.strictEqual(e[1], 0, 'stored');
    assert.deepStrictEqual(e[2], [...files[i].data]);
  });
} else {
  console.log('python not found: zipfile check skipped');
}
fs.rmSync(dir, { recursive: true, force: true });
// EOCD : nombre d'entrées et position du répertoire central
const dv = new DataView(zip.buffer);
assert.strictEqual(dv.getUint32(zip.length - 22, true), 0x06054b50);
assert.strictEqual(dv.getUint16(zip.length - 12, true), 3);
assert.strictEqual(dv.getUint32(zip.length - 6, true) + dv.getUint32(zip.length - 10, true), zip.length - 22);

// PDF : structure et décalages xref
const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x80, 0x0a, 0x65, 0x6e, 0x64, 0xff, 0xd9]);
const checkPdf = (bytes, pageCount) => {
  const s = latin1(bytes);
  assert(s.startsWith('%PDF-1.4\n'));
  assert(s.endsWith('%%EOF\n'));
  const startxref = Number(s.match(/startxref\n(\d+)\n%%EOF\n$/)[1]);
  assert.strictEqual(s.slice(startxref, startxref + 5), 'xref\n');
  const [, first, count] = s.slice(startxref).match(/^xref\n(\d+) (\d+)\n/).map(Number);
  assert.strictEqual(first, 0);
  assert.strictEqual(count, 4 + pageCount * 3);
  const tableStart = startxref + `xref\n0 ${count}\n`.length;
  for (let n = 0; n < count; n += 1) {
    const entry = s.slice(tableStart + n * 20, tableStart + n * 20 + 20);
    assert.strictEqual(entry.length, 20);
    if (n === 0) {
      assert.strictEqual(entry, '0000000000 65535 f \n');
      continue;
    }
    const off = Number(entry.slice(0, 10));
    assert.strictEqual(s.slice(off, off + `${n} 0 obj`.length), `${n} 0 obj`, `xref offset of object ${n}`);
  }
  assert(s.includes(`/Count ${pageCount}`));
  assert(s.includes(`/Size ${count} /Root 1 0 R /Info 3 0 R`));
  return s;
};
const pdf = E.buildPdf([
  { jpeg: fakeJpeg, pxW: 2400, pxH: 3200, ptW: 680.31, ptH: 907.09 },
  { jpeg: fakeJpeg, pxW: 1200, pxH: 1600, ptW: 680.31, ptH: 907.09 },
], { title: 'Mon (petit) \\ album', rtl: false });
const s1 = checkPdf(pdf, 2);
assert(s1.includes('/Title (Mon \\(petit\\) \\\\ album)'));
assert(s1.includes('/Producer (TiinyComics)'));
assert(s1.includes('/MediaBox [0 0 680.31 907.09]'));
assert(s1.includes('/Width 1200 /Height 1600'));
assert(s1.includes(`/Filter /DCTDecode /Length ${fakeJpeg.length}`));
assert(s1.includes(latin1(fakeJpeg)), 'JPEG bytes copied verbatim');
assert(!s1.includes('/Direction /R2L'));
const s2 = checkPdf(E.buildPdf([{ jpeg: fakeJpeg, pxW: 10, pxH: 10, ptW: 10, ptH: 10 }], { title: 'Ōkami 狼', rtl: true }), 1);
assert(s2.includes('/ViewerPreferences << /Direction /R2L >>'));
assert(s2.includes('/Title <FEFF014C006B0061006D0069002072FC>'));
assert.strictEqual(E.pdfString(''), '()');
checkPdf(E.buildPdf([], {}), 0);

// Noms de fichiers
assert.strictEqual(E.fileName({ title: 'My Comic' }, 'page-001', 'png'), 'my-comic-page-001.png');
assert.strictEqual(E.fileName({ title: 'L\'Été à Paris !' }, '', 'pdf'), 'l-ete-a-paris.pdf');
assert.strictEqual(E.fileName({ title: '狼' }, 'pages', 'zip'), 'tiinycomics-pages.zip');
assert.strictEqual(E.fileName({}, null, 'pdf'), 'tiinycomics.pdf');

// Rendu avec un faux canvas : ordre des opérations et géométrie
const ops = [];
class FakeCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.ctx = new Proxy({}, {
      get: (target, key) => (key in target ? target[key] : (...args) => ops.push([key, ...args])),
      set: (target, key, value) => {
        ops.push([`=${String(key)}`, value]);
        return true;
      },
    });
  }
  getContext() { return this.ctx; }
  async convertToBlob({ type }) { return new Blob([enc.encode(`${type}:${this.width}x${this.height}`)], { type }); }
}
globalThis.OffscreenCanvas = FakeCanvas;
let closed = 0;
globalThis.createImageBitmap = async () => ({ width: 100, height: 50, close: () => { closed += 1; } });
const store = { blob: async (id) => (id === 'a1' ? new Blob(['x']) : null) };

(async () => {
  const P = TC_PROJECT;
  const pr = P.newProject({ format: 'bd', title: 'Test' });
  pr.pages[0].layout = P.LAYOUT_TEMPLATES.twoCols();
  const [p1] = P.pagePanels(pr.pages[0]);
  p1.versions.push({ id: 'v1', assetId: 'a1', width: 100, height: 50 });
  p1.current = 'v1';
  const canvas = await E.renderPage(pr, pr.pages[0], store, { scale: 0.5, drawEmpty: true });
  assert.strictEqual(canvas.width, 1200);
  assert.strictEqual(canvas.height, 1600);
  assert.strictEqual(closed, 1, 'bitmap closed');
  const draws = ops.filter((o) => o[0] === 'drawImage');
  assert.strictEqual(draws.length, 1);
  const rect = P.computeLayout(pr, pr.pages[0]).panels[0];
  const r = P.placeImage(100, 50, rect.w, rect.h, p1.placement);
  assert.deepStrictEqual(draws[0].slice(2).map((v) => Math.round(v)),
    [rect.x * 0.5 + r.x * 0.5, rect.y * 0.5 + r.y * 0.5, r.w * 0.5, r.h * 0.5].map(Math.round));
  assert.strictEqual(ops.filter((o) => o[0] === 'strokeRect').length, 2);
  assert(ops.some((o) => o[0] === '=lineWidth' && o[1] === 3), 'border 6 at scale 0.5');
  assert(ops.some((o) => o[0] === '=fillStyle' && o[1] === '#e6e6e6'), 'empty panel grey');

  // PDF complet : taille physique de la bd (24 × 32 cm)
  const pdfBlob = await E.exportPdf(pr, store, { scale: 0.25 });
  const s = checkPdf(new Uint8Array(await pdfBlob.arrayBuffer()), 1);
  assert(s.includes('/MediaBox [0 0 680.31 907.09]'));
  assert(s.includes('/Width 600 /Height 800'));

  // ZIP de toutes les pages
  pr.pages.push(P.newPage(pr));
  const zipBlob = await E.exportAllPng(pr, store);
  assert(latin1(new Uint8Array(await zipBlob.arrayBuffer())).includes('page-002.png'));

  // Webtoon : une image si la hauteur tient, sinon des tranches de 32000 px au plus
  const wt = P.newProject({ format: 'webtoon' });
  wt.pages[0].height = 20000;
  wt.pages.push(P.newPage(wt));
  wt.pages[1].height = 10000;
  let res = await E.exportWebtoonLong(wt, store);
  assert.strictEqual(res.kind, 'png');
  assert.strictEqual(await res.blob.text(), 'image/png:800x30000');
  wt.pages.push(P.newPage(wt));
  wt.pages[2].height = 15000;
  ops.length = 0;
  res = await E.exportWebtoonLong(wt, store);
  assert.strictEqual(res.kind, 'zip');
  const zs = latin1(new Uint8Array(await res.blob.arrayBuffer()));
  assert(zs.includes('image/png:800x32000') && zs.includes('image/png:800x13000'));
  assert(zs.includes('part-001.png') && zs.includes('part-002.png'));
  // La bande 3 chevauche les deux tranches : rendue une seule fois, dessinée deux fois
  const pageDraws = ops.filter((o) => o[0] === 'drawImage' && o[1] instanceof FakeCanvas);
  assert.deepStrictEqual(pageDraws.map((o) => o[3]), [0, 20000, 30000, -2000]);
  assert.strictEqual(new Set(pageDraws.map((o) => o[1])).size, 3);

  console.log('export tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
