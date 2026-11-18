// Tests du générateur (sans réseau, sans DOM) : node tests/generate.test.js
'use strict';
const assert = require('assert');
globalThis.crypto ??= require('crypto').webcrypto;
globalThis.TC_PROJECT = require('../web/project.js');
globalThis.TP_PROMPTS = { i2i: 'SYS-I2I', t2i: 'SYS-T2I' };
const P = globalThis.TC_PROJECT;
const G = require('../web/generate.js');
const { ComicGenerator, buildPanelPrompt, planImages, parseEnhanced, featherWeight, extendGeometry, streamSteps } = G;

// PNG 1×1 en base64.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function fakeStore() {
  const added = [];
  return {
    added,
    missing: new Set(),
    async dataUrl(id, { maxSide }) { return this.missing.has(id) ? null : `data:${id}@${maxSide}`; },
    async blob() { return null; },
    async addAsset(projectId, blob, meta) { const a = { id: `asset${added.length}`, projectId, blob, ...meta }; added.push(a); return a; },
  };
}

function fakeClient({ failFirst = false, previews = [] } = {}) {
  const calls = { image: [], chat: [] };
  let n = 0;
  return {
    calls,
    async streamImage(body, { onStart, onPreview }) {
      calls.image.push(body);
      n += 1;
      if (failFirst && n === 1) throw new Error('xh2a backend fail');
      onStart?.({});
      for (const step of previews) onPreview?.({ step, image: `prev${step}` });
      return { image: PNG, metadata: { elapsed_ms: 1234 } };
    },
    async streamChat(body, { onDelta }) {
      calls.chat.push(body);
      onDelta?.({ content: '', reasoning: 'hmm' });
      const answer = body.model.includes('PE') ? `<think>x</think>{"rewritten_prompt": "PE(${calls.chat.length})"}` : '{"rewritten_prompt": "LLM says \\"Bonjour !\\" <image1>"}';
      return { content: answer, reasoning: 'hmm', finish: 'stop' };
    },
  };
}

// Projet : 2 pages, la case cible est la 2e de la page 2.
const project = P.newProject({ format: 'bd' });
project.style = 'ink and watercolour';
project.synopsis = 'Alice cherche son chat.';
project.pages.push(P.newPage(project, 'twoRows'));
project.library = [{ assetId: 'refA', name: 'Alice' }, { assetId: 'refB', name: 'Le chat' }];
const order = P.readingOrder(project);
assert.strictEqual(order.length, 8);
order.forEach((e, i) => {
  e.panel.description = `scene ${i + 1}`;
  if (i < 7) {
    const v = { id: `v${i}`, assetId: `render${i}`, width: 1024, height: 768 };
    e.panel.versions.push(v);
    e.panel.current = v.id;
  }
});
order[5].panel.versions = []; // page 1, case 6 : pas de rendu
order[5].panel.current = null;
const target = order[7].panel;
target.refs = ['refA', 'refB'];

