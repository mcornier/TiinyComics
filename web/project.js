// Modèle d'un projet de BD : formats, pages, découpage en cases, géométrie et tailles de rendu.
// Logique pure, sans DOM : testable avec Node (voir tests/project.test.js).
'use strict';

/* ---------- Formats de page ---------- */

// Unités de page : des pixels « d'impression ». L'export rend à cette taille, multipliée par l'échelle choisie.
// bd : album franco-belge 24 × 32 cm à 100 px/cm. comics : 6,625 × 10,25 in à 300 dpi.
// manga : tankōbon B6 (128 × 182 mm), lu de droite à gauche. webtoon : bandes de 800 px, hauteur libre.
const FORMATS = {
  bd: { width: 2400, height: 3200, margin: 110, gutter: 44, border: 6, rtl: false, scroll: false },
  comics: { width: 1988, height: 3075, margin: 96, gutter: 40, border: 6, rtl: false, scroll: false },
  manga: { width: 1500, height: 2133, margin: 80, gutter: 36, border: 4, rtl: true, scroll: false },
  webtoon: { width: 800, height: 2400, margin: 0, gutter: 80, border: 0, rtl: false, scroll: true },
};
const FORMAT_IDS = Object.keys(FORMATS);
const WEBTOON_MIN_HEIGHT = 400;
const WEBTOON_MAX_HEIGHT = 20000;

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

function formatOf(project) {
  return FORMATS[project.format] || FORMATS.bd;
}

// Dimensions réelles d'une page : en webtoon, chaque page (bande) a sa propre hauteur.
function pageSize(project, page) {
  const f = formatOf(project);
  const height = f.scroll ? clamp(Math.round(page.height || f.height), WEBTOON_MIN_HEIGHT, WEBTOON_MAX_HEIGHT) : f.height;
  return { width: f.width, height };
}

