// Croquis d'une case : éléments vectoriels (trait, personnage, bulle, pensée, récitatif, onomatopée)
// en coordonnées relatives à la case (0..1), pour suivre la case quand on la redimensionne.
// Un seul rendu SVG sert à l'affichage et à l'image envoyée au modèle.
'use strict';

(function (global) {
  const TOOLS = ['select', 'pen', 'eraser', 'character', 'speech', 'thought', 'caption', 'sfx'];
  const BOX_TOOLS = ['character', 'speech', 'thought', 'caption', 'sfx'];
  const TEXT_TYPES = ['speech', 'thought', 'caption', 'sfx'];
  // Taille par défaut quand on clique sans tirer de cadre.
  const DEFAULT_BOX = {
    character: [0.2, 0.55],
    speech: [0.36, 0.2],
    thought: [0.36, 0.2],
    caption: [0.44, 0.13],
    sfx: [0.32, 0.16],
  };
  const INK = '#151515';

  let counter = 0;
  const uid = () => `s${Date.now().toString(36)}${(counter++).toString(36)}`;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function escapeXml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  }

  // Nouvel élément à cadre ; `box` en coordonnées relatives.
  function createItem(type, box, text = '') {
    const item = { id: uid(), type, x: box.x, y: box.y, w: box.w, h: box.h };
    if (TEXT_TYPES.includes(type) || type === 'character') item.text = text;
    if (type === 'speech' || type === 'thought') {
      item.tx = clamp(box.x + box.w * 0.25, 0, 1);
      item.ty = clamp(box.y + box.h * 1.6, 0, 1);
    }
    return item;
  }

  function defaultBox(type, cx, cy) {
    const [w, h] = DEFAULT_BOX[type];
    return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
  }

  /* ---------- Dessin ---------- */

  // Découpe un texte en lignes qui tiennent dans `maxWidth` (estimation : 0,55 × taille de police par signe).
  function wrap(text, maxWidth, size) {
    const perLine = Math.max(4, Math.floor(maxWidth / (size * 0.55)));
    const lines = [];
    for (const para of String(text || '').split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        if (!line) line = word;
        else if ((line + ' ' + word).length <= perLine) line += ` ${word}`;
        else {
          lines.push(line);
          line = word;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  function textBlock(text, cx, cy, maxW, maxH, unit, { bold = false } = {}) {
    if (!String(text || '').trim()) return '';
    let size = clamp(unit * 0.05, 9, 64);
    let lines = wrap(text, maxW, size);
    while (size > 7 && lines.length * size * 1.15 > maxH) {
      size *= 0.9;
      lines = wrap(text, maxW, size);
    }
    const top = cy - ((lines.length - 1) * size * 1.15) / 2;
    const spans = lines.map((l, i) => `<tspan x="${cx}" y="${top + i * size * 1.15}">${escapeXml(l)}</tspan>`).join('');
    return `<text font-family="Comic Sans MS, Comic Neue, Segoe UI, sans-serif" font-size="${size.toFixed(1)}" font-weight="${bold ? 700 : 500}" fill="${INK}" text-anchor="middle" dominant-baseline="middle">${spans}</text>`;
  }

  function drawItem(it, w, h, sw, unit) {
    const X = it.x * w;
    const Y = it.y * h;
    const W = it.w * w;
    const H = it.h * h;
    const cx = X + W / 2;
    const cy = Y + H / 2;
    switch (it.type) {
      case 'stroke': {
        const pts = it.points.map(([px, py]) => `${(px * w).toFixed(1)},${(py * h).toFixed(1)}`).join(' ');
        return `<polyline points="${pts}" fill="none" stroke="${INK}" stroke-width="${(sw * (it.size || 1)).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      case 'character': {
        // Silhouette sommaire : tête, tronc, bras, jambes.
        const r = Math.min(W * 0.28, H * 0.12);
        const headY = Y + r + sw;
        const neck = headY + r;
        const hip = Y + H * 0.62;
        const shoulder = neck + H * 0.07;
        const s = `stroke="${INK}" stroke-width="${(sw * 1.4).toFixed(2)}" stroke-linecap="round" fill="none"`;
        return `<g ${s}><circle cx="${cx}" cy="${headY}" r="${r}"/>`
          + `<path d="M${cx} ${neck} L${cx} ${hip} M${X + W * 0.1} ${Y + H * 0.5} L${cx} ${shoulder} L${X + W * 0.9} ${Y + H * 0.5}`
          + ` M${X + W * 0.18} ${Y + H} L${cx} ${hip} L${X + W * 0.82} ${Y + H}"/></g>`;
      }
      case 'speech': {
        const rx = W / 2;
        const ry = H / 2;
        const a = Math.atan2(it.ty * h - cy, it.tx * w - cx);
        const p1 = [cx + rx * Math.cos(a - 0.22), cy + ry * Math.sin(a - 0.22)];
        const p2 = [cx + rx * Math.cos(a + 0.22), cy + ry * Math.sin(a + 0.22)];
        return `<path d="M${p1[0]} ${p1[1]} L${it.tx * w} ${it.ty * h} L${p2[0]} ${p2[1]}" fill="#fff" stroke="${INK}" stroke-width="${sw}" stroke-linejoin="round"/>`
          + `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#fff" stroke="${INK}" stroke-width="${sw}"/>`
          + `<path d="M${p1[0]} ${p1[1]} L${p2[0]} ${p2[1]}" stroke="#fff" stroke-width="${sw * 2}"/>`
          + textBlock(it.text, cx, cy, W * 0.72, H * 0.72, unit);
      }
      case 'thought': {
        const rx = W / 2;
        const ry = H / 2;
        const bumps = 11;
        const br = Math.min(rx, ry) * 0.32;
        let cloud = '';
        for (let i = 0; i < bumps; i += 1) {
          const a = (i / bumps) * Math.PI * 2;
          cloud += `<circle cx="${cx + (rx - br * 0.6) * Math.cos(a)}" cy="${cy + (ry - br * 0.6) * Math.sin(a)}" r="${br}"/>`;
        }
        const tx = it.tx * w;
        const ty = it.ty * h;
        const a = Math.atan2(ty - cy, tx - cx);
        const ex = cx + rx * Math.cos(a);
        const ey = cy + ry * Math.sin(a);
        let trail = '';
        [0.35, 0.65, 0.92].forEach((f, i) => {
          trail += `<circle cx="${ex + (tx - ex) * f}" cy="${ey + (ty - ey) * f}" r="${br * (0.55 - i * 0.15)}"/>`;
        });
        return `<g fill="#fff" stroke="${INK}" stroke-width="${sw}">${cloud}${trail}</g>`
          + `<ellipse cx="${cx}" cy="${cy}" rx="${rx - br * 0.6}" ry="${ry - br * 0.6}" fill="#fff"/>`
          + textBlock(it.text, cx, cy, W * 0.68, H * 0.66, unit);
      }
      case 'caption':
        return `<rect x="${X}" y="${Y}" width="${W}" height="${H}" fill="#fff6cf" stroke="${INK}" stroke-width="${sw}"/>`
          + textBlock(it.text, cx, cy, W * 0.9, H * 0.8, unit);
      case 'sfx': {
        const text = String(it.text || '').trim() || '!';
        const size = H * 0.78;
        return `<text x="${cx}" y="${cy}" transform="rotate(-8 ${cx} ${cy})" font-family="Impact, Arial Black, sans-serif" font-size="${size.toFixed(1)}" font-weight="900"`
          + ` text-anchor="middle" dominant-baseline="middle" textLength="${(W * 0.94).toFixed(1)}" lengthAdjust="spacingAndGlyphs"`
          + ` fill="#fff" stroke="${INK}" stroke-width="${(sw * 1.6).toFixed(2)}" paint-order="stroke">${escapeXml(text)}</text>`;
      }
      default:
        return '';
    }
  }

  // Cadre de sélection : poignée de taille en bas à droite, poignée de queue pour les bulles.
  function drawSelection(it, w, h) {
    if (it.type === 'stroke') {
      const b = strokeBounds(it);
      return `<rect x="${b.x * w - 4}" y="${b.y * h - 4}" width="${b.w * w + 8}" height="${b.h * h + 8}" class="sk-sel"/>`;
    }
    const X = it.x * w;
    const Y = it.y * h;
    const W = it.w * w;
    const H = it.h * h;
    let out = `<rect x="${X}" y="${Y}" width="${W}" height="${H}" class="sk-sel"/>`
      + `<rect x="${X + W - 6}" y="${Y + H - 6}" width="12" height="12" class="sk-handle"/>`;
    if (it.tx !== undefined) out += `<circle cx="${it.tx * w}" cy="${it.ty * h}" r="6" class="sk-handle"/>`;
    return out;
  }

  // Balisage SVG du croquis, à la taille `w` × `h` en pixels.
  function svgMarkup(items, w, h, { selectedId = null, background = null } = {}) {
    const unit = Math.min(w, h);
    const sw = Math.max(1.4, unit * 0.007);
    const body = (items || []).map((it) => drawItem(it, w, h, sw, unit)).join('');
    const sel = selectedId ? (items || []).find((it) => it.id === selectedId) : null;
    const bg = background ? `<rect width="${w}" height="${h}" fill="${background}"/>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg}${body}${sel ? drawSelection(sel, w, h) : ''}</svg>`;
  }

  // Image du croquis (fond blanc) pour le modèle, au format de la case.
  async function rasterize(items, width, height) {
    const markup = svgMarkup(items, width, height, { background: '#ffffff' });
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Sketch export failed'))), 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* ---------- Géométrie et sélection ---------- */

  function strokeBounds(it) {
    const xs = it.points.map((p) => p[0]);
    const ys = it.points.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  function segmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // Élément sous le point (pixels de la case), le plus haut d'abord.
  function hitTest(items, px, py, w, h, tolerance = 8) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it.type === 'stroke') {
        const pts = it.points.map(([x, y]) => [x * w, y * h]);
        for (let k = 0; k < pts.length; k += 1) {
          const [ax, ay] = pts[k];
          const [bx, by] = pts[Math.min(k + 1, pts.length - 1)];
          if (segmentDistance(px, py, ax, ay, bx, by) <= tolerance) return it;
        }
        continue;
      }
      if (px >= it.x * w - 4 && px <= (it.x + it.w) * w + 4 && py >= it.y * h - 4 && py <= (it.y + it.h) * h + 4) return it;
      if (it.tx !== undefined && Math.hypot(px - it.tx * w, py - it.ty * h) <= tolerance) return it;
    }
    return null;
  }

  // Poignée de l'élément sélectionné sous le point : 'resize', 'tail' ou null.
  function hitHandle(it, px, py, w, h) {
    if (!it || it.type === 'stroke') return null;
    if (it.tx !== undefined && Math.hypot(px - it.tx * w, py - it.ty * h) <= 9) return 'tail';
    if (Math.abs(px - (it.x + it.w) * w) <= 9 && Math.abs(py - (it.y + it.h) * h) <= 9) return 'resize';
    return null;
  }

  function moveItem(it, dx, dy) {
    if (it.type === 'stroke') {
      it.points = it.points.map(([x, y]) => [x + dx, y + dy]);
      return;
    }
    it.x += dx;
    it.y += dy;
    if (it.tx !== undefined) {
      it.tx += dx;
      it.ty += dy;
    }
  }

  /* ---------- Description pour le prompt ---------- */

  function where(it) {
    const b = it.type === 'stroke' ? strokeBounds(it) : it;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const v = cy < 0.34 ? 'top' : cy > 0.66 ? 'bottom' : '';
    const hz = cx < 0.34 ? 'left' : cx > 0.66 ? 'right' : '';
    return [v, hz].filter(Boolean).join(' ') || 'center';
  }

  // Phrases décrivant les éléments du croquis (les traits libres ne sont pas décrits).
  function describe(items) {
    const out = [];
    for (const it of items || []) {
      const text = String(it.text || '').trim().replace(/\s+/g, ' ');
      const quoted = text ? `: "${text}"` : '';
      if (it.type === 'character') out.push(`a character${text ? ` (${text})` : ''} at the ${where(it)}, about ${Math.round(it.h * 100)}% of the panel height`);
      else if (it.type === 'speech') out.push(`a speech bubble at the ${where(it)}${quoted}`);
      else if (it.type === 'thought') out.push(`a thought bubble at the ${where(it)}${quoted}`);
      else if (it.type === 'caption') out.push(`a narrative caption box at the ${where(it)}${quoted}`);
      else if (it.type === 'sfx') out.push(`sound-effect lettering at the ${where(it)}${quoted}`);
    }
    return out;
  }

  const hasText = (items) => (items || []).some((it) => TEXT_TYPES.includes(it.type) && String(it.text || '').trim());

  global.ComicSketch = {
    TOOLS, BOX_TOOLS, TEXT_TYPES, createItem, defaultBox, svgMarkup, rasterize, hitTest, hitHandle, moveItem, strokeBounds, describe, hasText, uid,
  };
  if (typeof module !== 'undefined') module.exports = global.ComicSketch;
}(typeof window !== 'undefined' ? window : globalThis));
