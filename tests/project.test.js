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
console.log('project tests: OK');