function pageSpacing(project) {
  const f = formatOf(project);
  return {
    margin: project.margin ?? f.margin,
    gutter: project.gutter ?? f.gutter,
    // Trait noir autour des cases, en unités de page (0 : pas de trait, l'usage en webtoon).
    border: project.border ?? f.border,
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- Création ---------- */

function newPanel() {
  return {
    id: uid(),
    description: '',
    refs: [],
    versions: [],
    current: null,
    // Cadrage de l'image dans la case : zoom 1 = l'image couvre exactement la case, x/y en fraction de la case.
    placement: { zoom: 1, x: 0, y: 0 },
    enhanced: null,
    sketch: null,
  };
}

const leaf = (panel = newPanel()) => ({ id: uid(), kind: 'panel', panel });

// dir 'row' : enfants côte à côte (de gauche à droite, ou de droite à gauche en manga).
// dir 'col' : enfants empilés de haut en bas.
function split(dir, children, ratios) {
  const n = children.length;
  return { id: uid(), kind: 'split', dir, children, ratios: ratios ? normalize(ratios) : Array(n).fill(1 / n) };
}

function normalize(ratios) {
  const sum = ratios.reduce((a, b) => a + b, 0) || 1;
  return ratios.map((r) => r / sum);
}

// Gabarits de découpage. Chaque fonction renvoie un nouvel arbre.
const LAYOUT_TEMPLATES = {
  single: () => leaf(),
  twoRows: () => split('col', [leaf(), leaf()]),
  threeRows: () => split('col', [leaf(), leaf(), leaf()]),
  twoCols: () => split('row', [leaf(), leaf()]),
  grid4: () => split('col', [split('row', [leaf(), leaf()]), split('row', [leaf(), leaf()])]),
  grid6: () => split('col', [0, 1, 2].map(() => split('row', [leaf(), leaf()]))),
  grid9: () => split('col', [0, 1, 2].map(() => split('row', [leaf(), leaf(), leaf()]))),
  classic: () => split('col', [split('row', [leaf(), leaf()], [3, 2]), leaf(), split('row', [leaf(), leaf(), leaf()])], [1, 1.1, 1]),
  splash: () => split('col', [leaf(), split('row', [leaf(), leaf(), leaf()])], [2.6, 1]),
  manga: () => split('col', [leaf(), split('row', [split('col', [leaf(), leaf()]), leaf()], [1, 1.4]), leaf()], [0.8, 1.6, 0.8]),
  strip: () => split('col', [leaf(), leaf(), leaf()], [1, 1.3, 1]),
};

function defaultTemplate(format) {
  if (format === 'webtoon') return 'strip';
  if (format === 'manga') return 'manga';
  return 'classic';
}

function newPage(project, template) {
  const f = formatOf(project);
  const page = { id: uid(), layout: (LAYOUT_TEMPLATES[template] || LAYOUT_TEMPLATES[defaultTemplate(project.format)])() };
  if (f.scroll) page.height = f.height;
  return page;
}

function newProject({ title = '', format = 'bd' } = {}) {
  const project = {
    id: uid(),
    version: 1,
    title,
    format: FORMATS[format] ? format : 'bd',
    style: '',
    synopsis: '',
    // Images de référence du projet (personnages, décors). Les cases y piochent leurs références.
    library: [],
    pages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  project.pages.push(newPage(project));
  return project;
}

/* ---------- Parcours de l'arbre ---------- */

function* walk(node, parent = null, index = 0) {
  yield { node, parent, index };
  if (node.kind === 'split') {
    for (let i = 0; i < node.children.length; i += 1) yield* walk(node.children[i], node, i);
  }
}

function findLeaf(page, panelId) {
  for (const entry of walk(page.layout)) {
    if (entry.node.kind === 'panel' && entry.node.panel.id === panelId) return entry;
  }
  return null;
}

function findNode(page, nodeId) {
  for (const entry of walk(page.layout)) if (entry.node.id === nodeId) return entry;
  return null;
}

// Retrouve une case dans tout le projet.
function locatePanel(project, panelId) {
  for (let p = 0; p < project.pages.length; p += 1) {
    const entry = findLeaf(project.pages[p], panelId);
    if (entry) return { page: project.pages[p], pageIndex: p, ...entry, panel: entry.node.panel };
  }
  return null;
}

// Cases d'une page dans l'ordre de lecture. L'ordre des enfants de l'arbre est toujours l'ordre de lecture :
// en manga, c'est la géométrie qui place le premier enfant d'une rangée à droite.
function pagePanels(page) {
  const out = [];
  for (const { node } of walk(page.layout)) if (node.kind === 'panel') out.push(node.panel);
  return out;
}

// Toutes les cases du projet, dans l'ordre de lecture, avec leur numéro de page et de case.
function readingOrder(project) {
  const out = [];
  project.pages.forEach((page, pageIndex) => {
    pagePanels(page).forEach((panel, panelIndex) => out.push({ panel, page, pageIndex, panelIndex }));
  });
  return out;
}

// Les cases qui précèdent `panelId` dans l'ordre de lecture, de la plus ancienne à la plus proche.
function previousPanels(project, panelId, count = Infinity) {
  const order = readingOrder(project);
  const index = order.findIndex((e) => e.panel.id === panelId);
  if (index <= 0) return [];
  return order.slice(Math.max(0, index - count), index);
}

/* ---------- Modification du découpage ---------- */

const MIN_RATIO = 0.06;

// Coupe une case en deux. dir 'row' : nouvelle case à côté ; 'col' : en dessous.
// Si le parent coupe déjà dans ce sens, la case y est insérée pour garder un arbre plat.
// La case existante (et ses rendus) reste à sa place : la nouvelle case est vide.
function splitPanel(page, panelId, dir, { before = false } = {}) {
  const entry = findLeaf(page, panelId);
  if (!entry) return null;
  const fresh = leaf();
  const { node, parent, index } = entry;
  if (parent && parent.dir === dir) {
    const half = parent.ratios[index] / 2;
    parent.children.splice(index + (before ? 0 : 1), 0, fresh);
    parent.ratios.splice(index, 1, half, half);
    return fresh.panel;
  }
  const replacement = split(dir, before ? [fresh, node] : [node, fresh]);
  replaceNode(page, node, replacement, parent, index);
  return fresh.panel;
}

function replaceNode(page, node, replacement, parent, index) {
  if (!parent) page.layout = replacement;
  else parent.children[index] = replacement;
}

// Supprime une case : sa place est répartie entre ses voisines. La dernière case d'une page ne se supprime pas.
function removePanel(page, panelId) {
  const entry = findLeaf(page, panelId);
  if (!entry || !entry.parent) return false;
  const { parent, index } = entry;
  const freed = parent.ratios[index];
  parent.children.splice(index, 1);
  parent.ratios.splice(index, 1);
  parent.ratios = normalize(parent.ratios.map((r) => r + freed / parent.ratios.length));
  if (parent.children.length === 1) collapse(page, parent);
  return true;
}

// Un découpage d'un seul enfant est remplacé par cet enfant ; un enfant de même sens est aplati.
function collapse(page, splitNode) {
  const only = splitNode.children[0];
  const holder = findNode(page, splitNode.id);
  if (!holder) return;
  const { parent, index } = holder;
  if (parent && only.kind === 'split' && only.dir === parent.dir) {
    const share = parent.ratios[index];
    parent.children.splice(index, 1, ...only.children);
    parent.ratios.splice(index, 1, ...only.ratios.map((r) => r * share));
    return;
  }
  replaceNode(page, splitNode, only, parent, index);
}

// Déplace la séparation entre les enfants `index` et `index + 1` d'un découpage.
// `delta` est exprimé en fraction de la taille du découpage.
function moveDivider(page, splitId, index, delta) {
  const entry = findNode(page, splitId);
  if (!entry || entry.node.kind !== 'split') return;
  const r = entry.node.ratios;
  const total = r[index] + r[index + 1];
  const a = clamp(r[index] + delta, MIN_RATIO, total - MIN_RATIO);
  r[index] = a;
  r[index + 1] = total - a;
}

// Échange le contenu de deux cases (description, rendus, croquis), éventuellement sur deux pages.
function swapPanels(project, idA, idB) {
  const a = locatePanel(project, idA);
  const b = locatePanel(project, idB);
  if (!a || !b || idA === idB) return false;
  const panelA = a.node.panel;
  a.node.panel = b.node.panel;
  b.node.panel = panelA;
  return true;
}

// Remplace le découpage d'une page par un gabarit. Les cases existantes sont reprises dans l'ordre :
// rien n'est perdu, les cases en trop sont ajoutées à la fin en découpant la dernière rangée.
function applyTemplate(project, page, template) {
  const old = pagePanels(page);
  const layout = LAYOUT_TEMPLATES[template]();
  page.layout = layout;
  const slots = [...walk(layout)].filter((e) => e.node.kind === 'panel').map((e) => e.node);
  slots.forEach((slot, i) => {
    if (old[i]) slot.panel = old[i];
  });
  for (let i = slots.length; i < old.length; i += 1) {
    const last = pagePanels(page).at(-1);
    const added = splitPanel(page, last.id, 'row');
    const entry = findLeaf(page, added.id);
    entry.node.panel = old[i];
  }
}

/* ---------- Géométrie ---------- */

// Rectangles des cases et des séparations, en unités de page.
// Les séparations servent de poignées : elles couvrent la gouttière entre deux enfants.
function computeLayout(project, page) {
  const { width, height } = pageSize(project, page);
  const { margin, gutter } = pageSpacing(project);
  const { rtl } = formatOf(project);
  const panels = [];
  const dividers = [];
  const visit = (node, x, y, w, h, depth) => {
    if (node.kind === 'panel') {
      panels.push({ panelId: node.panel.id, panel: node.panel, nodeId: node.id, x, y, w, h });
      return;
    }
    const horizontal = node.dir === 'row';
    const size = horizontal ? w : h;
    const usable = Math.max(0, size - gutter * (node.children.length - 1));
    let offset = 0;
    const spans = node.ratios.map((r) => {
      const span = { start: offset, size: usable * r };
      offset += usable * r + gutter;
      return span;
    });
    // En manga, le premier enfant d'une rangée est à droite : il est lu en premier.
    const place = (i) => (horizontal && rtl ? size - spans[i].start - spans[i].size : spans[i].start);
    node.children.forEach((child, i) => {
      const s = place(i);
      if (horizontal) visit(child, x + s, y, spans[i].size, h, depth + 1);
      else visit(child, x, y + s, w, spans[i].size, depth + 1);
    });
    for (let i = 0; i < node.children.length - 1; i += 1) {
      const start = horizontal && rtl ? place(i) - gutter : spans[i].start + spans[i].size;
      dividers.push(horizontal
        ? { splitId: node.id, index: i, dir: 'row', x: x + start, y, w: gutter, h, size, rtl }
        : { splitId: node.id, index: i, dir: 'col', x, y: y + start, w, h: gutter, size: h, rtl: false });
    }
  };
  visit(page.layout, margin, margin, width - 2 * margin, height - 2 * margin, 0);
  return { width, height, panels, dividers };
}

/* ---------- Tailles de rendu ---------- */

// Contraintes du Tiiny pour Qwen-Image 2.1 : multiples de 32 et ceil32((w/16)·(h/16)) ≤ 16896.
const MAX_LATENT_TOKENS = 16896;
const MIN_RATIO_GEN = 1 / 4;
const MAX_RATIO_GEN = 4;
const ceilTo32 = (n) => Math.ceil(n / 32) * 32;
const roundTo32 = (n) => Math.max(32, Math.round(n / 32) * 32);
const latentTokens = (w, h) => ceilTo32((w / 16) * (h / 16));
const fitsTiiny = (w, h) => w % 32 === 0 && h % 32 === 0 && latentTokens(w, h) <= MAX_LATENT_TOKENS;

// Presets de génération. `area` en pixels ; `long` pour le brouillon (côté le plus long).
const PRESETS = {
  draft: { long: 512, steps: 20 },
  mp1: { area: 1024 * 1024, steps: 40 },
  mp2: { area: 2 * 1024 * 1024, steps: 40 },
  mp4: { area: 2048 * 2048, steps: 40 },
};
const UPSCALE_TARGETS = ['mp1', 'mp2', 'mp4'];

// Les cases très allongées sont rendues à un format borné : le cadrage dans la case fait le reste.
function generationRatio(w, h) {
  return clamp(w / h, MIN_RATIO_GEN, MAX_RATIO_GEN);
}

function sizeForArea(ratio, area) {
  let w = roundTo32(Math.sqrt(area * ratio));
  let h = roundTo32(w / ratio);
  while (!fitsTiiny(w, h)) {
    if (w >= h) w -= 32;
    else h -= 32;
  }
  return [w, h];
}

function sizeForLong(ratio, long) {
  return ratio >= 1 ? [roundTo32(long), roundTo32(long / ratio)] : [roundTo32(long * ratio), roundTo32(long)];
}

// Taille de rendu d'un preset pour une case de w × h unités.
function presetSize(preset, panelW, panelH) {
  const ratio = generationRatio(panelW, panelH);
  const p = PRESETS[preset] || PRESETS.mp1;
  return p.long ? sizeForLong(ratio, p.long) : sizeForArea(ratio, p.area);
}

// Un agrandissement n'a de sens que vers une taille nettement plus grande que l'image actuelle.
function upscaleAvailable(target, imageW, imageH) {
  const p = PRESETS[target];
  return !!p?.area && p.area > imageW * imageH * 1.15;
}

/* ---------- Cadrage d'une image dans une case ---------- */

// Position de l'image dans la case (unités de la case). zoom 1 : l'image couvre la case (comme object-fit: cover).
function placeImage(imageW, imageH, panelW, panelH, placement = {}) {
  const zoom = placement.zoom ?? 1;
  const cover = Math.max(panelW / imageW, panelH / imageH);
  const s = cover * zoom;
  const dw = imageW * s;
  const dh = imageH * s;
  const cx = panelW / 2 + (placement.x ?? 0) * panelW;
  const cy = panelH / 2 + (placement.y ?? 0) * panelH;
  return { x: cx - dw / 2, y: cy - dh / 2, w: dw, h: dh, scale: s };
}

// Vrai si une partie de la case n'est pas couverte par l'image : c'est ce que « Étendre » remplit.
function hasUncovered(imageW, imageH, panelW, panelH, placement) {
  const r = placeImage(imageW, imageH, panelW, panelH, placement);
  const eps = 0.5;
  return r.x > eps || r.y > eps || r.x + r.w < panelW - eps || r.y + r.h < panelH - eps;
}

/* ---------- Divers ---------- */

const currentVersion = (panel) => panel.versions.find((v) => v.id === panel.current) || null;

function panelLabel(project, panelId) {
  const order = readingOrder(project);
  const entry = order.find((e) => e.panel.id === panelId);
  return entry ? { page: entry.pageIndex + 1, panel: entry.panelIndex + 1 } : null;
}

// Identifiants d'images utilisés par le projet : les rendus, croquis et références ne sont jamais purgés tant qu'ils y figurent.
function projectAssetIds(project) {
  const ids = new Set(project.library.map((l) => l.assetId));
  for (const { panel } of readingOrder(project)) {
    for (const v of panel.versions) {
      for (const key of ['assetId', 'sketchAssetId', 'maskAssetId']) if (v[key]) ids.add(v[key]);
    }
    if (panel.sketch?.assetId) ids.add(panel.sketch.assetId);
    for (const r of panel.refs) ids.add(r);
  }
  return ids;
}

const TC_PROJECT = {
  FORMATS, FORMAT_IDS, LAYOUT_TEMPLATES, PRESETS, UPSCALE_TARGETS, WEBTOON_MIN_HEIGHT, WEBTOON_MAX_HEIGHT,
  uid, clamp, formatOf, pageSize, pageSpacing, newPanel, newPage, newProject, defaultTemplate,
  walk, findLeaf, findNode, locatePanel, pagePanels, readingOrder, previousPanels,
  splitPanel, removePanel, moveDivider, swapPanels, applyTemplate, computeLayout,
  fitsTiiny, latentTokens, generationRatio, sizeForArea, presetSize, upscaleAvailable,
  placeImage, hasUncovered, currentVersion, panelLabel, projectAssetIds,
};

if (typeof module !== 'undefined') module.exports = TC_PROJECT;
