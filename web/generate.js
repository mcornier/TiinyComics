// Génération d'une case : contexte (cases précédentes, références), chaîne LLM puis PE, requête de rendu,
// agrandissement et extension. Ne lit aucun contrôle de l'interface : l'application passe tout en paramètre.
// Les fonctions pures (prompt, ordre des images) sont exportées pour tests/generate.test.js.
'use strict';

(() => {
  // Le tout est dans une fonction : les constantes ne doivent pas entrer en conflit avec celles d'app.js.
  const P = typeof TC_PROJECT !== 'undefined' ? TC_PROJECT : require('./project.js');

  const PE_I2I = 'Qwen/Qwen-Image-2.1-PE-I2I';
  const PE_T2I = 'Qwen/Qwen-Image-2.1-PE-T2I';
  const MAX_IMAGES = 10; // limite de l'API
  const CONTEXT_SIDE = 1024;
  const SOURCE_SIDE = 2048;
  const UPSCALE_MAX_REFS = 2; // chaque image coûte environ 15 s d'encodage : peu de références pour un agrandissement
  const EXTEND_MAX_REFS = 3;
  const RETOUCH_MAX_REFS = 3; // retouche locale : quelques références suffisent pour garder les personnages
  const RETRY_DELAY_MS = 10000;
  // Sans aperçu, rien ne signale la fin de l'encodage (mesures TiinyPaint, modèle chargé).
  const DEFAULT_SAMPLING = { temperature: 1, top_p: 0.95, top_k: 20 };

  const FORMAT_STYLES = {
    bd: 'Franco-Belgian BD',
    comics: 'American comic book',
    manga: 'black-and-white manga screentone',
    webtoon: 'full-colour webtoon',
  };

  // Pour le LLM généraliste : les PE Qwen ont leur propre prompt système officiel (TP_PROMPTS).
  const COMIC_SYSTEM_PROMPT = `You write the image prompt for ONE panel of a comic. The prompt is rendered by the Qwen-Image 2.1 diffusion model, which reads English best.
Use the story context (synopsis, previous panels) only for continuity: the same characters, faces, outfits, props, places, lighting and time of day as before. Describe only what is visible in this panel: shot type and camera angle, composition, each character's pose, expression and clothing, the setting, the lighting, and the art style of the comic. Write one concrete English paragraph, with no narration of events outside this panel.
Dialogue, captions, sound effects and any lettering: copy the exact text verbatim, in its original language, inside double quotes, and say where it appears (speech balloon of which character, caption box, sound effect). Never translate or rephrase it, and add no lettering the panel description does not ask for.
Images: refer to them only as <image1>, <image2>... with exactly the numbers listed in the request, which are the images the renderer receives in that order (for example "the woman from <image1>"). Never mention an image that is not listed.
Invent nothing that contradicts the panel description or the story.
Return one strictly valid JSON object and nothing else: {"rewritten_prompt": "..."}`;

  /* ---------- Fonctions pures ---------- */

  const sentence = (s) => {
    const text = String(s || '').trim();
    return !text || /[.!?…"»)]$/.test(text) ? text : `${text}.`;
  };

  const formatStyle = (format) => FORMAT_STYLES[format] || FORMAT_STYLES.bd;

  // Prompt de rendu d'une case. `previous` : [{ page, panel, description, imageN? }] dans l'ordre de lecture ;
  // `refs` : [{ imageN, name }] ; `sketchN` : numéro de l'image du croquis. N'évoque que les images envoyées.
  // Case guidée par un croquis. Testé sur le Tiiny : le croquis seul, une consigne courte de transformation et la
  // description donnent la case attendue ; avec les images des cases précédentes ou un long récit, le modèle
  // recopie les bonshommes ou reprend le décor d'une autre case.
  function buildSketchPrompt({ format, style = '', refs = [], sketchN, sketchNotes = [], description = '' }) {
    const look = `${formatStyle(format)} style${style.trim() ? ` (${style.trim().replace(/[.]$/, '')})` : ''}`;
    const parts = [`Transform <image${sketchN}>, a rough black-and-white layout sketch, into a finished, fully coloured comic panel in ${look}.`];
    if (description.trim()) parts.push(`Scene: ${sentence(description)}`);
    if (refs.length) {
      parts.push(`Reference images: ${refs.map((r) => `<image${r.imageN}> is ${r.name ? `"${r.name}"` : 'a reference image'}`).join(', ')}; draw them as they look there, without copying those images.`);
    }
    const named = sketchNotes.filter((n) => n.startsWith('a character ('));
    if (named.length) parts.push(`Stick figures: ${named.join('; ')}.`);
    parts.push('Replace each stick figure with a fully drawn, fully coloured character at the same position and size, and paint a complete, detailed background. Remove every stray sketch line. Keep the speech bubbles, caption boxes and sound effects exactly where they are, with exactly the same text.');
    return parts.join('\n');
  }

  function buildPanelPrompt(input) {
    if (input.sketchN) return buildSketchPrompt(input);
    const { format, style = '', previous = [], refs = [], description = '' } = input;
    const parts = [`A single comic panel in ${formatStyle(format)} style.`];
    if (style.trim()) parts.push(`Global style: ${sentence(style)}`);
    const story = previous.filter((p) => (p.description || '').trim() || p.imageN);
    if (story.length) {
      const lines = story.map((p) => {
        const text = sentence(p.description) || '(no description)';
        return `Panel ${p.page}-${p.panel}: ${text}${p.imageN ? ` [shown in <image${p.imageN}>]` : ''}`;
      });
      parts.push(`Earlier panels, for continuity only (do not draw them): ${lines.join(' ')}`);
    }
    if (refs.length) {
      parts.push(`Reference images: ${refs.map((r) => `<image${r.imageN}> is ${r.name ? `"${r.name}"` : 'a reference image'}`).join(', ')}.`);
    }
    if (refs.length || story.some((p) => p.imageN)) {
      parts.push('Keep characters, outfits and setting consistent with the reference and previous panel images, but use those images only as visual references: do not copy, include, tile or juxtapose them.');
    }
    if (description.trim()) parts.push(`This panel: ${sentence(description)}`);
    // Sans cette consigne, avec des images en entrée, le modèle a déjà empilé une case précédente et la nouvelle scène.
    if (refs.length || story.some((p) => p.imageN)) {
      parts.push('Output one single full-frame image showing only this panel: no split, no inner borders, no other panels.');
    }
    return parts.join('\n');
  }

  function buildUpscalePrompt(refs = []) {
    let prompt = 'Redraw <image1> at a higher resolution with sharper, cleaner detail. Keep exactly the same composition, framing, characters, poses, colours, line art and any lettering: add, remove or move nothing.';
    if (refs.length) {
      prompt += ` ${refs.map((r) => `<image${r.imageN}>${r.name ? ` ("${r.name}")` : ''}`).join(', ')} ${refs.length > 1 ? 'are references' : 'is a reference'} for the fine detail of characters and setting only.`;
    }
    return prompt;
  }

  // Un cadre magenta ne marche pas ici : le modèle l'ignore et ré-agrandit l'image. On prolonge l'image en miroir, floutée.
  function buildExtendPrompt({ format, style = '', description = '', refs = [] }) {
    const scene = description.trim() ? ` The panel shows: ${sentence(description)}` : '';
    const look = ` Match the ${formatStyle(format)} style of <image1>${style.trim() ? ` (${style.trim().replace(/[.]$/, '')})` : ''}.`;
    const ref = refs.length ? ` References: ${refs.map((r) => `<image${r.imageN}> is ${r.name ? `"${r.name}"` : 'a reference image'}`).join(', ')}.` : '';
    return `<image1> is a comic panel whose outer areas are blurry placeholders around the sharp original picture. Repaint the blurry areas with sharp, detailed content that extends the scene naturally beyond the original frame, keeping the same composition, scale and perspective.${scene}${look}${ref} Keep the sharp picture exactly where it is, at the same size: do not zoom, move or redraw it. No blur may remain.`;
  }

  // Retouche (mode Retouche) : consigne autour de la demande, reprise de TiinyPaint (wrapLocalPrompt).
  // `method` : 'fill' (zone magenta à repeindre), 'keep' (masque blanc envoyé en <image maskN>), 'whole' (sans masque).
  // `text` : correction de texte, le lettrage exact à écrire dans la zone. `refs` : [{ imageN, name }].
  function buildRetouchPrompt({ instruction = '', text = '', method = 'fill', maskN = null, refs = [] }) {
    const lettering = String(text || '').trim();
    const parts = [];
    if (String(instruction || '').trim()) parts.push(sentence(instruction));
    if (lettering) {
      parts.push(`Letter exactly this text as clean, legible comic lettering inside a speech balloon or caption box that fits the area: "${lettering}". Copy it letter for letter, in its original language, with correct spelling, and add no other words.`);
    }
    const edit = parts.join(' ');
    let prompt;
    if (method === 'keep') {
      prompt = `In <image1>, apply this edit only in the area shown white in the mask <image${maskN}>: ${edit} Everything outside the white area must stay exactly as in <image1>.`;
    } else if (method === 'whole') {
      prompt = `Edit <image1>: ${edit} Keep everything else exactly as in <image1>: same composition, characters, colours and line art.`;
    } else {
      prompt = `In <image1>, repaint the solid magenta area: ${edit} The result must blend naturally with its surroundings, and no magenta may remain. Everything outside the magenta area stays exactly unchanged.`;
    }
    if (refs.length) {
      prompt += ` Reference images: ${refs.map((r) => `<image${r.imageN}> is ${r.name ? `"${r.name}"` : 'a reference image'}`).join(', ')}; use them only to draw characters and setting as they look there, without copying them.`;
    }
    return prompt;
  }

  // Ordre des images : [image source] ou croquis, références, cases précédentes (les plus anciennes tombent en premier).
  // Renvoie les `sources` numérotées ; `previous` dans l'ordre de lecture, ceux sans image sont ignorés.
  function planImages({ current = null, refs = [], previous = [], sketch = null, max = MAX_IMAGES }) {
    const out = [];
    const push = (s) => out.push({ n: out.length + 1, ...s });
    if (current) push({ kind: 'current', assetId: current });
    // Le croquis passe en tête : le modèle le traite comme la base à transformer, pas comme une image à recopier.
    if (sketch && !current) push({ kind: 'sketch', assetId: sketch });
    let room = max - out.length;
    for (const r of refs.slice(0, Math.max(0, room))) push({ kind: 'ref', assetId: r.assetId, name: r.name || '' });
    room = max - out.length;
    const withImage = previous.filter((p) => p.assetId);
    for (const p of withImage.slice(Math.max(0, withImage.length - room))) {
      push({ kind: 'previous', assetId: p.assetId, panelId: p.panelId, name: `Page ${p.page}, panel ${p.panel}` });
    }
    return out;
  }

  // Étapes à décoder (la dernière est exclue : l'événement final porte l'image). Étape 1 ajoutée dès qu'il y a
  // des aperçus : c'est le seul signal de la fin de l'encodage, elle n'est pas affichée.
  // Aperçus affichés : à 50 %, 75 % et 90 % du rendu (avant, le latent décodé n'est que du bruit).
  function previewSteps(steps) {
    const list = [0.5, 0.75, 0.9].map((f) => Math.round(steps * f)).filter((n) => n > 2 && n < steps);
    return [...new Set(list)];
  }

  // Étapes demandées au flux : 1 et 2 (non affichées) mesurent l'encodage et la durée d'une étape,
  // puis les aperçus. Sans étape demandée, le flux ne signale rien et la progression serait aveugle.
  function streamSteps(steps, previews = true) {
    const list = [1, 2].filter((n) => n < steps);
    if (previews) list.push(...previewSteps(steps));
    return [...new Set(list)].sort((x, y) => x - y);
  }

  // Réponse d'un LLM ou d'un PE : JSON {"rewritten_prompt"}, éventuellement précédé de <think>, sinon texte brut.
  function parseEnhanced(raw) {
    const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        const data = JSON.parse(text.slice(start, end + 1));
        if (typeof data.rewritten_prompt === 'string' && data.rewritten_prompt.trim()) {
          return { prompt: data.rewritten_prompt.trim(), wh_ratio: data.wh_ratio || '', ratio_follow: data.ratio_follow || '' };
        }
      } catch { /* pas du JSON : traité comme du texte */ }
    }
    const plain = text.replace(/^"([\s\S]*)"$/, '$1').trim();
    return plain ? { prompt: plain, wh_ratio: '', ratio_follow: '' } : null;
  }

  // Extension : rectangle entier de l'image dans le canevas (rogné au canevas) et largeur du fondu.
  function extendGeometry(imgW, imgH, outW, outH, placement) {
    const r = P.placeImage(imgW, imgH, outW, outH, placement);
    const x0 = Math.max(0, Math.round(r.x));
    const y0 = Math.max(0, Math.round(r.y));
    const x1 = Math.min(outW, Math.round(r.x + r.w));
    const y1 = Math.min(outH, Math.round(r.y + r.h));
    return {
      draw: r, // position exacte (non rognée) pour drawImage
      covered: { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) },
      // Fondu large : le modèle redessine aussi la zone gardée, avec une teinte un peu différente.
      feather: Math.max(12, Math.round(Math.min(x1 - x0, y1 - y0) * 0.08)),
    };
  }

  // Poids de l'original (0..1) au pixel (x, y) : 1 au cœur de la zone couverte, fondu vers 0 sur les bords
  // intérieurs au canevas seulement (un bord collé au bord du canevas ne touche aucune zone repeinte).
  function featherWeight(x, y, covered, outW, outH, feather) {
    const { x: cx, y: cy, w, h } = covered;
    if (x < cx || y < cy || x >= cx + w || y >= cy + h) return 0;
    let d = Infinity;
    if (cx > 0) d = Math.min(d, x - cx + 0.5);
    if (cy > 0) d = Math.min(d, y - cy + 0.5);
    if (cx + w < outW) d = Math.min(d, cx + w - x - 0.5);
    if (cy + h < outH) d = Math.min(d, cy + h - y - 0.5);
    return Math.min(1, d / feather);
  }

  function dataUrlToBlob(dataUrl) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl || '');
    if (!m) throw codedError('noImage', 'Invalid image data');
    const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
    return new Blob([bytes], { type: m[1] || 'image/png' });
  }

  // Erreurs avec un `code` : l'application les traduit (tooManyImages, noUpscale, nothingToExtend, noImage...).
  function codedError(code, message) {
    const Ctor = typeof TiinyError !== 'undefined' ? TiinyError : Error;
    const err = new Ctor(message, 0);
    err.code = code;
    return err;
  }

  const randomSeed = () => Math.floor(Math.random() * 2147483647);

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
      const id = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(id);
        reject(new DOMException('Cancelled', 'AbortError'));
      }, { once: true });
    });
  }

  /* ---------- Canevas (navigateur seulement) ---------- */

  function makeCanvas(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  const canvasBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

  /* ---------- Générateur ---------- */

  class ComicGenerator {
    constructor({ getClient, store, ensureLoaded, modelInfo, retryDelayMs = RETRY_DELAY_MS }) {
      this.getClient = getClient;
      this.retryDelayMs = retryDelayMs;
      this.store = store;
      this.ensureLoaded = ensureLoaded || (async () => {});
      this.modelInfo = modelInfo || (() => undefined);
    }

    _client() {
      const client = this.getClient?.();
      if (!client) throw codedError('noClient', 'Not connected to the Tiiny');
      return client;
    }

    // Contexte d'une case : descriptions des `contextTexts` cases précédentes, et les rendus des
    // `contextImages` cases précédentes les plus proches qui en ont un. Ordre de lecture, toutes pages confondues.
    async buildContext(project, panelId, { contextImages = 2, contextTexts = 6 } = {}) {
      const loc = P.locatePanel(project, panelId);
      if (!loc) throw codedError('noPanel', 'Panel not found');
      const all = P.previousPanels(project, panelId);
      const withImage = new Set();
      for (let i = all.length - 1; i >= 0 && withImage.size < contextImages; i -= 1) {
        if (P.currentVersion(all[i].panel)) withImage.add(i);
      }
      const previous = [];
      all.forEach((e, i) => {
        const inText = i >= all.length - contextTexts;
        if (!inText && !withImage.has(i)) return;
        previous.push({
          panelId: e.panel.id,
          page: e.pageIndex + 1,
          panel: e.panelIndex + 1,
          description: e.panel.description || '',
          assetId: withImage.has(i) ? P.currentVersion(e.panel).assetId : null,
        });
      });
      return { previous, refs: [...loc.panel.refs], sketchAssetId: loc.panel.sketch?.assetId || null };
    }

    // Planifie et charge les images ; une image introuvable dans le stock est retirée et la liste renumérotée.
    async _images(plan, sides = {}) {
      const cache = new Map();
      const missing = new Set();
      for (;;) {
        const sources = planImages({
          ...plan,
          refs: plan.refs.filter((r) => !missing.has(r.assetId)),
          previous: plan.previous.map((p) => (missing.has(p.assetId) ? { ...p, assetId: null } : p)),
          sketch: missing.has(plan.sketch) ? null : plan.sketch,
        });
        let ok = true;
        for (const s of sources) {
          if (s.kind === 'current') continue; // fourni par l'appelant
          const key = s.assetId;
          if (!cache.has(key)) cache.set(key, await this.store.dataUrl(key, { maxSide: sides[s.kind] || CONTEXT_SIDE }));
          if (!cache.get(key)) {
            missing.add(key);
            ok = false;
          }
        }
        if (ok) return { sources, images: sources.map((s) => (s.kind === 'current' ? null : cache.get(s.assetId))) };
      }
    }

    // Contexte + images d'une génération ; partagé par le rendu et la chaîne d'amélioration.
    async _generateContext(project, panelId, { contextImages = 2, contextTexts = 6, useSketch = true } = {}) {
      const ctx = await this.buildContext(project, panelId, { contextImages, contextTexts });
      const names = new Map(project.library.map((l) => [l.assetId, l.name]));
      const sketch = useSketch ? ctx.sketchAssetId : null;
      const { sources, images } = await this._images({
        refs: ctx.refs.map((assetId) => ({ assetId, name: names.get(assetId) || '' })),
        // Avec un croquis, les cases précédentes ne passent qu'en texte (voir buildSketchPrompt).
        previous: sketch ? ctx.previous.map((p) => ({ ...p, assetId: null })) : ctx.previous,
        sketch,
      });
      const nByPanel = new Map(sources.filter((s) => s.kind === 'previous').map((s) => [s.panelId, s.n]));
      const loc = P.locatePanel(project, panelId);
      const promptInput = {
        format: project.format,
        style: project.style || '',
        previous: ctx.previous.map((p) => ({ ...p, imageN: nByPanel.get(p.panelId) || null })),
        refs: sources.filter((s) => s.kind === 'ref').map((s) => ({ imageN: s.n, name: s.name })),
        sketchN: sources.find((s) => s.kind === 'sketch')?.n || null,
        sketchNotes: sources.some((s) => s.kind === 'sketch') && typeof ComicSketch !== 'undefined' ? ComicSketch.describe(loc.panel.sketch?.items) : [],
        description: loc.panel.description || '',
      };
      return { ctx, sources, images, promptInput, panel: loc.panel, label: P.panelLabel(project, panelId) };
    }

    async buildRenderRequest({ project, panelId, rect, mode = 'generate', preset = 'mp1', options = {} }) {
      const loc = P.locatePanel(project, panelId);
      if (!loc) throw codedError('noPanel', 'Panel not found');
      const { panel } = loc;
      const o = options;
      let sources;
      let images;
      let prompt;
      let size;
      let plan = null;
      let contextPanels = [];
      const names = new Map(project.library.map((l) => [l.assetId, l.name]));
      const refList = (max) => panel.refs.slice(0, max).map((assetId) => ({ assetId, name: names.get(assetId) || '' }));

      if (mode === 'generate') {
        const g = await this._generateContext(project, panelId, o);
        ({ sources, images } = g);
        prompt = (o.prompt && o.prompt.trim()) || buildPanelPrompt(g.promptInput);
        size = P.presetSize(preset, rect.w, rect.h);
        contextPanels = g.promptInput.previous.map((p) => p.panelId);
      } else {
        const version = P.currentVersion(panel);
        if (!version) throw codedError('noImage', 'The panel has no image yet');
        if (mode === 'upscale') {
          if (!P.upscaleAvailable(preset, version.width, version.height)) throw codedError('noUpscale', 'The image is already at this size');
          size = P.sizeForArea(P.generationRatio(version.width, version.height), P.PRESETS[preset].area);
          ({ sources, images } = await this._images({ current: version.assetId, refs: refList(UPSCALE_MAX_REFS), previous: [] }));
          images[0] = await this.store.dataUrl(version.assetId, { maxSide: SOURCE_SIDE });
          if (!images[0]) throw codedError('noImage', 'Image not found');
          prompt = buildUpscalePrompt(sources.filter((s) => s.kind === 'ref').map((s) => ({ imageN: s.n, name: s.name })));
        } else if (mode === 'extend') {
          size = P.presetSize(preset, rect.w, rect.h);
          plan = await this._prepareExtend(version, size, panel.placement);
          ({ sources, images } = await this._images({ current: version.assetId, refs: refList(EXTEND_MAX_REFS), previous: [] }));
          images[0] = plan.image;
          prompt = buildExtendPrompt({
            format: project.format,
            style: project.style || '',
            description: panel.description || '',
            refs: sources.filter((s) => s.kind === 'ref').map((s) => ({ imageN: s.n, name: s.name })),
          });
        } else {
          throw codedError('badMode', `Unknown mode ${mode}`);
        }
        sources[0].name = 'current';
      }
      if (images.length > MAX_IMAGES) throw codedError('tooManyImages', 'Too many images');

      const [width, height] = size;
      const steps = o.steps || P.PRESETS[preset]?.steps || 40;
      const body = this._body(prompt, width, height, images, o, steps);
      return { body, sources, size: { width, height }, plan, contextPanels };
    }

    // Image actuelle cadrée comme dans la case, sur un canevas au format de la case ; le reste en miroir flouté.
    async _prepareExtend(version, [outW, outH], placement) {
      const blob = await this.store.blob(version.assetId);
      if (!blob) throw codedError('noImage', 'Image not found');
      const bitmap = await createImageBitmap(blob);
      const geo = extendGeometry(bitmap.width, bitmap.height, outW, outH, placement);
      if (!P.hasUncovered(bitmap.width, bitmap.height, outW, outH, placement) || !geo.covered.w || !geo.covered.h) {
        bitmap.close?.();
        throw codedError('nothingToExtend', 'The image already covers the panel');
      }
      // Calque de l'original seul (transparent ailleurs) : il sert aussi à la recomposition.
      const original = makeCanvas(outW, outH);
      const octx = original.getContext('2d');
      octx.save();
      octx.beginPath();
      octx.rect(geo.covered.x, geo.covered.y, geo.covered.w, geo.covered.h);
      octx.clip();
      octx.drawImage(bitmap, geo.draw.x, geo.draw.y, geo.draw.w, geo.draw.h);
      octx.restore();
      // Fond : l'image prolongée en miroir sur ses bords puis floutée, sans copie agrandie (pas de sujet fantôme).
      const sent = makeCanvas(outW, outH);
      const sctx = sent.getContext('2d');
      const d = geo.draw;
      sctx.filter = `blur(${Math.max(6, Math.round(Math.max(outW, outH) * 0.02))}px)`;
      for (let i = -2; i <= 2; i += 1) {
        for (let j = -2; j <= 2; j += 1) {
          sctx.save();
          sctx.translate(d.x + i * d.w + (i % 2 ? d.w : 0), d.y + j * d.h + (j % 2 ? d.h : 0));
          sctx.scale(i % 2 ? -1 : 1, j % 2 ? -1 : 1);
          sctx.drawImage(bitmap, 0, 0, d.w, d.h);
          sctx.restore();
        }
      }
      sctx.filter = 'none';
      bitmap.close?.();
      // Original posé avec un bord fondu : aucune arête nette entre l'image et la zone à repeindre.
      const soft = makeCanvas(outW, outH);
      const softCtx = soft.getContext('2d');
      softCtx.drawImage(original, 0, 0);
      const { x: cx, y: cy, w: cw, h: ch } = geo.covered;
      const px = softCtx.getImageData(cx, cy, cw, ch);
      for (let j = 0; j < ch; j += 1) {
        for (let i = 0; i < cw; i += 1) {
          const k = (j * cw + i) * 4 + 3;
          px.data[k] = Math.round(px.data[k] * featherWeight(cx + i, cy + j, geo.covered, outW, outH, geo.feather));
        }
      }
      softCtx.putImageData(px, cx, cy);
      sctx.drawImage(soft, 0, 0);
      return { image: sent.toDataURL('image/png'), original, geo, width: outW, height: outH };
    }

    // Garde les pixels d'origine là où l'image couvrait la case, avec un léger fondu sur la frontière.
    async _commitExtend(plan, dataUrl) {
      const { width: W, height: H, geo } = plan;
      const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
      const out = makeCanvas(W, H);
      const ctx = out.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, W, H);
      bitmap.close?.();
      const { x, y, w, h } = geo.covered;
      const dst = ctx.getImageData(x, y, w, h);
      const src = plan.original.getContext('2d').getImageData(x, y, w, h);
      for (let j = 0; j < h; j += 1) {
        for (let i = 0; i < w; i += 1) {
          const k = (j * w + i) * 4;
          const a = featherWeight(x + i, y + j, geo.covered, W, H, geo.feather) * (src.data[k + 3] / 255);
          if (!a) continue;
          for (let c = 0; c < 4; c += 1) dst.data[k + c] = Math.round(dst.data[k + c] * (1 - a) + src.data[k + c] * a);
        }
      }
      ctx.putImageData(dst, x, y);
      return canvasBlob(out);
    }

    /* ---------- Amélioration du prompt : LLM puis PE ---------- */

    async enhance({ project, panelId, llm = null, pe = null, sampling, contextImages = 2, contextTexts = 6, useSketch = true, signal, onProgress }) {
      const client = this._client();
      const g = await this._generateContext(project, panelId, { contextImages, contextTexts, useSketch });
      const base = { ...DEFAULT_SAMPLING, ...(sampling || {}) };
      const stages = [];
      let text = buildPanelPrompt(g.promptInput);

      const run = async (stage, plan, userText, images) => {
        await this.ensureLoaded(plan.model, signal);
        const started = Date.now();
        const content = images.length
          ? [{ type: 'text', text: userText }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
          : userText;
        const messages = [...(plan.system ? [{ role: 'system', content: plan.system }] : []), { role: 'user', content }];
        const output = await client.streamChat(
          { model: plan.model, messages, max_tokens: plan.max_tokens, ...base, ...plan.extra },
          {
            signal,
            onDelta: ({ content: answer, reasoning }) => onProgress?.({ stage, model: plan.model, reasoning, content: answer, elapsedMs: Date.now() - started }),
          },
        );
        const result = parseEnhanced(output.content);
        if (!result) throw codedError(output.finish === 'length' ? 'truncated' : 'emptyReply', 'The model returned no prompt');
        stages.push({ model: plan.model, prompt: result.prompt, reasoning: output.reasoning || '', ms: Date.now() - started });
        return result.prompt;
      };

      if (llm) {
        const info = this.modelInfo(llm);
        const seesImages = g.images.length > 0 && !!info?.input?.includes('Image');
        text = await run('llm', {
          model: llm,
          system: COMIC_SYSTEM_PROMPT,
          max_tokens: 4000,
          extra: info?.thinking?.toggleable ? { chat_template_kwargs: { enable_thinking: false } } : {},
        }, buildLlmRequest(project, g, seesImages), seesImages ? g.images : []);
      }
      if (pe) {
        // Choix explicite respecté ; « auto » : I2I avec images, T2I sinon.
        const i2i = pe === 'i2i' || (pe === 'auto' && g.images.length > 0);
        let plan;
        if (!i2i) plan = { model: PE_T2I, system: globalThis.TP_PROMPTS.t2i, max_tokens: 16256, extra: { presence_penalty: 1.5 } };
        else if (g.images.length) plan = { model: PE_I2I, system: globalThis.TP_PROMPTS.i2i, max_tokens: 24000, extra: {} };
        // Le prompt système de PE-I2I suppose toujours une image : on s'en passe sans image (comme TiinyPaint).
        else plan = { model: PE_I2I, system: null, max_tokens: 16256, extra: {} };
        text = await run('pe', plan, text, i2i ? g.images : []);
      }
      return { prompt: text, stages, sources: g.sources };
    }

    /* ---------- Rendu ---------- */

    // Envoie la requête en flux (après chargement du modèle) et relaie étapes et aperçus ; partagé par le rendu et la retouche.
    async _stream(body, { previews = true, signal, onStage, onStep, onPreview }) {
      const client = this._client();
      const shown = new Set(previewSteps(body.steps));
      await this.ensureLoaded(body.model, signal);
      let lastStep = 0;
      const attempt = () => client.streamImage(body, {
        signal,
        onStart: () => onStage?.('embed'),
        onPreview: (event) => {
          if (!lastStep) onStage?.('model');
          lastStep = Math.max(lastStep, event.step || 0);
          onStep?.({ step: event.step, total: body.steps, requested: body.stream_return_steps });
          if (shown.has(event.step) && previews) onPreview?.({ image: event.image, step: event.step, total: body.steps });
        },
      });
      let result;
      try {
        result = await attempt();
      } catch (err) {
        // Un modèle tout juste chargé peut répondre « xh2a backend fail » : on réessaie une fois.
        if (err.name === 'AbortError' || lastStep || !/backend fail/i.test(err.message || '')) throw err;
        await sleep(this.retryDelayMs, signal);
        result = await attempt();
      }
      onStage?.('output');
      return result;
    }

    // Corps commun d'une requête de rendu, avec les réglages de `options` (ceux de renderOptions dans app.js).
    _body(prompt, width, height, images, o, steps) {
      const body = {
        model: o.model,
        prompt,
        // La route en flux ignore `size` : width et height obligatoires.
        width,
        height,
        steps,
        guidance_scale: o.guidance ?? 1,
        seed: o.seed ?? randomSeed(),
        stream_return_steps: streamSteps(steps, o.previews ?? true),
        app_id: 'tiinycomics',
      };
      if (images.length) body.images = images;
      if (o.negative && o.negative.trim()) body.negative_prompt = o.negative.trim();
      if (o.scheduler) body.scheduler = { type: o.scheduler };
      return body;
    }

    /* ---------- Retouche ---------- */

    // Requête de retouche. `image` (et `maskImage` en méthode 'keep') viennent de Editor.prepareLocal, ou de
    // l'image entière sans masque ; les références de la case passent entre les deux, dans la limite de l'API.
    async buildRetouchRequest({ project, panelId, image, maskImage = null, width, height, method = 'fill', instruction = '', text = '', preset = 'mp1', options = {} }) {
      const loc = P.locatePanel(project, panelId);
      if (!loc) throw codedError('noPanel', 'Panel not found');
      const names = new Map(project.library.map((l) => [l.assetId, l.name]));
      const room = MAX_IMAGES - 1 - (maskImage ? 1 : 0);
      const refs = [];
      for (const assetId of loc.panel.refs.slice(0, Math.min(room, RETOUCH_MAX_REFS))) {
        const url = await this.store.dataUrl(assetId, { maxSide: CONTEXT_SIDE });
        if (url) refs.push({ assetId, name: names.get(assetId) || '', url, imageN: refs.length + 2 });
      }
      const images = [image, ...refs.map((r) => r.url)];
      if (maskImage) images.push(maskImage);
      const prompt = buildRetouchPrompt({ instruction, text, method, maskN: maskImage ? images.length : null, refs });
      const steps = options.steps || P.PRESETS[preset]?.steps || 40;
      return { body: this._body(prompt, width, height, images, options, steps), refs: refs.map((r) => r.assetId) };
    }

    // Lance la retouche ; renvoie l'image brute (data URL) : l'application la réintègre à travers le masque.
    async retouch({ signal, onStage, onStep, onPreview, ...request }) {
      this._client();
      const { body, refs } = await this.buildRetouchRequest(request);
      const result = await this._stream(body, { previews: request.options?.previews ?? true, signal, onStage, onStep, onPreview });
      return { body, refs, image: result.image, elapsedMs: result.metadata?.elapsed_ms ?? null };
    }

    async render({ project, panelId, rect, mode = 'generate', preset = 'mp1', options = {}, signal, onStage, onStep, onPreview }) {
      this._client();
      const { body, sources, plan, contextPanels } = await this.buildRenderRequest({ project, panelId, rect, mode, preset, options });
      const result = await this._stream(body, { previews: options.previews ?? true, signal, onStage, onStep, onPreview });
      const blob = plan ? await this._commitExtend(plan, result.image) : dataUrlToBlob(result.image);
      const asset = await this.store.addAsset(project.id, blob, { kind: 'render', width: body.width, height: body.height });
      const panel = P.locatePanel(project, panelId).panel;
      const parent = mode === 'generate' ? null : panel.current;
      const version = {
        id: P.uid(),
        assetId: asset.id,
        width: body.width,
        height: body.height,
        createdAt: Date.now(),
        mode,
        preset,
        description: panel.description || '',
        prompt: body.prompt,
        model: body.model,
        seed: body.seed,
        steps: body.steps,
        guidance: body.guidance_scale,
        refs: sources.filter((s) => s.kind === 'ref').map((s) => s.assetId),
        contextPanels,
        ...(sources.find((s) => s.kind === 'sketch') ? { sketchAssetId: sources.find((s) => s.kind === 'sketch').assetId } : {}),
        ...(parent ? { parent } : {}),
      };
      return { version, blob, ...(mode === 'extend' ? { placement: { zoom: 1, x: 0, y: 0 } } : {}), elapsedMs: result.metadata?.elapsed_ms ?? null };
    }
  }

  // Requête du LLM : tout le contexte en clair, et la liste des images que recevra le rendu, dans l'ordre.
  function buildLlmRequest(project, g, seesImages) {
    const lines = [`Comic format: ${formatStyle(project.format)}.`];
    if ((project.style || '').trim()) lines.push(`Global style of the comic: ${sentence(project.style)}`);
    if ((project.synopsis || '').trim()) lines.push(`Synopsis: ${sentence(project.synopsis)}`);
    const prev = g.promptInput.previous.filter((p) => p.description.trim() || p.imageN);
    if (prev.length) {
      lines.push('Previous panels, in reading order:');
      for (const p of prev) lines.push(`- Page ${p.page}, panel ${p.panel}: ${sentence(p.description) || '(no description)'}${p.imageN ? ` (its image is <image${p.imageN}>)` : ''}`);
    }
    if (g.sources.length) {
      lines.push(`Images the renderer will receive, in this order${seesImages ? ' (attached here in the same order)' : ' (you cannot see them: rely on these labels)'}:`);
      for (const s of g.sources) {
        const what = s.kind === 'ref' ? `reference image${s.name ? ` "${s.name}"` : ''}`
          : s.kind === 'previous' ? `previous panel (${s.name})`
            : 'rough sketch of this panel, to follow for composition';
        lines.push(`- <image${s.n}>: ${what}`);
      }
    } else {
      lines.push('No image is sent to the renderer: do not mention any <imageN>.');
    }
    const label = g.label ? ` (page ${g.label.page}, panel ${g.label.panel})` : '';
    lines.push(`Panel to write${label}: ${g.panel.description.trim() || '(no description: continue the story naturally)'}`);
    return lines.join('\n');
  }

  ComicGenerator.buildPanelPrompt = buildPanelPrompt;
  const helpers = {
    buildPanelPrompt, buildUpscalePrompt, buildExtendPrompt, buildRetouchPrompt, buildLlmRequest, planImages, previewSteps, streamSteps,
    parseEnhanced, extendGeometry, featherWeight, dataUrlToBlob, COMIC_SYSTEM_PROMPT, FORMAT_STYLES, PE_I2I, PE_T2I, MAX_IMAGES,
  };
  Object.assign(ComicGenerator, { helpers });
  if (typeof window !== 'undefined') window.ComicGenerator = ComicGenerator;
  if (typeof module !== 'undefined') module.exports = { ComicGenerator, ...helpers };
})();
