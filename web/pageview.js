// Vue interactive d'une page : cases, gouttières, sélection, échange de cases et cadrage de l'image.
// La vue ne garde aucun état du projet : elle le relit à chaque rendu et signale les changements.
'use strict';

const PV = TC_PROJECT;
const DRAG_THRESHOLD = 6;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;

class PageView {
  constructor(container, { store, onSelect, onChange, onSwap, onZoom, onAddRow, onRegroup }) {
    this.el = container;
    this.store = store;
    this.onSelect = onSelect;
    this.onChange = onChange;
    this.onSwap = onSwap;
    this.onZoom = onZoom;
    this.onAddRow = onAddRow;
    this.onRegroup = onRegroup;
    // Zoom de la page, relatif à l'ajustement (1 = la page tient dans la zone ; en webtoon, la largeur par défaut).
    this.zoom = 1;
    this.fitHeight = null;
    // Croquis : outil actif, élément sélectionné, historique d'annulation par case (session seulement).
    this.sketchTool = 'select';
    this.sketchSel = null;
    this.sketchHistory = new Map();
    document.addEventListener('keydown', (e) => this._sketchKey(e));
    this.project = null;
    this.pageIndex = 0;
    this.selectedId = null;
    this.mode = 'layout';
    // Rendu en cours : { panelId, url } pour afficher l'aperçu dans la case.
    this.rendering = null;
    this.drag = null;
    new ResizeObserver(() => this.refresh()).observe(container);
    // Ctrl + molette : zoom de la page (la molette seule fait défiler, ou cadre l'image en mode Cadrer).
    container.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.002));
    }, { passive: false });
  }

  setZoom(zoom) {
    this.zoom = PV.clamp(zoom, 0.25, 6);
    if (Math.abs(this.zoom - 1) < 0.03) this.zoom = 1;
    this.refresh();
    this.onZoom?.(this.zoom);
  }

  show(project, { pageIndex = this.pageIndex, selectedId = this.selectedId } = {}) {
    this.project = project;
    this.pageIndex = pageIndex;
    this.selectedId = selectedId;
    this.refresh();
  }

  setMode(mode) {
    this.mode = mode;
    this.refresh();
  }

  setRendering(rendering) {
    this.rendering = rendering;
    this.refresh();
  }

  // Progression du rendu en cours, sans reconstruire la page (appelé plusieurs fois par seconde).
  setProgress(progress, label) {
    if (!this.rendering) return;
    Object.assign(this.rendering, { progress, label });
    const cell = this.el.querySelector(`.cell[data-panel-id="${this.rendering.panelId}"]`);
    if (!cell) return;
    const bar = cell.querySelector('.cell-progress');
    if (bar) bar.style.width = `${progress}%`;
    const badge = cell.querySelector('.cell-badge');
    if (badge) badge.textContent = label;
  }

  get webtoon() {
    return PV.formatOf(this.project).scroll;
  }

  // Échelle d'affichage : la page entière tient dans la zone ; en webtoon, la largeur est bornée et on défile.
  _scale(page) {
    const { width, height } = PV.pageSize(this.project, page);
    const box = this.el.getBoundingClientRect();
    if (this.webtoon) return (Math.min(560, Math.max(240, box.width - 40)) / width) * this.zoom;
    // La hauteur d'ajustement se mesure quand la page est ajustée ; zoomée, la zone suit la page et ne sert plus.
    if (this.zoom === 1 || !this.fitHeight) this.fitHeight = box.height;
    return Math.max(0.05, Math.min((box.width - 24) / width, (this.fitHeight - 12) / height)) * this.zoom;
  }

  refresh() {
    if (!this.project || this.drag?.live) return;
    const pages = this.webtoon ? this.project.pages.map((p, i) => i) : [this.pageIndex];
    this.el.classList.toggle('webtoon', this.webtoon);
    this.el.classList.toggle('fit', !this.webtoon && this.zoom === 1);
    this.el.classList.toggle('zoomed', !this.webtoon && this.zoom !== 1);
    this.el.classList.toggle('mode-frame', this.mode === 'frame');
    this.el.classList.toggle('mode-sketch', this.mode === 'sketch');
    const scrollTop = this.el.scrollTop;
    this.el.replaceChildren(...pages.map((i) => this._renderPage(i)));
    this.el.scrollTop = scrollTop;
  }

  // Fait défiler jusqu'à une bande (webtoon).
  scrollToPage(index) {
    const node = this.el.querySelector(`[data-page-index="${index}"]`);
    node?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  _renderPage(pageIndex) {
    const page = this.project.pages[pageIndex];
    const scale = this._scale(page);
    const layout = PV.computeLayout(this.project, page);
    const { border } = PV.pageSpacing(this.project);
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.pageIndex = pageIndex;
    el.style.width = `${layout.width * scale}px`;
    el.style.height = `${layout.height * scale}px`;
    const numbers = new Map(PV.pagePanels(page).map((p, i) => [p.id, i + 1]));
    for (const rect of layout.panels) el.append(this._renderCell(rect, scale, border, numbers.get(rect.panelId), pageIndex));
    for (const d of layout.dividers) el.append(this._renderDivider(page, d, scale));
    if (this.webtoon) {
      el.append(this._renderStripHandle(page, scale));
      // Ajout d'une rangée de cases en bas de la bande.
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'strip-add btn small';
      add.innerHTML = `${iconSvg('plus')}<span>${t('addRow')}</span>`;
      add.addEventListener('click', () => this.onAddRow?.(pageIndex));
      el.append(add);
    }
    return el;
  }

  _renderCell(rect, scale, border, number, pageIndex) {
    const { panel } = rect;
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.panelId = panel.id;
    Object.assign(cell.style, {
      left: `${rect.x * scale}px`,
      top: `${rect.y * scale}px`,
      width: `${rect.w * scale}px`,
      height: `${rect.h * scale}px`,
    });
    cell.style.setProperty('--bw', `${Math.max(1, border * scale)}px`);
    if (!border) cell.classList.add('no-border');
    cell.classList.toggle('selected', panel.id === this.selectedId);

    const preview = this.rendering?.panelId === panel.id ? this.rendering : null;
    const version = PV.currentVersion(panel);
    const url = preview?.url || (version && this._url(version.assetId));
    const size = preview?.url ? preview : version;
    if (url && size?.width) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      this._placeImg(img, size.width, size.height, rect.w * scale, rect.h * scale, preview?.url ? { zoom: 1, x: 0, y: 0 } : panel.placement);
      cell.append(img);
      cell.classList.add('has-image');
      if (!preview && PV.hasUncovered(size.width, size.height, rect.w, rect.h, panel.placement)) cell.classList.add('uncovered');
    } else {
      const text = document.createElement('span');
      text.className = `cell-text${panel.description ? '' : ' empty'}`;
      text.textContent = panel.description || t('describeFirst');
      cell.append(text);
    }
    // Croquis : affiché en mode Croquis sur la case sélectionnée, ou en filigrane tant qu'il n'y a pas d'image.
    const sketchItems = panel.sketch?.items || [];
    const sketching = this.mode === 'sketch' && panel.id === this.selectedId;
    if (sketching) cell.classList.add('sketching');
    if (sketching || (sketchItems.length && !url)) {
      const layer = document.createElement('div');
      layer.className = 'sketch-layer';
      layer.innerHTML = ComicSketch.svgMarkup(sketchItems, rect.w * scale, rect.h * scale, { selectedId: sketching ? this.sketchSel : null });
      cell.append(layer);
    }
    if (sketchItems.length) cell.classList.add('has-sketch');
    if (preview) {
      cell.classList.add('rendering');
      if (preview.url) cell.classList.add('previewing');
      const loading = document.createElement('div');
      loading.className = 'cell-loading';
      const bar = document.createElement('span');
      bar.className = 'cell-progress';
      bar.style.width = `${preview.progress || 0}%`;
      const badge = document.createElement('span');
      badge.className = 'cell-badge';
      badge.textContent = preview.label || '';
      cell.append(loading, bar, badge);
    }
    const num = document.createElement('span');
    num.className = 'cell-num';
    num.textContent = number;
    cell.append(num);
    cell.addEventListener('pointerdown', (e) => this._cellDown(e, panel, rect, scale, cell, pageIndex));
    cell.addEventListener('wheel', (e) => this._cellWheel(e, panel), { passive: false });
    cell.addEventListener('dblclick', (e) => {
      if (this.mode === 'sketch' && panel.id === this.selectedId) {
        const box = cell.getBoundingClientRect();
        const hit = ComicSketch.hitTest(panel.sketch?.items || [], e.clientX - box.left, e.clientY - box.top, box.width, box.height);
        if (hit && hit.type !== 'stroke') this._editSketchText(panel, hit);
        return;
      }
      if (this.mode !== 'frame' || panel.id !== this.selectedId) return;
      panel.placement = { zoom: 1, x: 0, y: 0 };
      this.refresh();
      this.onChange('placement');
    });
    return cell;
  }

  _url(assetId) {
    const cached = this.store.cachedUrl(assetId);
    if (cached) return cached;
    // Première lecture : la case est redessinée dès que l'image est prête.
    this.store.url(assetId).then((u) => u && this.refresh());
    return null;
  }

  _placeImg(img, imgW, imgH, cellW, cellH, placement) {
    const r = PV.placeImage(imgW, imgH, cellW, cellH, placement);
    Object.assign(img.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  /* ---------- Sélection, échange, cadrage ---------- */

  _cellDown(e, panel, rect, scale, cell, pageIndex) {
    if (e.button !== 0) return;
    if (this.mode === 'sketch' && panel.id === this.selectedId) {
      this._sketchDown(e, panel, rect, scale, cell);
      return;
    }
    const version = PV.currentVersion(panel);
    const framing = this.mode === 'frame' && panel.id === this.selectedId && version;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, placement: { ...panel.placement } };
    const img = cell.querySelector('img');
    let moved = false;
    let target = null;
    cell.setPointerCapture(e.pointerId);
    // Pendant le geste, la vue n'est pas reconstruite : la case capturée doit rester dans le document.
    this.drag = { live: true };
    if (panel.id !== this.selectedId) {
      this.selectedId = panel.id;
      this.el.querySelectorAll('.cell').forEach((n) => n.classList.toggle('selected', n === cell));
      this.onSelect(panel.id, pageIndex);
    }

    const move = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved = true;
      if (framing) {
        cell.classList.add('panning');
        panel.placement.x = start.placement.x + dx / (rect.w * scale);
        panel.placement.y = start.placement.y + dy / (rect.h * scale);
        if (img) this._placeImg(img, version.width, version.height, rect.w * scale, rect.h * scale, panel.placement);
        return;
      }
      if (this.mode !== 'layout') return;
      cell.classList.add('dragging');
      const under = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n.classList?.contains('cell') && n !== cell);
      if (target && target !== under) target.classList.remove('drop-target');
      target = under || null;
      target?.classList.add('drop-target');
    };
    const up = () => {
      cell.removeEventListener('pointermove', move);
      cell.removeEventListener('pointerup', up);
      cell.removeEventListener('pointercancel', up);
      this.drag = null;
      if (framing && moved) {
        this.refresh();
        this.onChange('placement');
        return;
      }
      if (target) this.onSwap(panel.id, target.dataset.panelId);
      else this.refresh();
    };
    cell.addEventListener('pointermove', move);
    cell.addEventListener('pointerup', up);
    cell.addEventListener('pointercancel', up);
  }

  _cellWheel(e, panel) {
    if (e.ctrlKey) return;
    if (this.mode !== 'frame' || panel.id !== this.selectedId || !PV.currentVersion(panel)) return;
    e.preventDefault();
    const zoom = PV.clamp((panel.placement.zoom ?? 1) * Math.exp(-e.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
    panel.placement = { ...panel.placement, zoom };
    this.refresh();
    clearTimeout(this._wheelTimer);
    this._wheelTimer = setTimeout(() => this.onChange('placement'), 300);
  }

  /* ---------- Gouttières ---------- */

  _renderDivider(page, d, scale) {
    const el = document.createElement('div');
    el.className = `divider ${d.dir}`;
    // La poignée déborde un peu de la gouttière pour rester facile à attraper quand elle est fine.
    const pad = Math.max(0, 10 - d[d.dir === 'row' ? 'w' : 'h'] * scale) / 2;
    Object.assign(el.style, {
      left: `${d.x * scale - (d.dir === 'row' ? pad : 0)}px`,
      top: `${d.y * scale - (d.dir === 'col' ? pad : 0)}px`,
      width: `${d.w * scale + (d.dir === 'row' ? 2 * pad : 0)}px`,
      height: `${d.h * scale + (d.dir === 'col' ? 2 * pad : 0)}px`,
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.mode !== 'layout') return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('active');
      const entry = PV.findNode(page, d.splitId);
      const { gutter } = PV.pageSpacing(this.project);
      const usable = Math.max(1, d.size - gutter * (entry.node.children.length - 1));
      let last = d.dir === 'row' ? e.clientX : e.clientY;
      const move = (ev) => {
        const now = d.dir === 'row' ? ev.clientX : ev.clientY;
        let delta = (now - last) / scale / usable;
        if (d.rtl) delta = -delta;
        last = now;
        PV.moveDivider(page, d.splitId, d.index, delta);
        this.refresh();
        this.el.querySelectorAll('.divider').forEach((n) => n.classList.toggle('active', n.dataset.key === `${d.splitId}:${d.index}`));
      };
      // Écoute sur la fenêtre : chaque mouvement redessine la page et remplace cette poignée,
      // qui perdrait sinon la capture du pointeur après le premier déplacement.
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        this.refresh();
        this.onChange('layout');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    // Double-clic : coupe une gouttière partagée (transpose le regroupement rangées / colonnes).
    el.addEventListener('dblclick', () => {
      if (this.mode === 'layout') this.onRegroup?.(page, d.splitId);
    });
    el.dataset.key = `${d.splitId}:${d.index}`;
    return el;
  }

  /* ---------- Croquis ---------- */

  _sketchHistoryOf(panel) {
    if (!this.sketchHistory.has(panel.id)) this.sketchHistory.set(panel.id, []);
    const list = this.sketchHistory.get(panel.id);
    if (list.length > 60) list.shift();
    return list;
  }

  _sketchCommit(panel, before) {
    if (JSON.stringify(panel.sketch.items) === before) return;
    this._sketchHistoryOf(panel).push(before);
    this.onChange('sketch');
  }

  _sketchDown(e, panel, rect, scale, cell) {
    const SK = ComicSketch;
    e.preventDefault();
    const W = rect.w * scale;
    const H = rect.h * scale;
    const box = cell.getBoundingClientRect();
    const pos = (ev) => [ev.clientX - box.left, ev.clientY - box.top];
    const [px, py] = pos(e);
    panel.sketch ||= { items: [], use: true };
    panel.sketch.items ||= [];
    const items = panel.sketch.items;
    const before = JSON.stringify(items);
    let layer = cell.querySelector('.sketch-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'sketch-layer';
      cell.append(layer);
    }
    const draw = () => { layer.innerHTML = SK.svgMarkup(items, W, H, { selectedId: this.sketchSel }); };
    const tool = this.sketchTool;
    let onMove = null;
    let onUp = null;
    this.drag = { live: true };

    if (tool === 'pen') {
      const stroke = { id: SK.uid(), type: 'stroke', points: [[px / W, py / H]], size: 1 };
      items.push(stroke);
      this.sketchSel = null;
      onMove = ([x, y]) => {
        const last = stroke.points[stroke.points.length - 1];
        if (Math.hypot(x - last[0] * W, y - last[1] * H) < 2) return;
        stroke.points.push([x / W, y / H]);
        draw();
      };
      onUp = () => {
        if (stroke.points.length < 2) stroke.points.push([px / W + 0.003, py / H + 0.003]);
      };
    } else if (tool === 'eraser') {
      const erase = ([x, y]) => {
        const hit = SK.hitTest(items, x, y, W, H, 10);
        if (!hit) return;
        items.splice(items.indexOf(hit), 1);
        draw();
      };
      erase([px, py]);
      onMove = erase;
    } else if (SK.BOX_TOOLS.includes(tool)) {
      const item = SK.createItem(tool, SK.defaultBox(tool, px / W, py / H));
      items.push(item);
      this.sketchSel = item.id;
      draw();
      onMove = ([x, y]) => {
        if (Math.hypot(x - px, y - py) < DRAG_THRESHOLD) return;
        item.x = Math.max(0, Math.min(px, x) / W);
        item.y = Math.max(0, Math.min(py, y) / H);
        item.w = Math.max(0.03, Math.abs(x - px) / W);
        item.h = Math.max(0.03, Math.abs(y - py) / H);
        if (item.tx !== undefined) {
          item.tx = Math.min(1, item.x + item.w * 0.25);
          item.ty = Math.min(1, item.y + item.h * 1.5);
        }
        draw();
      };
      // Bulles, récitatif, onomatopée : on saisit le texte tout de suite.
      if (SK.TEXT_TYPES.includes(tool)) onUp = () => setTimeout(() => this._editSketchText(panel, item), 0);
    } else {
      const selected = items.find((it) => it.id === this.sketchSel);
      const handle = SK.hitHandle(selected, px, py, W, H);
      const target = handle ? selected : SK.hitTest(items, px, py, W, H);
      this.sketchSel = target?.id || null;
      draw();
      if (target) {
        let last = [px, py];
        onMove = ([x, y]) => {
          const dx = (x - last[0]) / W;
          const dy = (y - last[1]) / H;
          last = [x, y];
          if (handle === 'resize') {
            target.w = Math.max(0.03, target.w + dx);
            target.h = Math.max(0.03, target.h + dy);
          } else if (handle === 'tail') {
            target.tx += dx;
            target.ty += dy;
          } else SK.moveItem(target, dx, dy);
          draw();
        };
      }
    }

    // Écoute sur la fenêtre : le geste continue même si le pointeur sort de la case.
    const move = (ev) => onMove?.(pos(ev));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      onUp?.();
      this.drag = null;
      this._sketchCommit(panel, before);
      this.refresh();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // Saisie du texte d'une bulle, d'un récitatif, d'une onomatopée ou du nom d'un personnage, sur place.
  _editSketchText(panel, item) {
    const cell = this.el.querySelector(`.cell[data-panel-id="${panel.id}"]`);
    if (!cell) return;
    const r = cell.getBoundingClientRect();
    const field = document.createElement('textarea');
    field.className = 'sketch-text field';
    field.value = item.text || '';
    field.placeholder = t(item.type === 'character' ? 'sketchNamePlaceholder' : 'sketchTextPlaceholder');
    Object.assign(field.style, {
      left: `${Math.min(item.x * r.width, Math.max(0, r.width - 160))}px`,
      top: `${item.y * r.height}px`,
      width: `${Math.max(item.w * r.width, 160)}px`,
      height: `${Math.max(item.h * r.height, 56)}px`,
    });
    const before = JSON.stringify(panel.sketch.items);
    this.drag = { live: true };
    let closed = false;
    const done = (save) => {
      if (closed) return;
      closed = true;
      if (save) item.text = field.value.trim();
      field.remove();
      this.drag = null;
      if (save) this._sketchCommit(panel, before);
      this.refresh();
    };
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        done(true);
      } else if (e.key === 'Escape') done(false);
    });
    field.addEventListener('pointerdown', (e) => e.stopPropagation());
    field.addEventListener('blur', () => done(true));
    cell.append(field);
    field.focus();
    field.select();
  }

  _sketchKey(e) {
    if (this.mode !== 'sketch' || !this.project || this.drag) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const panel = PV.locatePanel(this.project, this.selectedId)?.panel;
    if (!panel?.sketch?.items) return;
    const items = panel.sketch.items;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sketchSel) {
      const i = items.findIndex((it) => it.id === this.sketchSel);
      if (i < 0) return;
      e.preventDefault();
      const before = JSON.stringify(items);
      items.splice(i, 1);
      this.sketchSel = null;
      this._sketchCommit(panel, before);
      this.refresh();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      const previous = this._sketchHistoryOf(panel).pop();
      if (!previous) return;
      e.preventDefault();
      panel.sketch.items = JSON.parse(previous);
      this.sketchSel = null;
      this.onChange('sketch');
      this.refresh();
    } else if (e.key === 'Escape' && this.sketchSel) {
      this.sketchSel = null;
      this.refresh();
    }
  }

  // Webtoon : la hauteur de chaque bande se règle en tirant son bord inférieur.
  _renderStripHandle(page, scale) {
    const el = document.createElement('div');
    el.className = 'strip-handle';
    el.title = t('stripHeight');
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      const startY = e.clientY;
      const startH = PV.pageSize(this.project, page).height;
      const pageEl = el.parentElement;
      this.drag = { live: true };
      const move = (ev) => {
        const h = PV.clamp(Math.round((startH + (ev.clientY - startY) / scale) / 10) * 10, PV.WEBTOON_MIN_HEIGHT, PV.WEBTOON_MAX_HEIGHT);
        page.height = h;
        pageEl.style.height = `${h * scale}px`;
        this.onChange('stripHeight-live');
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        this.drag = null;
        this.refresh();
        this.onChange('layout');
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    return el;
  }
}