(async () => {
  const store = fakeStore();
  const loaded = [];
  const client = fakeClient({ previews: [1, 4, 8] });
  const gen = new ComicGenerator({
    getClient: () => client,
    store,
    ensureLoaded: async (id) => loaded.push(id),
    modelInfo: (id) => (id === 'llm-vl' ? { id, input: ['Text', 'Image'], thinking: { toggleable: true } } : { id, input: ['Text'] }),
    retryDelayMs: 5,
  });

  // Contexte : à travers les pages ; la case sans rendu est sautée pour les images.
  const ctx = await gen.buildContext(project, target.id, { contextImages: 2, contextTexts: 3 });
  assert.deepStrictEqual(ctx.previous.map((p) => `${p.page}-${p.panel}:${p.assetId}`), ['1-5:render4', '1-6:null', '2-1:render6']);
  assert.deepStrictEqual(ctx.refs, ['refA', 'refB']);
  assert.strictEqual(ctx.sketchAssetId, null);
  // Images plus anciennes que la fenêtre de textes : la description est gardée pour légender l'image.
  const ctx2 = await gen.buildContext(project, target.id, { contextImages: 3, contextTexts: 1 });
  assert.deepStrictEqual(ctx2.previous.map((p) => p.panelId), [order[3].panel.id, order[4].panel.id, order[6].panel.id]);
  // Première case du projet : aucun contexte.
  assert.deepStrictEqual((await gen.buildContext(project, order[0].panel.id)).previous, []);

  // Ordre des images et limite de 10 : références, précédentes (les plus anciennes tombent), croquis.
  const plan = planImages({
    refs: Array.from({ length: 4 }, (_, i) => ({ assetId: `r${i}`, name: `R${i}` })),
    previous: Array.from({ length: 8 }, (_, i) => ({ panelId: `p${i}`, page: 1, panel: i + 1, assetId: `img${i}` })),
    sketch: 'sk',
  });
  assert.strictEqual(plan.length, 10);
  assert.deepStrictEqual(plan.map((s) => s.kind), ['ref', 'ref', 'ref', 'ref', 'previous', 'previous', 'previous', 'previous', 'previous', 'sketch']);
  assert.deepStrictEqual(plan.filter((s) => s.kind === 'previous').map((s) => s.assetId), ['img3', 'img4', 'img5', 'img6', 'img7']);
  assert.deepStrictEqual(plan.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.strictEqual(planImages({ refs: Array.from({ length: 12 }, (_, i) => ({ assetId: `r${i}` })), sketch: 's' }).length, 10);

  // Prompt sans contexte : style + description seulement.
  const bare = buildPanelPrompt({ format: 'manga', style: '', description: 'Un chat sur un toit' });
  assert.strictEqual(bare, 'A single comic panel in black-and-white manga screentone style.\nThis panel: Un chat sur un toit.');

  // Requête de rendu complète.
  const req = await gen.buildRenderRequest({
    project, panelId: target.id, rect: { w: 1000, h: 600 }, mode: 'generate', preset: 'mp1',
    options: { model: 'Qwen/Qwen-Image-2.1', prompt: null, steps: 40, guidance: 1, seed: null, scheduler: '', negative: '', previewEvery: 4, contextImages: 2, contextTexts: 3 },
  });
  const { body, sources } = req;
  assert.deepStrictEqual(sources.map((s) => `${s.n}:${s.kind}:${s.assetId}`), ['1:ref:refA', '2:ref:refB', '3:previous:render4', '4:previous:render6']);
  assert.deepStrictEqual(body.images, ['data:refA@1024', 'data:refB@1024', 'data:render4@1024', 'data:render6@1024']);
  assert.deepStrictEqual([body.width, body.height], P.presetSize('mp1', 1000, 600));
  assert(body.seed >= 0 && body.seed <= 2147483646);
  assert.strictEqual(body.app_id, 'tiinycomics');
  assert.deepStrictEqual(body.stream_return_steps, [1, 4, 8, 12, 16, 20, 24, 28, 32, 36]);
  assert(!('scheduler' in body) && !('negative_prompt' in body));
  assert(body.prompt.startsWith('A single comic panel in Franco-Belgian BD style.\nGlobal style: ink and watercolour.'));
  assert(body.prompt.includes('Panel 1-5: scene 5. [shown in <image3>] Panel 1-6: scene 6. Panel 2-1: scene 7. [shown in <image4>]'));
  assert(body.prompt.includes('Reference images: <image1> is "Alice", <image2> is "Le chat".'));
  assert(body.prompt.includes('Keep characters, outfits and setting consistent'));
  assert(body.prompt.endsWith('This panel: scene 8.'));
  assert(!body.prompt.includes('<image5>'));
  console.log(`--- prompt ---\n${body.prompt}\n--------------`);

  // Image manquante dans le stock : retirée, renumérotation.
  store.missing.add('refA');
  const req2 = await gen.buildRenderRequest({ project, panelId: target.id, rect: { w: 1000, h: 600 }, options: { model: 'm', seed: 7, scheduler: 'euler', negative: 'blur', contextImages: 2, contextTexts: 3 } });
  store.missing.clear();
  assert.deepStrictEqual(req2.sources.map((s) => s.assetId), ['refB', 'render4', 'render6']);
  assert(req2.body.prompt.includes('<image1> is "Le chat"') && req2.body.prompt.includes('[shown in <image2>]'));
  assert.deepStrictEqual(req2.body.scheduler, { type: 'euler' });
  assert.strictEqual(req2.body.negative_prompt, 'blur');
  assert.deepStrictEqual(req2.body.stream_return_steps, []);
  // Prompt amélioré conservé : utilisé tel quel.
  const req3 = await gen.buildRenderRequest({ project, panelId: target.id, rect: { w: 1000, h: 600 }, options: { model: 'm', prompt: 'my final prompt' } });
  assert.strictEqual(req3.body.prompt, 'my final prompt');

  // Agrandissement : image de la case précédente (1024×768) vers mp2, au ratio de l'image.
  const up = await gen.buildRenderRequest({ project, panelId: order[6].panel.id, rect: { w: 500, h: 900 }, mode: 'upscale', preset: 'mp2', options: { model: 'm', seed: 1 } });
  assert.strictEqual(up.body.images[0], 'data:render6@2048');
  assert.strictEqual(up.sources[0].kind, 'current');
  assert.deepStrictEqual([up.body.width, up.body.height], P.sizeForArea(1024 / 768, 2 * 1024 * 1024));
  assert(up.body.prompt.startsWith('Redraw <image1> at a higher resolution'));
  await assert.rejects(gen.buildRenderRequest({ project, panelId: order[6].panel.id, rect: { w: 1, h: 1 }, mode: 'upscale', preset: 'draft', options: {} }), (e) => e.code === 'noUpscale');
  await assert.rejects(gen.buildRenderRequest({ project, panelId: target.id, rect: { w: 1, h: 1 }, mode: 'upscale', preset: 'mp4', options: {} }), (e) => e.code === 'noImage');

  // Rendu : chargement, étapes, aperçus (l'étape 1 n'est pas transmise), stockage, Version.
  const stagesSeen = [];
  const previewsSeen = [];
  const out = await gen.render({
    project, panelId: target.id, rect: { w: 1000, h: 600 }, mode: 'generate', preset: 'draft',
    options: { model: 'Qwen/Qwen-Image-2.1', seed: 42, previewEvery: 4, contextImages: 2, contextTexts: 3 },
    onStage: (s) => stagesSeen.push(s), onPreview: (p) => previewsSeen.push(p.step),
  });
  assert.deepStrictEqual(loaded, ['Qwen/Qwen-Image-2.1']);
  assert.deepStrictEqual(stagesSeen, ['embed', 'model', 'output']);
  assert.deepStrictEqual(previewsSeen, [4, 8]);
  assert.strictEqual(store.added.length, 1);
  assert.strictEqual(store.added[0].kind, 'render');
  const v = out.version;
  assert.strictEqual(v.assetId, 'asset0');
  assert.strictEqual(v.seed, 42);
  assert.strictEqual(v.steps, 20, 'draft preset steps');
  assert.deepStrictEqual(v.refs, ['refA', 'refB']);
  assert.deepStrictEqual(v.contextPanels, [order[4].panel.id, order[5].panel.id, order[6].panel.id]);
  assert.strictEqual(v.mode, 'generate');
  assert.strictEqual(target.versions.length, 0, 'project not mutated');
  assert.strictEqual(out.placement, undefined);
  assert(out.blob instanceof Blob && out.blob.size > 0);

  // « backend fail » sans étape reçue : une seule nouvelle tentative.
  const flaky = fakeClient({ failFirst: true });
  const gen2 = new ComicGenerator({ getClient: () => flaky, store, ensureLoaded: async () => {}, retryDelayMs: 5 });
  await gen2.render({ project, panelId: target.id, rect: { w: 1, h: 1 }, preset: 'draft', options: { model: 'm' } });
  assert.strictEqual(flaky.calls.image.length, 2);
  // Abandon pendant l'attente de la nouvelle tentative.
  const ctl = new AbortController();
  const gen3 = new ComicGenerator({ getClient: () => fakeClient({ failFirst: true }), store, retryDelayMs: 1000 });
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(gen3.render({ project, panelId: target.id, rect: { w: 1, h: 1 }, preset: 'draft', options: { model: 'm' }, signal: ctl.signal }), (e) => e.name === 'AbortError');

  // Chaîne d'amélioration : LLM qui voit les images puis PE-I2I.
  loaded.length = 0;
  client.calls.chat.length = 0;
  const progress = [];
  const enh = await gen.enhance({ project, panelId: target.id, llm: 'llm-vl', pe: 'auto', sampling: { temperature: 0.7, top_p: 0.9, top_k: 20 }, contextImages: 2, contextTexts: 3, onProgress: (p) => progress.push(p.stage) });
  assert.deepStrictEqual(loaded, ['llm-vl', G.PE_I2I]);
  const [llmCall, peCall] = client.calls.chat;
  assert.strictEqual(llmCall.messages[0].content, G.COMIC_SYSTEM_PROMPT);
  assert.deepStrictEqual(llmCall.chat_template_kwargs, { enable_thinking: false });
  assert.strictEqual(llmCall.max_tokens, 4000);
  assert.strictEqual(llmCall.temperature, 0.7);
  const llmParts = llmCall.messages[1].content;
  assert.strictEqual(llmParts.filter((c) => c.type === 'image_url').length, 4);
  assert(llmParts[0].text.includes('Synopsis: Alice cherche son chat.'));
  assert(llmParts[0].text.includes('- <image1>: reference image "Alice"'));
  assert(llmParts[0].text.includes('Panel to write (page 2, panel 2): scene 8'));
  assert.strictEqual(peCall.model, G.PE_I2I);
  assert.strictEqual(peCall.messages[0].content, 'SYS-I2I');
  assert.strictEqual(peCall.max_tokens, 24000);
  assert.strictEqual(peCall.messages[1].content[0].text, 'LLM says "Bonjour !" <image1>');
  assert.strictEqual(enh.prompt, 'PE(2)');
  assert.strictEqual(enh.stages.length, 2);
  assert.deepStrictEqual(progress, ['llm', 'pe']);

  // LLM texte seul, sans PE : pas d'images, pas de désactivation de réflexion.
  client.calls.chat.length = 0;
  const enh2 = await gen.enhance({ project, panelId: target.id, llm: 'llm-text', contextImages: 2, contextTexts: 3 });
  assert.strictEqual(typeof client.calls.chat[0].messages[1].content, 'string');
  assert(client.calls.chat[0].messages[1].content.includes('you cannot see them'));
  assert(!('chat_template_kwargs' in client.calls.chat[0]));
  assert.strictEqual(enh2.stages.length, 1);

  // PE seul, première case sans contexte : PE-T2I avec presence_penalty, sur le prompt construit.
  client.calls.chat.length = 0;
  await gen.enhance({ project, panelId: order[0].panel.id, pe: 'auto' });
  const t2i = client.calls.chat[0];
  assert.strictEqual(t2i.model, G.PE_T2I);
  assert.strictEqual(t2i.presence_penalty, 1.5);
  assert.strictEqual(t2i.messages[0].content, 'SYS-T2I');
  assert.strictEqual(t2i.messages[1].content, 'A single comic panel in Franco-Belgian BD style.\nGlobal style: ink and watercolour.\nThis panel: scene 1.');

  // Analyse des réponses.
  assert.deepStrictEqual(parseEnhanced('<think>a</think> {"rewritten_prompt": " x "}').prompt, 'x');
  assert.strictEqual(parseEnhanced('"plain text"').prompt, 'plain text');
  assert.strictEqual(parseEnhanced('<think>only</think>'), null);

  // Extension : géométrie et fondu.
  const geo = extendGeometry(1000, 1000, 1024, 512, { zoom: 0.5, x: 0, y: 0 });
  assert.deepStrictEqual(geo.covered, { x: 256, y: 0, w: 512, h: 512 });
  const g2 = extendGeometry(100, 100, 400, 200, { zoom: 0.25, x: 0, y: 0 }); // 100×100 centré
  assert.deepStrictEqual(g2.covered, { x: 150, y: 50, w: 100, h: 100 });
  assert.strictEqual(featherWeight(10, 10, g2.covered, 400, 200, 4), 0, 'outside');
  assert.strictEqual(featherWeight(200, 100, g2.covered, 400, 200, 4), 1, 'centre kept exactly');
  assert(featherWeight(150, 100, g2.covered, 400, 200, 4) < 0.2, 'border feathered');
  // Bord collé au bord du canevas : pas de fondu de ce côté.
  assert.strictEqual(featherWeight(0, 50, { x: 0, y: 0, w: 100, h: 200 }, 400, 200, 4), 1);
  assert.deepStrictEqual(streamSteps(8, 1), [1, 2, 3, 4, 5, 6, 7]);

  console.log('generate tests OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
