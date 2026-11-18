// Tests du modèle : node tests/project.test.js
'use strict';
const assert = require('assert');
globalThis.crypto ??= require('crypto').webcrypto;
const P = require('../web/project.js');

const pr = P.newProject({ format: 'bd' });
const page = pr.pages[0];
assert.strictEqual(P.pagePanels(page).length, 6, 'classic template has 6 panels');
const L = P.computeLayout(pr, page);
assert.strictEqual(L.panels.length, 6);
for (const r of L.panels) assert(r.x >= 110 - 1e-6 && r.x + r.w <= 2400 - 110 + 1e-6, 'panel inside margins');

// split + remove keep tree flat and nothing lost
const first = P.pagePanels(page)[0];
first.description = 'keep me';
const added = P.splitPanel(page, first.id, 'row');
assert.strictEqual(P.pagePanels(page).length, 7);
assert(P.removePanel(page, added.id));
assert.strictEqual(P.pagePanels(page)[0].description, 'keep me');
assert.strictEqual(P.pagePanels(page).length, 6);

// template change keeps panels
P.applyTemplate(pr, page, 'twoRows');
assert.strictEqual(P.pagePanels(page).length, 6, 'panels kept when template has fewer slots');
assert.strictEqual(P.pagePanels(page)[0].description, 'keep me');

// manga reading order is right to left
const m = P.newProject({ format: 'manga' });
m.pages[0].layout = P.LAYOUT_TEMPLATES.twoCols();
const [a, b] = P.pagePanels(m.pages[0]);
const lm = P.computeLayout(m, m.pages[0]);
const ra = lm.panels.find((p) => p.panelId === a.id);
const rb = lm.panels.find((p) => p.panelId === b.id);
assert(ra.x > rb.x, 'first manga panel is on the right');
assert.strictEqual(lm.dividers.length, 1);
assert(lm.dividers[0].x >= rb.x + rb.w - 1e-6 && lm.dividers[0].x + lm.dividers[0].w <= ra.x + 1e-6, 'rtl divider between panels');

// sizes
for (const preset of ['draft', 'mp1', 'mp2', 'mp4']) {
  for (const [w, h] of [[1, 1], [3, 1], [1, 3], [10, 1], [0.7, 1]]) {
    const [gw, gh] = P.presetSize(preset, w, h);
    assert(P.fitsTiiny(gw, gh), `${preset} ${w}:${h} -> ${gw}x${gh}`);
    if (preset === 'draft') assert(Math.max(gw, gh) <= 512);
  }
}
assert.deepStrictEqual(P.presetSize('mp4', 1, 1), [2048, 2048]);
assert.deepStrictEqual(P.presetSize('mp1', 1, 1), [1024, 1024]);
assert(!P.upscaleAvailable('mp1', 1024, 1024));
assert(P.upscaleAvailable('mp2', 1024, 1024));
assert(P.upscaleAvailable('mp1', 512, 512));

// placement
assert(!P.hasUncovered(1024, 1024, 300, 200, { zoom: 1, x: 0, y: 0 }));
assert(P.hasUncovered(1024, 1024, 300, 200, { zoom: 0.8, x: 0, y: 0 }));
assert(P.hasUncovered(1024, 1024, 300, 200, { zoom: 1, x: 0.2, y: 0 }));

// previous panels across pages
pr.pages.push(P.newPage(pr, 'twoRows'));
const order = P.readingOrder(pr);
const last = order.at(-1).panel;
assert.strictEqual(P.previousPanels(pr, last.id, 3).length, 3);
assert.strictEqual(P.previousPanels(pr, order[0].panel.id).length, 0);

// webtoon height
const w = P.newProject({ format: 'webtoon' });
w.pages[0].height = 5000;
assert.strictEqual(P.pageSize(w, w.pages[0]).height, 5000);
// Fusion : la case gardée reprend rendus, références et description de sa voisine.
{
  const proj = P.newProject({ format: 'bd' });
  const page = proj.pages[0];
  page.layout = P.LAYOUT_TEMPLATES.twoCols();
  const [a, b] = P.pagePanels(page);
  a.description = 'A';
  b.description = 'B';
  b.versions.push({ id: 'v1', assetId: 'x' });
  b.current = 'v1';
  b.refs.push('r1');
  const kept = P.mergePanel(page, a.id);
  assert.strictEqual(kept, a);
  assert.strictEqual(page.layout.kind, 'panel');
  assert.strictEqual(a.description, 'A\nB');
  assert.deepStrictEqual(a.versions.map((v) => v.id), ['v1']);
  assert.strictEqual(a.current, 'v1');
  assert.deepStrictEqual(a.refs, ['r1']);
  assert.strictEqual(P.mergePanel(page, a.id), null, 'nothing left to merge');
}

// Transposition : deux colonnes de deux cases deviennent deux rangées de deux cases, ordre de lecture gardé par rangée.
{
  const proj = P.newProject({ format: 'bd' });
  const page = proj.pages[0];
  page.layout = P.LAYOUT_TEMPLATES.twoCols();
  const [left, right] = P.pagePanels(page);
  const c = P.splitPanel(page, left.id, 'col');
  const d = P.splitPanel(page, right.id, 'col');
  assert.deepStrictEqual(P.pagePanels(page).map((p) => p.id), [left.id, c.id, right.id, d.id]);
  const target = P.transposableFor(page, P.findLeaf(page, c.id).node.id);
  assert.strictEqual(target.id, page.layout.id);
  assert(P.transposeSplit(page, target.id));
  assert.strictEqual(page.layout.dir, 'col');
  assert.deepStrictEqual(P.pagePanels(page).map((p) => p.id), [left.id, right.id, c.id, d.id]);
  assert(P.transposeSplit(page, page.layout.id), 'and back');
  assert.strictEqual(page.layout.dir, 'row');
}

// Webtoon : ajout d'une rangée en bas, la bande grandit d'autant.
{
  const proj = P.newProject({ format: 'webtoon' });
  const page = proj.pages[0];
  const before = P.pageSize(proj, page).height;
  const count = P.pagePanels(page).length;
  const added = P.appendRow(proj, page, 600);
  assert(added);
  assert.strictEqual(P.pageSize(proj, page).height, before + 600);
  assert.strictEqual(P.pagePanels(page).length, count + 1);
  assert.strictEqual(P.pagePanels(page).at(-1).id, added.id);
  const sum = page.layout.ratios.reduce((x, y) => x + y, 0);
  assert(Math.abs(sum - 1) < 1e-9);
}

console.log('project tests: OK');