// Miniature d'une page (liste des pages, menu des gabarits) : un simple jeu de rectangles.
function renderMiniPage(project, page, width, { store, selectedId } = {}) {
  const layout = PV.computeLayout(project, page);
  const scale = width / layout.width;
  const mini = document.createElement('div');
  mini.className = 'mini';
  mini.style.height = `${layout.height * scale}px`;
  for (const rect of layout.panels) {
    const cell = document.createElement('div');
    cell.className = `mini-cell${rect.panelId === selectedId ? ' sel' : ''}`;
    Object.assign(cell.style, {
      left: `${rect.x * scale}px`, top: `${rect.y * scale}px`, width: `${rect.w * scale}px`, height: `${rect.h * scale}px`,
    });
    const version = PV.currentVersion(rect.panel);
    const url = version && store?.cachedUrl(version.assetId);
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      const r = PV.placeImage(version.width, version.height, rect.w * scale, rect.h * scale, rect.panel.placement);
      Object.assign(img.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      cell.append(img);
    }
    mini.append(cell);
  }
  return mini;
}

// Pictogramme SVG d'un gabarit, pour le menu.
function templateIcon(template) {
  const fake = { format: 'bd', margin: 60, gutter: 70, pages: [] };
  const page = { layout: PV.LAYOUT_TEMPLATES[template]() };
  const { panels } = PV.computeLayout(fake, page);
  const k = 46 / 2400;
  const rects = panels.map((r) => `<rect x="${(r.x * k).toFixed(1)}" y="${(r.y * k).toFixed(1)}" width="${(r.w * k).toFixed(1)}" height="${(r.h * k).toFixed(1)}" rx="1"/>`).join('');
  return `<svg viewBox="0 0 46 62" aria-hidden="true">${rects}</svg>`;
}
