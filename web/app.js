'use strict';

const $ = (id) => document.getElementById(id);
const P = TC_PROJECT;

const STORAGE_KEY = 'tiinycomics.settings';
const DEFAULT_IMAGE_MODEL = 'Qwen/Qwen-Image-2.1';
// Nom annoncé par le Tiiny sur le réseau local (mDNS) : évite de chercher son IP.
const DEFAULT_BASE_URL = 'http://tiinyhost.local';
const PE_I2I = 'Qwen/Qwen-Image-2.1-PE-I2I';
const PE_T2I = 'Qwen/Qwen-Image-2.1-PE-T2I';
const PE_MODELS = { i2i: PE_I2I, t2i: PE_T2I };
const SAVE_DELAY_MS = 400;

const state = {
  client: null,
  models: [],
  running: [],
  // Modèle en cours de chargement, et liste qui doit le sélectionner une fois chargé.
  loading: null,
  abort: null,
  busy: false,
  settings: {},
  project: null,
  pageIndex: 0,
  selectedId: null,
  mode: 'layout',
  sketchTool: 'select',
  preset: 'mp1',
  randomSeed: true,
};

const store = new ComicStore();
let pageView = null;
let generator = null;
const pickers = new Map();
let openPickerSelect = null;
let connectionLabel = null;
let saveTimer = null;

/* ---------- Réglages persistés (clé API comprise, dans ce navigateur seulement) ---------- */

const PERSISTED_INPUTS = ['steps', 'draftSteps', 'guidance', 'seed', 'scheduler', 'negative', 'previewSteps', 'temperature', 'topP', 'topK', 'contextImages', 'contextTexts'];

function loadSettings() {
  try {
    state.settings = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    state.settings = {};
  }
}

function saveSettings() {
  const s = state.settings;
  for (const id of PERSISTED_INPUTS) s[id] = $(id).value;
  s.imageModel = $('imageModel').value || s.imageModel;
  s.peModel = $('peModel').value || s.peModel;
  s.llmModel = $('llmModel').value || s.llmModel;
  s.preset = state.preset;
  s.randomSeed = state.randomSeed;
  s.language = currentLang;
  s.lastProject = state.project?.id;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function applySettings() {
  const s = state.settings;
  for (const id of PERSISTED_INPUTS) if (s[id] !== undefined && s[id] !== null) $(id).value = s[id];
  if (P.PRESETS[s.preset]) state.preset = s.preset;
  if (typeof s.randomSeed === 'boolean') state.randomSeed = s.randomSeed;
}

/* ---------- Icônes ---------- */

// Ajoute l'icône de `data-icon`, et place le texte traduit dans un <span> pour que la traduction ne l'efface pas.
function decorateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.decorated) continue;
    el.dataset.decorated = '1';
    el.insertAdjacentHTML('afterbegin', iconSvg(el.dataset.icon));
    if (el.dataset.i18n) {
      const span = document.createElement('span');
      span.dataset.i18n = el.dataset.i18n;
      delete el.dataset.i18n;
      el.append(span);
    }
  }
}

function setIconLabel(el, icon, label) {
  el.innerHTML = iconSvg(icon);
  const span = document.createElement('span');
  span.textContent = label;
  el.append(span);
}

function iconButton(icon, title, onClick, className = 'btn icon-btn') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.innerHTML = iconSvg(icon);
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

/* ---------- Modèles ---------- */

const modelById = (id) => state.models.find((m) => m.id === id);
const modelName = (id) => modelById(id)?.display_name || id;
const isImageModel = (m) => m.type === 'Text-to-Image';
const isPromptEnhancer = (m) => m.supported?.includes('Prompt Enhance');
const isChatModel = (m) => isPromptEnhancer(m) || m.type === 'Image-Text-to-Text' || m.type === 'Text Generation';

function fillSelect(select, items, wanted) {
  select.replaceChildren(...items.map(([value, label]) => new Option(label, value)));
  if (items.some(([value]) => value === wanted)) select.value = wanted;
  syncPicker(select);
}

function renderModelSelects() {
  // Le premier de la liste est le défaut : le modèle officiel, jamais une variante non censurée
  // si un autre modèle est disponible, même si celle-ci est déjà chargée.
  const score = (m) => {
    if (m.id === DEFAULT_IMAGE_MODEL) return 0;
    if (/uncensored/i.test(m.id)) return 3;
    return state.running.includes(m.id) ? 1 : 2;
  };
  const images = state.models.filter(isImageModel).sort((a, b) => score(a) - score(b));
  const imageItems = images.length ? images.map((m) => [m.id, m.display_name]) : [['', t('noImageModel')]];
  fillSelect($('imageModel'), imageItems, $('imageModel').value || state.settings.imageModel);

  // Les enhancers sont faits pour Qwen-Image : ils ne sont proposés que s'ils sont installés.
  const pe = [['none', t('noPe')]];
  if (modelById(PE_I2I) || modelById(PE_T2I)) pe.push(['auto', t('peAuto')]);
  if (modelById(PE_I2I)) pe.push(['i2i', modelById(PE_I2I).display_name]);
  if (modelById(PE_T2I)) pe.push(['t2i', modelById(PE_T2I).display_name]);
  fillSelect($('peModel'), pe, $('peModel').value || state.settings.peModel || 'none');

  const llm = [['none', t('noLlm')]];
  for (const m of state.models) if (isChatModel(m) && !isPromptEnhancer(m)) llm.push([m.id, m.display_name]);
  fillSelect($('llmModel'), llm, $('llmModel').value || state.settings.llmModel || 'none');
  renderChain();
}

// Modèle réellement utilisé par l'enhancer « auto » : PE-I2I s'il y a des images à lui montrer.
function peChoice() {
  const v = $('peModel').value;
  if (!v || v === 'none') return null;
  return v;
}

function peModelIds(choice) {
  if (choice === 'auto') return [PE_I2I, PE_T2I].filter((id) => modelById(id));
  return PE_MODELS[choice] ? [PE_MODELS[choice]] : [];
}

function llmChoice() {
  const v = $('llmModel').value;
  return v && v !== 'none' ? v : null;
}

function renderModelList() {
  const shown = state.models
    .filter((m) => isImageModel(m) || isChatModel(m))
    .sort((a, b) => Number(state.running.includes(b.id)) - Number(state.running.includes(a.id)));
  $('modelList').replaceChildren(...shown.map((m) => {
    const running = state.running.includes(m.id);
    const row = document.createElement('div');
    row.className = 'model';
    const dot = document.createElement('span');
    dot.className = `dot${running ? ' on' : ''}`;
    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = m.display_name;
    const usage = document.createElement('span');
    usage.className = 'model-usage';
    usage.textContent = m.npu_usage ? t('npuPercent', { n: m.npu_usage }) : '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn small';
    button.textContent = running ? t('unload') : t('load');
    button.disabled = state.busy;
    button.addEventListener('click', () => withLock(() => (running ? unloadModel(m) : ensureLoaded(m.id))));
    row.append(dot, name, usage, button);
    return row;
  }));
  refreshPickers();
}

async function refreshModels() {
  const [models, running] = await Promise.all([state.client.models(), state.client.running()]);
  // La route renvoie aussi les modèles en cours de téléchargement : ils ne sont pas utilisables.
  state.models = models.filter((m) => m.status === 'running' || m.status === 'downloaded' || running.running.includes(m.id));
  state.running = running.running;
  renderModelSelects();
  renderModelList();
}

async function refreshRunning() {
  const running = (await state.client.running()).running;
  if (running.join() !== state.running.join()) {
    state.running = running;
    renderModelList();
  }
}

async function unloadModel(model) {
  setStatus(t('unloading', { m: model.display_name }));
  await state.client.stop(model.id);
  await refreshModels();
}

// `unload_candidate` ne suffit pas : certains modèles déclarent 0 % de NPU et le budget est alors faux.
// Un chargement accepté sans place réelle ne démarre jamais, sans erreur. On vérifie donc la mémoire réelle,
// et on propose de décharger en priorité les LLM, plus faciles à recharger qu'un modèle image.
async function freeRealMemory(id, label) {
  const percent = modelById(id)?.npu_usage;
  if (!percent) return;
  for (;;) {
    const device = (await state.client.npuStatus()).devices?.[0];
    if (!device?.mem_total_mb) return;
    const needed = (percent / 100) * device.mem_total_mb;
    if (device.mem_total_mb - device.mem_used_mb >= needed) return;
    await refreshRunning();
    const others = state.running.filter((m) => m !== id);
    if (!others.length) return;
    others.sort((a, b) => Number(isImageModel(modelById(a) || {})) - Number(isImageModel(modelById(b) || {})));
    const victim = others[0];
    if (!window.confirm(t('confirmUnload', { m: label, list: modelName(victim) }))) {
      throw new DOMException('Cancelled', 'AbortError');
    }
    setStatus(t('unloading', { m: modelName(victim) }));
    await state.client.stop(victim);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// Charge un modèle si besoin, en demandant confirmation s'il faut en décharger d'autres.
async function ensureLoaded(id, signal) {
  await refreshRunning();
  if (state.running.includes(id)) return;
  const label = modelName(id);
  const check = await state.client.unloadCandidate(id);
  if (check.unload_required) {
    const victims = check.model_id || [];
    const list = victims.map(modelName).join(', ');
    if (!window.confirm(t('confirmUnload', { m: label, list }))) {
      throw new DOMException('Cancelled', 'AbortError');
    }
    for (const victim of victims) {
      setStatus(t('unloading', { m: modelName(victim) }));
      await state.client.stop(victim);
    }
  }
  await freeRealMemory(id, label);
  setStatus(t('loading', { m: label }));
  state.loading = { id, select: state.loading?.id === id ? state.loading.select : null };
  refreshPickers();
  try {
    await state.client.launch(id);
    await state.client.waitRunning(id, { signal });
    await refreshRunning();
  } finally {
    state.loading = null;
    refreshPickers();
  }
}

// Charger depuis une liste de la chaîne sélectionne le modèle une fois chargé.
function loadAndSelect(select, value, id) {
  return withLock(async () => {
    state.loading = { id, select };
    try {
      await ensureLoaded(id);
    } finally {
      state.loading = null;
    }
    if (!state.running.includes(id)) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    syncPicker(select);
  });
}

/* ---------- Listes déroulantes (reprises de TiinyPaint) ---------- */

// Une liste native reste la source de vérité : le menu ne fait que la présenter dans le style de la page.
function pickerItems(select) {
  return [...select.options].map((option) => {
    const item = { value: option.value, label: option.textContent, group: null, model: null };
    if (select.id === 'imageModel') item.model = modelById(option.value);
    else if (select.id === 'llmModel' && option.value !== 'none') item.model = modelById(option.value);
    else if (select.id === 'peModel' && PE_MODELS[option.value]) item.model = modelById(PE_MODELS[option.value]);
    return item;
  });
}

function syncPicker(select) {
  const button = pickers.get(select);
  if (!button) return;
  const item = pickerItems(select).find((i) => i.value === select.value);
  const loadingHere = state.loading?.select === select;
  // La mention passe avant le nom : un nom long est coupé par la largeur du bloc.
  const label = loadingHere ? `(${t('loadingTag')}) ${modelName(state.loading.id)}` : item?.label || '';
  button.querySelector('.picker-label').textContent = label;
  button.classList.toggle('is-loading', loadingHere);
  button.title = label;
  if (select.id === 'language') button.querySelector('.picker-flag').innerHTML = flagSvg(select.value);
  button.classList.toggle('unloaded', !!item?.model && !state.running.includes(item.model.id));
  button.disabled = select.disabled || !select.options.length;
  const name = select.getAttribute('aria-label') || select.closest('label')?.querySelector('[data-i18n]')?.textContent;
  button.setAttribute('aria-label', name ? `${name} : ${item?.label || ''}` : item?.label || '');
}

function refreshPickers() {
  refreshActionButtons();
  renderChain();
  for (const select of pickers.keys()) syncPicker(select);
  if (openPickerSelect) renderPickerMenu();
}

function closePicker(focus = false) {
  if (!openPickerSelect) return;
  const button = pickers.get(openPickerSelect);
  button.setAttribute('aria-expanded', 'false');
  $('pickerMenu').hidden = true;
  openPickerSelect = null;
  if (focus) button.focus();
}

function renderPickerMenu() {
  const select = openPickerSelect;
  const menu = $('pickerMenu');
  const rows = [];
  for (const item of pickerItems(select)) {
    const running = item.model && state.running.includes(item.model.id);
    const row = document.createElement('div');
    row.className = `picker-row${item.value === select.value ? ' selected' : ''}${item.model && !running ? ' unloaded' : ''}`;
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'picker-option';
    choice.setAttribute('aria-current', String(item.value === select.value));
    choice.innerHTML = item.value === select.value ? iconSvg('check') : '<span class="picker-check"></span>';
    if (item.model) {
      const dot = document.createElement('span');
      dot.className = `dot${running ? ' on' : ''}`;
      choice.append(dot);
    }
    if (select.id === 'language') choice.insertAdjacentHTML('beforeend', flagSvg(item.value));
    const label = document.createElement('span');
    label.className = 'picker-name';
    label.textContent = item.label;
    choice.append(label);
    choice.addEventListener('click', () => {
      select.value = item.value;
      closePicker(true);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncPicker(select);
    });
    row.append(choice);
    if (item.model) {
      const load = document.createElement('button');
      load.type = 'button';
      load.className = 'btn small';
      load.textContent = state.loading?.id === item.model.id ? t('loadingTag') : t(running ? 'unload' : 'load');
      load.disabled = state.busy;
      const { model } = item;
      load.addEventListener('click', () => {
        if (running) withLock(() => unloadModel(model));
        else loadAndSelect(select, item.value, model.id);
      });
      row.append(load);
    }
    rows.push(row);
  }
  menu.replaceChildren(...rows);
  placePickerMenu();
}

// Le menu est au niveau du document : le flou des blocs et leur défilement ne doivent pas le contraindre.
function placePickerMenu() {
  const menu = $('pickerMenu');
  const rect = pickers.get(openPickerSelect).getBoundingClientRect();
  const hasModels = ['imageModel', 'peModel', 'llmModel'].includes(openPickerSelect.id);
  menu.style.minWidth = `${Math.max(rect.width, hasModels ? 340 : 0)}px`;
  menu.style.maxHeight = `${Math.max(rect.top, window.innerHeight - rect.bottom) - 16}px`;
  const height = menu.offsetHeight;
  const width = menu.offsetWidth;
  const below = window.innerHeight - rect.bottom >= height + 8;
  menu.style.top = `${below ? rect.bottom + 4 : rect.top - height - 4}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
}

function openPicker(select) {
  closePicker();
  closeMenus();
  toggleDevicePanel(false);
  openPickerSelect = select;
  pickers.get(select).setAttribute('aria-expanded', 'true');
  $('pickerMenu').hidden = false;
  renderPickerMenu();
  ($('pickerMenu').querySelector('.selected .picker-option') || $('pickerMenu').querySelector('.picker-option'))?.focus();
}

function enhancePickers() {
  for (const select of document.querySelectorAll('select')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `picker ${select.className}`.trim();
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    const flag = select.id === 'language' ? '<span class="picker-flag"></span>' : '';
    button.innerHTML = `${flag}<span class="picker-label"></span>${iconSvg('chevron-down')}`;
    button.addEventListener('click', () => {
      if (openPickerSelect === select) closePicker();
      else openPicker(select);
    });
    select.after(button);
    select.hidden = true;
    pickers.set(select, button);
    syncPicker(select);
  }
  // composedPath, car un clic sur Charger redessine la liste : la cible n'est déjà plus dans le document.
  document.addEventListener('click', (event) => {
    const inside = event.composedPath().some((el) => el.classList?.contains('picker') || el.classList?.contains('picker-menu'));
    if (openPickerSelect && !inside) closePicker();
  });
  let leaveTimer = null;
  $('pickerMenu').addEventListener('mouseleave', () => {
    leaveTimer = setTimeout(() => closePicker(), 350);
  });
  $('pickerMenu').addEventListener('mouseenter', () => clearTimeout(leaveTimer));
  $('pickerMenu').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const options = [...$('pickerMenu').querySelectorAll('.picker-option')];
    const index = options.indexOf(document.activeElement);
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    options[(next + options.length) % options.length]?.focus();
  });
  window.addEventListener('resize', () => closePicker());
}

/* ---------- Chaîne de modèles ---------- */

function renderChain(active = null) {
  const llm = llmChoice();
  const pe = peChoice();
  $('nodeLlm').classList.toggle('off', !llm);
  $('nodePe').classList.toggle('off', !pe);
  for (const [id, stage] of [['nodeLlm', 'llm'], ['nodePe', 'pe'], ['nodeModel', 'model']]) {
    $(id).classList.toggle('active', active === stage || (id === 'nodeModel' && active === 'output'));
  }
  const loadingImage = state.loading && state.loading.id === $('imageModel').value;
  $('nodeModel').classList.toggle('loading', !!loadingImage);
}

function setExpanded(button, body, open) {
  body.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  button.innerHTML = iconSvg(open ? 'chevron-down' : 'chevron-up');
}

/* ---------- Projet ---------- */

const project = () => state.project;
const selectedPanel = () => (state.selectedId && P.locatePanel(project(), state.selectedId)) || null;

// Enregistrement différé : une frappe ou un glissé ne déclenche qu'une écriture.
function touch({ now = false } = {}) {
  clearTimeout(saveTimer);
  if (!project()) return null;
  const write = () => store.saveProject(project()).catch((err) => setStatus(t('storageLost', { e: err.message }), { error: true }));
  if (now) return write();
  saveTimer = setTimeout(write, SAVE_DELAY_MS);
  return null;
}

async function openProject(p) {
  state.project = p;
  state.pageIndex = 0;
  state.selectedId = P.pagePanels(p.pages[0])[0]?.id || null;
  // Précharge les images du projet : la vue et les miniatures les affichent sans attendre.
  const ids = [...P.projectAssetIds(p)];
  await Promise.all(ids.map((id) => store.url(id).catch(() => null)));
  saveSettings();
  renderAll();
}

async function createProject(format = $('format').value || 'bd') {
  await touch({ now: true });
  const p = P.newProject({ title: '', format });
  await store.saveProject(p);
  await openProject(p);
}

function renderAll() {
  const p = project();
  $('projectTitle').value = p.title;
  $('format').value = p.format;
  syncPicker($('format'));
  $('projectStyle').value = p.style;
  $('synopsis').value = p.synopsis;
  renderPage();
  renderPanelEditor();
  renderLibrary();
}

function renderPage() {
  const p = project();
  const webtoon = P.formatOf(p).scroll;
  state.pageIndex = P.clamp(state.pageIndex, 0, p.pages.length - 1);
  pageView.show(p, { pageIndex: state.pageIndex, selectedId: state.selectedId });
  const n = p.pages.length;
  $('pageInfo').textContent = t(webtoon ? 'stripInfo' : 'pageInfo', { p: state.pageIndex + 1, n });
  $('prevPageBtn').disabled = state.pageIndex === 0;
  $('nextPageBtn').disabled = state.pageIndex >= n - 1;
  $('stripHeightBox').hidden = !webtoon;
  if (webtoon) $('stripHeight').value = P.pageSize(p, p.pages[state.pageIndex]).height;
  $('removePageBtn').disabled = n <= 1;
  setIconLabel($('addPageBtn'), 'file-plus', t(webtoon ? 'addStrip' : 'addPage'));
  renderPageList();
  renderLayoutButtons();
  fitPageBar();
}

function renderPageList() {
  const p = project();
  const { rtl, scroll } = P.formatOf(p);
  const list = $('pageList');
  list.classList.toggle('rtl', rtl);
  list.classList.toggle('webtoon', scroll);
  const width = scroll ? 66 : 104;
  list.replaceChildren(...p.pages.map((page, i) => {
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = `page-thumb${i === state.pageIndex ? ' current' : ''}`;
    thumb.draggable = true;
    thumb.append(renderMiniPage(p, page, width, { store, selectedId: state.selectedId }));
    const label = document.createElement('span');
    label.textContent = `${i + 1}`;
    thumb.append(label);
    thumb.addEventListener('click', () => goToPage(i));
    // Glisser une miniature sur une autre déplace la page à cet endroit.
    thumb.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-page', String(i)));
    thumb.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('text/x-page')) return;
      e.preventDefault();
      thumb.classList.add('drop-target');
    });
    thumb.addEventListener('dragleave', () => thumb.classList.remove('drop-target'));
    thumb.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = +e.dataTransfer.getData('text/x-page');
      if (Number.isNaN(from) || from === i) return;
      const [moved] = p.pages.splice(from, 1);
      p.pages.splice(i, 0, moved);
      state.pageIndex = i;
      touch();
      renderPage();
      renderPanelEditor();
    });
    return thumb;
  }));
  $('pageCount').textContent = String(p.pages.length);
  document.querySelector('.context-head h2[data-i18n="pages"]').textContent = t(scroll ? 'strips' : 'pages');
}

function goToPage(index) {
  const p = project();
  state.pageIndex = P.clamp(index, 0, p.pages.length - 1);
  const panels = P.pagePanels(p.pages[state.pageIndex]);
  if (!panels.some((x) => x.id === state.selectedId)) state.selectedId = panels[0]?.id || null;
  renderPage();
  renderPanelEditor();
  if (P.formatOf(p).scroll) pageView.scrollToPage(state.pageIndex);
}

function selectPanel(panelId) {
  const found = P.locatePanel(project(), panelId);
  if (!found) return;
  state.selectedId = panelId;
  const pageChanged = found.pageIndex !== state.pageIndex;
  state.pageIndex = found.pageIndex;
  if (pageChanged || !pageView.drag) renderPage();
  else {
    renderPageList();
    renderLayoutButtons();
  }
  renderPanelEditor();
}

function stepPanel(delta) {
  const order = P.readingOrder(project());
  const i = order.findIndex((e) => e.panel.id === state.selectedId);
  const next = order[P.clamp(i + delta, 0, order.length - 1)];
  if (next) {
    selectPanel(next.panel.id);
    if (P.formatOf(project()).scroll) pageView.scrollToPage(next.pageIndex);
  }
}

function addPage() {
  const p = project();
  const page = P.newPage(p);
  p.pages.splice(state.pageIndex + 1, 0, page);
  touch();
  goToPage(state.pageIndex + 1);
}

function removePage() {
  const p = project();
  if (p.pages.length <= 1) {
    setStatus(t('lastPage'), { error: true });
    return;
  }
  if (!window.confirm(t('confirmRemovePage', { p: state.pageIndex + 1 }))) return;
  p.pages.splice(state.pageIndex, 1);
  touch();
  goToPage(Math.min(state.pageIndex, p.pages.length - 1));
}

function setFormat(format) {
  const p = project();
  if (p.format === format) return;
  p.format = format;
  if (P.formatOf(p).scroll) for (const page of p.pages) page.height ||= P.FORMATS.webtoon.height;
  touch();
  renderAll();
}

/* ---------- Découpage ---------- */

function splitSelected(dir) {
  const sel = selectedPanel();
  if (!sel) return setStatus(t('selectPanelFirst'), { error: true });
  const added = P.splitPanel(sel.page, sel.panel.id, dir);
  state.selectedId = added.id;
  touch();
  renderPage();
  renderPanelEditor();
  return null;
}

function removeSelected() {
  const sel = selectedPanel();
  if (!sel) return;
  if (!sel.parent) {
    setStatus(t('lastPanel'), { error: true });
    return;
  }
  if (sel.panel.versions.length && !window.confirm(t('confirmRemovePanel', { n: sel.panel.versions.length }))) return;
  const order = P.pagePanels(sel.page);
  const index = order.findIndex((x) => x.id === sel.panel.id);
  P.removePanel(sel.page, sel.panel.id);
  const rest = P.pagePanels(sel.page);
  state.selectedId = rest[Math.max(0, index - 1)]?.id || null;
  touch();
  renderPage();
  renderPanelEditor();
}

function renderTemplateMenu() {
  const menu = $('templateMenu');
  menu.replaceChildren(...Object.keys(P.LAYOUT_TEMPLATES).map((name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'template-btn';
    b.title = t('applyTemplateTitle');
    b.innerHTML = templateIcon(name);
    const label = document.createElement('span');
    label.textContent = t(`tpl_${name}`);
    b.append(label);
    b.addEventListener('click', () => {
      P.applyTemplate(project(), project().pages[state.pageIndex], name);
      closeMenus();
      touch();
      renderPage();
      renderPanelEditor();
    });
    return b;
  }));
}

function swapPanels(a, b) {
  P.swapPanels(project(), a, b);
  // La sélection suit la case déplacée.
  state.selectedId = a;
  touch();
  renderPage();
  renderPanelEditor();
}

/* ---------- Éditeur de case ---------- */

function selectedRect() {
  const sel = selectedPanel();
  if (!sel) return null;
  return P.computeLayout(project(), sel.page).panels.find((r) => r.panelId === sel.panel.id) || null;
}

function renderPanelEditor() {
  const sel = selectedPanel();
  const editor = $('panelEditor');
  editor.classList.toggle('empty', !sel);
  for (const el of editor.querySelectorAll('textarea, button, input')) if (!el.classList.contains('collapse-btn')) el.disabled = !sel;
  if (!sel) {
    $('panelTitle').textContent = t('noPanel');
    return;
  }
  const { panel } = sel;
  const label = P.panelLabel(project(), panel.id);
  $('panelTitle').textContent = t('panelTitle', { p: label.page, n: label.panel });
  if (document.activeElement !== $('description')) $('description').value = panel.description;
  const hasEnhanced = panel.enhanced !== null && panel.enhanced !== undefined;
  $('enhanced').hidden = !hasEnhanced;
  $('clearEnhancedBtn').hidden = !hasEnhanced;
  $('enhanceHint').hidden = hasEnhanced;
  if (hasEnhanced && document.activeElement !== $('enhanced')) $('enhanced').value = panel.enhanced;
  renderPanelRefs();
  renderContextStrip();
  renderSketchSection();
  renderPresets();
  renderImprove();
  renderVersions();
  renderSeed();
  refreshActionButtons();
  const order = P.readingOrder(project());
  const i = order.findIndex((e) => e.panel.id === panel.id);
  $('prevPanelBtn').disabled = i <= 0;
  $('nextPanelBtn').disabled = i >= order.length - 1;
  const version = P.currentVersion(panel);
  setAmbient(version ? store.cachedUrl(version.assetId) : null);
}

function setAmbient(url) {
  const ambient = $('ambient');
  ambient.classList.toggle('has-image', !!url);
  ambient.style.background = url ? `center / cover no-repeat url("${url}")` : '';
}

function libraryEntry(assetId) {
  return project().library.find((l) => l.assetId === assetId);
}

function refThumb(assetId, { title, onClick, small = false, label } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'ref';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'ref-open';
  open.title = title || '';
  const url = store.cachedUrl(assetId);
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = title || '';
    open.append(img);
  } else {
    store.url(assetId).then((u) => u && renderPanelEditor());
  }
  if (onClick) open.addEventListener('click', onClick);
  wrap.append(open);
  if (label !== undefined && !small) {
    const tag = document.createElement('span');
    tag.className = 'ref-tag';
    tag.textContent = label;
    wrap.append(tag);
  }
  return wrap;
}

function renderPanelRefs() {
  const sel = selectedPanel();
  const box = $('panelRefs');
  const items = sel.panel.refs.filter(libraryEntry).map((id, i) => refThumb(id, {
    title: `${libraryEntry(id)?.name || t('refAlt', { n: i + 1 })} · ${t('removeRef', { n: i + 1 })}`,
    label: libraryEntry(id)?.name || `#${i + 1}`,
    onClick: () => toggleRef(id),
  }));
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'ref-add';
  add.title = t('addRef');
  add.setAttribute('aria-label', t('addRef'));
  add.innerHTML = iconSvg('plus');
  add.addEventListener('click', (e) => {
    e.stopPropagation();
    openRefMenu(add);
  });
  box.replaceChildren(...items, add);
  $('noPanelRefs').hidden = items.length > 0;
}

function toggleRef(assetId) {
  const sel = selectedPanel();
  if (!sel) return;
  const refs = sel.panel.refs;
  const i = refs.indexOf(assetId);
  if (i >= 0) refs.splice(i, 1);
  else refs.push(assetId);
  touch();
  renderPanelEditor();
  renderLibrary();
  if (!$('refMenu').hidden) renderRefMenu();
}

let refMenuAnchor = null;

function openRefMenu(anchor) {
  closeMenus();
  refMenuAnchor = anchor;
  $('refMenu').hidden = false;
  renderRefMenu();
}

function renderRefMenu() {
  const menu = $('refMenu');
  const sel = selectedPanel();
  const title = document.createElement('p');
  title.className = 'menu-title';
  title.textContent = t('addRef');
  const items = project().library.map((entry) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ref-pick${sel?.panel.refs.includes(entry.assetId) ? ' on' : ''}`;
    const img = document.createElement('img');
    img.src = store.cachedUrl(entry.assetId) || '';
    img.alt = entry.name;
    const name = document.createElement('span');
    name.textContent = entry.name || '—';
    b.append(img, name);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleRef(entry.assetId);
    });
    return b;
  });
  const children = [title, ...items];
  if (!items.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = t('libraryEmpty');
    children.push(hint);
  }
  menu.replaceChildren(...children);
  const r = refMenuAnchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - 320)}px`;
  menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8)}px`;
}

// Cases précédentes envoyées avec la case : leurs images (les plus proches) et leurs descriptions.
function renderContextStrip() {
  const sel = selectedPanel();
  const nImages = Math.max(0, +$('contextImages').value || 0);
  const nTexts = Math.max(0, +$('contextTexts').value || 0);
  const previous = P.previousPanels(project(), sel.panel.id);
  const withImages = previous.filter((e) => P.currentVersion(e.panel)).slice(-nImages);
  const texts = previous.filter((e) => e.panel.description.trim()).slice(-nTexts);
  const strip = $('contextStrip');
  strip.replaceChildren(...withImages.map((e) => refThumb(P.currentVersion(e.panel).assetId, {
    title: `${e.pageIndex + 1}·${e.panelIndex + 1} — ${e.panel.description}`,
    small: true,
    onClick: () => selectPanel(e.panel.id),
  })));
  $('contextHint').textContent = previous.length ? t('contextHint', { i: withImages.length, d: texts.length }) : t('contextNone');
}

function renderPresets() {
  for (const b of $('presets').children) b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset));
  const rect = selectedRect();
  if (!rect) return;
  const [w, h] = P.presetSize(state.preset, rect.w, rect.h);
  $('sizeHint').textContent = t('sizeHint', { w, h, mp: ((w * h) / 1e6).toFixed(2), pw: Math.round(rect.w), ph: Math.round(rect.h) });
}

function renderImprove() {
  const sel = selectedPanel();
  const version = P.currentVersion(sel.panel);
  const rect = selectedRect();
  for (const b of document.querySelectorAll('[data-upscale]')) {
    const ok = !!version && P.upscaleAvailable(b.dataset.upscale, version.width, version.height);
    b.disabled = !ok || state.busy;
    b.title = !version ? t('noImageYet') : ok ? '' : t('upscaleOff');
  }
  const uncovered = !!version && rect && P.hasUncovered(version.width, version.height, rect.w, rect.h, sel.panel.placement);
  $('extendBtn').disabled = !uncovered || state.busy;
  $('improveHint').textContent = !version ? t('noImageYet') : uncovered ? '' : t('extendNone');
}

function renderVersions() {
  const { panel } = selectedPanel();
  const box = $('versions');
  box.replaceChildren(...[...panel.versions].reverse().map((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `version${v.id === panel.current ? ' current' : ''}`;
    const mode = v.preset === 'draft' && v.mode === 'generate' ? 'draft' : v.mode;
    b.title = t('versionTitle', { mode: t(`versionMode_${mode}`), w: v.width, h: v.height, s: v.seed ?? '–' });
    const url = store.cachedUrl(v.assetId);
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = b.title;
      b.append(img);
    } else {
      store.url(v.assetId).then((u) => u && renderVersions());
    }
    const tag = document.createElement('span');
    tag.textContent = `${t(`versionMode_${mode}`)} · ${Math.round((v.width * v.height) / 1e5) / 10}`;
    b.append(tag);
    b.addEventListener('click', () => {
      panel.current = v.id;
      touch();
      renderPage();
      renderPanelEditor();
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openVersionMenu(e, panel, v);
    });
    return b;
  }));
  $('versionCount').textContent = panel.versions.length ? String(panel.versions.length) : '';
  $('noVersions').hidden = panel.versions.length > 0;
}

// Clic droit sur une version : l'ajouter à la bibliothèque (pour la réutiliser en référence) ou la supprimer.
function openVersionMenu(event, panel, version) {
  closeMenus();
  const menu = $('refMenu');
  menu.replaceChildren(
    menuItem('image-plus', t('addToLibrary'), () => addToLibrary(version.assetId, panel.description.slice(0, 40))),
    menuItem('trash-2', t('deleteVersion'), () => deleteVersion(panel, version)),
  );
  menu.style.display = 'flex';
  menu.style.width = 'auto';
  menu.hidden = false;
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 260)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 100)}px`;
}

async function deleteVersion(panel, version) {
  if (!window.confirm(t('confirmDeleteVersion'))) return;
  panel.versions = panel.versions.filter((v) => v.id !== version.id);
  if (panel.current === version.id) panel.current = panel.versions.at(-1)?.id || null;
  await touch({ now: true });
  // L'image n'est effacée que si plus rien ne s'en sert (bibliothèque, autre version).
  if (!P.projectAssetIds(project()).has(version.assetId)) await store.deleteAsset(version.assetId);
  renderPage();
  renderPanelEditor();
}

function renderSeed() {
  $('seedAuto').hidden = !state.randomSeed;
  $('seed').hidden = state.randomSeed;
  $('seedBtn').classList.toggle('active', !state.randomSeed);
  const title = t(state.randomSeed ? 'seedRandom' : 'seedFixed');
  $('seedBtn').title = title;
  $('seedBtn').setAttribute('aria-label', title);
}

/* ---------- Bibliothèque ---------- */

async function importImages(files) {
  const p = project();
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    try {
      const asset = await store.addAsset(p.id, file, { kind: 'ref', name: file.name.replace(/\.[^.]+$/, '') });
      await store.url(asset.id);
      p.library.push({ assetId: asset.id, name: asset.name });
    } catch {
      setStatus(t('unreadable'), { error: true });
    }
  }
  touch();
  renderLibrary();
  renderPanelEditor();
}

async function addToLibrary(assetId, name = '') {
  if (!libraryEntry(assetId)) project().library.push({ assetId, name });
  closeMenus();
  touch();
  renderLibrary();
  renderPanelEditor();
}

async function removeFromLibrary(entry) {
  if (!window.confirm(t('confirmRemoveLibrary'))) return;
  const p = project();
  p.library = p.library.filter((l) => l !== entry);
  for (const { panel } of P.readingOrder(p)) panel.refs = panel.refs.filter((id) => id !== entry.assetId);
  await touch({ now: true });
  if (!P.projectAssetIds(p).has(entry.assetId)) await store.deleteAsset(entry.assetId);
  renderLibrary();
  renderPanelEditor();
}

function renderLibrary() {
  const p = project();
  const sel = selectedPanel();
  $('library').classList.add('library');
  $('library').replaceChildren(...p.library.map((entry) => {
    const thumb = document.createElement('div');
    const used = !!sel?.panel.refs.includes(entry.assetId);
    thumb.className = `thumb${used ? ' selected' : ''}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'thumb-open';
    const url = store.cachedUrl(entry.assetId);
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = entry.name;
      open.append(img);
    }
    open.addEventListener('click', () => toggleRef(entry.assetId));
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'thumb-tick';
    tick.setAttribute('aria-pressed', String(used));
    tick.title = t('addAsRef');
    tick.innerHTML = used ? iconSvg('check') : '';
    tick.addEventListener('click', () => toggleRef(entry.assetId));
    const remove = iconButton('x', t('removeFromLibrary'), () => removeFromLibrary(entry), 'thumb-remove');
    const name = document.createElement('input');
    name.className = 'thumb-name';
    name.value = entry.name;
    name.placeholder = t('refNamePlaceholder');
    name.setAttribute('aria-label', t('refNamePlaceholder'));
    name.addEventListener('input', () => {
      entry.name = name.value;
      touch();
    });
    name.addEventListener('change', () => renderPanelEditor());
    thumb.append(open, tick, remove, name);
    return thumb;
  }));
  $('libraryCount').textContent = p.library.length ? String(p.library.length) : '';
}

/* ---------- Menus du haut ---------- */

function closeMenus() {
  for (const id of ['projectMenu', 'exportMenu', 'templateMenu', 'refMenu']) $(id).hidden = true;
  $('refMenu').style.display = '';
  $('refMenu').style.width = '';
  for (const id of ['projectBtn', 'exportBtn', 'templateBtn']) $(id).setAttribute('aria-expanded', 'false');
}

function toggleMenu(buttonId, menuId, render) {
  const open = $(menuId).hidden;
  closeMenus();
  closePicker();
  if (!open) return;
  render();
  $(menuId).hidden = false;
  $(buttonId).setAttribute('aria-expanded', 'true');
}

function menuItem(icon, label, onClick, { muted = '', current = false, disabled = false } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `menu-item${current ? ' current' : ''}`;
  b.disabled = disabled;
  b.innerHTML = iconSvg(icon);
  const span = document.createElement('span');
  span.textContent = label;
  b.append(span);
  if (muted) {
    const m = document.createElement('span');
    m.className = 'muted';
    m.textContent = muted;
    b.append(m);
  }
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenus();
    onClick();
  });
  return b;
}

const menuSep = () => Object.assign(document.createElement('div'), { className: 'menu-sep' });
const menuTitle = (text) => Object.assign(document.createElement('p'), { className: 'menu-title', textContent: text });

async function renderProjectMenu() {
  const menu = $('projectMenu');
  const list = await store.listProjects();
  const formatLabel = { bd: t('formatBd'), comics: t('formatComics'), manga: t('formatManga'), webtoon: t('formatWebtoon') };
  menu.replaceChildren(
    menuItem('file-plus', t('newProject'), () => createProject()),
    menuItem('upload', t('importProject'), () => $('projectFileInput').click()),
    menuItem('save', t('saveProjectFile'), saveProjectFile),
    menuSep(),
    menuTitle(t('openProjectTitle')),
    ...list.map((entry) => menuItem('book-open', entry.title || t('untitled'), async () => {
      await touch({ now: true });
      await openProject(await store.loadProject(entry.id));
    }, { muted: formatLabel[entry.format] || '', current: entry.id === project().id })),
    menuSep(),
    menuItem('trash-2', t('deleteProject'), deleteProject),
  );
}

async function saveProjectFile() {
  await touch({ now: true });
  const blob = await store.exportProjectFile(project());
  ComicExport.download(blob, ComicExport.fileName(project(), '', 'tiinycomic'));
  setStatus(t('projectSaved'));
}

async function deleteProject() {
  const p = project();
  if (!window.confirm(t('confirmDeleteProject', { t: p.title || t('untitled') }))) return;
  clearTimeout(saveTimer);
  await store.deleteProject(p.id);
  const rest = await store.listProjects();
  if (rest.length) await openProject(await store.loadProject(rest[0].id));
  else await createProject();
}

let exportScale = 1;

function renderExportMenu() {
  const p = project();
  const webtoon = P.formatOf(p).scroll;
  const scales = [[0.5, '50 %'], [1, '100 %'], [2, '200 %']];
  const row = document.createElement('div');
  row.className = 'pills';
  row.style.padding = '2px 8px 6px';
  for (const [value, label] of scales) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(exportScale === value));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      exportScale = value;
      renderExportMenu();
    });
    row.append(b);
  }
  const { width, height } = P.pageSize(p, p.pages[state.pageIndex]);
  $('exportMenu').replaceChildren(
    menuTitle(`${t('exportScale')} · ${Math.round(width * exportScale)}×${Math.round(height * exportScale)}`),
    row,
    menuItem('file-image', t('exportPagePng'), () => runExport('page')),
    menuItem('files', t('exportAllPng'), () => runExport('zip')),
    menuItem('file-text', t('exportPdf'), () => runExport('pdf')),
    ...(webtoon ? [menuItem('scroll-text', t('exportWebtoon'), () => runExport('long'))] : []),
  );
}

async function runExport(kind) {
  const p = project();
  const opts = { scale: exportScale };
  setStatus(t('exporting'));
  try {
    let blob;
    let name;
    if (kind === 'page') {
      blob = await ComicExport.exportPagePng(p, state.pageIndex, store, opts);
      name = ComicExport.fileName(p, `page-${String(state.pageIndex + 1).padStart(3, '0')}`, 'png');
    } else if (kind === 'zip') {
      blob = await ComicExport.exportAllPng(p, store, opts);
      name = ComicExport.fileName(p, 'pages', 'zip');
    } else if (kind === 'pdf') {
      blob = await ComicExport.exportPdf(p, store, opts);
      name = ComicExport.fileName(p, '', 'pdf');
    } else {
      const result = await ComicExport.exportWebtoonLong(p, store, opts);
      blob = result.blob;
      name = ComicExport.fileName(p, 'webtoon', result.kind);
    }
    ComicExport.download(blob, name);
    setStatus(t('exported', { f: name }));
  } catch (err) {
    setStatus(err.message || String(err), { error: true });
  }
}

/* ---------- Génération ---------- */

function generateBlocker() {
  const id = $('imageModel').value;
  if (!id) return { node: 'nodeModel', message: t('noImageModel') };
  return state.running.includes(id) ? null : { node: 'nodeModel', message: t('loadModelFirst', { m: modelName(id) }) };
}

function enhanceBlocker() {
  const llm = llmChoice();
  const pe = peChoice();
  if (!llm && !pe) return { node: 'nodeLlm', message: t('chooseChain') };
  if (llm && !state.running.includes(llm)) return { node: 'nodeLlm', message: t('loadModelFirst', { m: modelName(llm) }) };
  if (pe && !peModelIds(pe).some((id) => state.running.includes(id))) {
    return { node: 'nodePe', message: t('loadModelFirst', { m: modelName(peModelIds(pe)[0] || PE_I2I) }) };
  }
  return null;
}

function refreshActionButton(button, blocker, disabled) {
  button.disabled = disabled;
  button.classList.toggle('unavailable', !!blocker);
  button.setAttribute('aria-disabled', String(!!blocker));
  button.title = blocker ? blocker.message : '';
}

function refreshActionButtons() {
  const noPanel = !state.selectedId;
  refreshActionButton($('enhanceBtn'), enhanceBlocker(), state.busy || !connectionLabel || noPanel);
  refreshActionButton($('generateBtn'), generateBlocker(), !connectionLabel || noPanel);
}

function flashNode({ node: id, message }) {
  const node = $(id);
  node.classList.remove('flash');
  // Force un nouveau calcul de style pour relancer l'animation si elle est déjà en cours.
  void node.offsetWidth;
  node.classList.add('flash');
  setStatus(message, { error: true });
}

function renderOptions(preset) {
  return {
    model: $('imageModel').value,
    steps: +(preset === 'draft' ? $('draftSteps').value : $('steps').value),
    guidance: +$('guidance').value,
    seed: state.randomSeed ? null : +$('seed').value,
    scheduler: $('scheduler').value,
    negative: $('negative').value.trim(),
    previews: $('previewSteps').value !== '0',
    contextImages: Math.max(0, +$('contextImages').value || 0),
    contextTexts: Math.max(0, +$('contextTexts').value || 0),
    useSketch: true,
  };
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

async function enhancePanel() {
  const blocker = enhanceBlocker();
  if (blocker) return flashNode(blocker);
  const sel = selectedPanel();
  if (!sel.panel.description.trim()) return setStatus(t('describeFirst'), { error: true });
  const panelId = sel.panel.id;
  const controller = beginTask();
  try {
    await prepareSketch(sel.panel, selectedRect());
  } catch (err) {
    console.warn('Sketch export failed', err);
  }
  $('thinkingBox').hidden = false;
  $('thinking').textContent = '';
  $('thinkingSummary').textContent = t('thinking');
  const started = Date.now();
  try {
    const result = await generator.enhance({
      project: project(),
      panelId,
      llm: llmChoice(),
      pe: peChoice(),
      sampling: { temperature: +$('temperature').value, top_p: +$('topP').value, top_k: +$('topK').value },
      contextImages: renderOptions(state.preset).contextImages,
      contextTexts: renderOptions(state.preset).contextTexts,
      useSketch: sketchActive(sel.panel),
      signal: controller.signal,
      onProgress: ({ stage, model, reasoning, content, elapsedMs }) => {
        renderChain(stage);
        const box = $('thinking');
        const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
        box.textContent = `[${t(stage === 'llm' ? 'stageLlm' : 'stagePe')}] ${reasoning || ''}${content ? `\n\n${content}` : ''}`;
        if (atEnd) box.scrollTop = box.scrollHeight;
        setStatus(t(content ? 'writingStatus' : 'thinkingStatus', { m: modelName(model), t: formatDuration((elapsedMs ?? Date.now() - started) / 1000) }));
      },
    });
    const panel = P.locatePanel(project(), panelId)?.panel;
    if (panel) panel.enhanced = result.prompt;
    touch();
    $('thinkingSummary').textContent = t('thinkingDone', { t: formatDuration((Date.now() - started) / 1000) });
    setStatus(t('enhanced'));
  } catch (err) {
    reportError(err, 'enhanceStopped');
  } finally {
    renderChain();
    endTask();
    renderPanelEditor();
  }
  return null;
}

/* ---------- Fusion, regroupement, rangées ---------- */

function mergeSelected() {
  const page = project().pages[state.pageIndex];
  const kept = state.selectedId && P.mergePanel(page, state.selectedId);
  if (!kept) return setStatus(t('mergeNone'), { error: true });
  touch();
  renderAll();
  setStatus(t('merged'));
  return null;
}

function regroup(page, nodeId) {
  const target = P.transposableFor(page, nodeId);
  if (!target || !P.transposeSplit(page, target.id)) return setStatus(t('regroupNone'), { error: true });
  touch();
  renderAll();
  setStatus(t('regrouped'));
  return null;
}

function addRow(pageIndex) {
  const page = project().pages[pageIndex];
  const width = P.pageSize(project(), page).width;
  const panel = P.appendRow(project(), page, Math.round(width * 0.75));
  if (!panel) return setStatus(t('stripMax'), { error: true });
  state.pageIndex = pageIndex;
  state.selectedId = panel.id;
  touch();
  renderAll();
  return null;
}

// Boutons de la barre de page qui dépendent de la case sélectionnée.
function renderLayoutButtons() {
  const page = project()?.pages[state.pageIndex];
  const entry = page && state.selectedId && P.findLeaf(page, state.selectedId);
  const parent = entry?.parent;
  const i = entry?.index ?? -1;
  const neighbour = parent && (parent.children[i + 1] || parent.children[i - 1]);
  $('mergePanelBtn').disabled = !(neighbour && neighbour.kind === 'panel');
  $('regroupBtn').disabled = !(entry && P.transposableFor(page, entry.node.id));
  $('removePanelBtn').disabled = !parent;
}

/* ---------- Croquis ---------- */

const MODE_HINTS = { layout: 'modeLayoutHint', frame: 'modeFrameHint', sketch: 'modeSketchHint' };

// Barre de page : on retire les libellés, puis les éléments secondaires, tant qu'elle déborde.
const BAR_LEVELS = ['bar-icons', 'bar-tight', 'bar-tiny'];
function fitPageBar() {
  const bar = document.querySelector('.page-bar');
  bar.classList.remove(...BAR_LEVELS);
  for (const level of BAR_LEVELS) {
    if (bar.scrollWidth <= bar.clientWidth + 1) break;
    bar.classList.add(level);
  }
}

function setMode(mode) {
  state.mode = mode;
  for (const x of $('modes').children) x.setAttribute('aria-pressed', String(x.dataset.mode === mode));
  $('layoutTools').hidden = mode === 'sketch';
  $('sketchTools').hidden = mode !== 'sketch';
  pageView.sketchSel = null;
  pageView.setMode(mode);
  fitPageBar();
  setStatus(t(MODE_HINTS[mode]));
}

function setSketchTool(tool) {
  state.sketchTool = tool;
  pageView.sketchTool = tool;
  for (const x of $('sketchTools').children) x.setAttribute('aria-pressed', String(x.dataset.tool === tool));
  setStatus(t(`toolHint_${tool}`));
}

const sketchActive = (panel) => !!panel?.sketch?.items?.length && panel.sketch.use !== false;

function renderSketchSection() {
  const panel = selectedPanel()?.panel;
  if (!panel) return;
  const n = panel.sketch?.items?.length || 0;
  $('sketchCount').textContent = n ? String(n) : '';
  $('sketchUse').checked = panel.sketch?.use !== false;
  $('sketchUse').disabled = !n;
  $('sketchClearBtn').disabled = !n;
  $('sketchHint').textContent = t(n ? (panel.sketch.use !== false ? 'sketchOn' : 'sketchOff') : 'sketchEmpty');
}

function clearSketch() {
  const panel = selectedPanel()?.panel;
  if (!panel?.sketch?.items?.length || !window.confirm(t('confirmSketchClear'))) return;
  pageView._sketchHistoryOf(panel).push(JSON.stringify(panel.sketch.items));
  panel.sketch.items = [];
  pageView.sketchSel = null;
  touch();
  renderPage();
  renderSketchSection();
}

// Image du croquis envoyée au modèle, au format de la case. Chaque état dessiné est gardé comme image
// (rien n'est purgé) ; elle n'est refaite que si le croquis ou le format de la case a changé.
async function prepareSketch(panel, rect) {
  if (!sketchActive(panel) || !rect) return;
  const ratio = rect.w / rect.h;
  const width = Math.round(ratio >= 1 ? 1024 : 1024 * ratio);
  const height = Math.round(ratio >= 1 ? 1024 / ratio : 1024);
  const sig = `${width}x${height}:${JSON.stringify(panel.sketch.items)}`;
  if (panel.sketch.assetId && panel.sketch.sig === sig) return;
  const blob = await ComicSketch.rasterize(panel.sketch.items, width, height);
  const asset = await store.addAsset(project().id, blob, { kind: 'sketch', width, height });
  panel.sketch.assetId = asset.id;
  panel.sketch.sig = sig;
  await touch({ now: true });
}

/* ---------- Progression d'un rendu ---------- */

// Le flux ne signale que les étapes demandées (1, 2, puis les aperçus) : entre deux, on extrapole
// à partir de la durée mesurée d'une étape, sans dépasser la prochaine étape attendue.
function estimateProgress(p, now = Date.now()) {
  if (p.phase === 'output') return { pct: 99, step: p.total, remaining: 0 };
  const points = p.points;
  if (!points.length) return { pct: 0, step: 0, remaining: null };
  const first = points[0];
  const last = points[points.length - 1];
  const rate = last.step > first.step ? (last.t - first.t) / (last.step - first.step) : null;
  const next = p.requested.find((n) => n > last.step) ?? p.total;
  const step = Math.min(next - 0.2, last.step + (rate ? (now - last.t) / rate : 0));
  return {
    pct: Math.max(0, Math.min(98, (step / p.total) * 100)),
    step,
    remaining: rate ? Math.max(0, ((p.total - step) * rate) / 1000) : null,
  };
}

function renderGenInfo(p) {
  if (!p) {
    $('nodeModel').classList.remove('generating');
    $('genInfo').hidden = true;
    return;
  }
  const est = estimateProgress(p);
  const pct = Math.floor(est.pct);
  $('nodeModel').classList.add('generating');
  $('genInfo').hidden = false;
  $('genTitle').textContent = p.title;
  $('genPct').textContent = `${pct} %`;
  $('genBarFill').style.width = `${est.pct}%`;
  $('genDetail').textContent = {
    prep: t('genPrep'),
    embed: t('genEmbed'),
    model: t('genStep', { s: Math.max(1, Math.floor(est.step)), n: p.total }),
    output: t('genOutput'),
  }[p.phase];
  const elapsed = formatDuration((Date.now() - p.started) / 1000);
  $('genTime').textContent = est.remaining !== null && p.phase === 'model' ? t('genTime', { t: elapsed, r: formatDuration(est.remaining) }) : elapsed;
  pageView.setProgress(est.pct, `${pct} %`);
}

// mode : 'generate' (preset choisi), 'upscale' (preset cible) ou 'extend'.
async function renderPanel(mode, preset = state.preset) {
  const blocker = generateBlocker();
  if (blocker) return flashNode(blocker);
  const sel = selectedPanel();
  if (!sel) return setStatus(t('selectPanelFirst'), { error: true });
  const { panel } = sel;
  if (mode === 'generate' && !panel.description.trim() && !panel.enhanced) return setStatus(t('describeFirst'), { error: true });
  const rect = selectedRect();
  const controller = beginTask();
  const started = Date.now();
  const label = P.panelLabel(project(), panel.id);
  let lastStep = 0;
  let total = 0;
  const presetLabel = preset === 'draft' ? t('presetDraft') : `${preset.replace('mp', '')} MP`;
  const progress = {
    title: `${t('panelShort', { n: `${label.page}·${label.panel}` })} · ${mode === 'extend' ? t('versionMode_extend') : `${t(`versionMode_${mode}`)} ${presetLabel}`}`,
    phase: 'prep',
    points: [],
    requested: [],
    total: 0,
    started,
  };
  const tick = () => {
    const elapsed = t('elapsed', { t: formatDuration((Date.now() - started) / 1000) });
    renderGenInfo(progress);
    setStatus(lastStep ? `${$('genDetail').textContent} · ${elapsed}` : `${t('rendering', { n: `${label.page}·${label.panel}` })} ${elapsed}`);
  };
  const timer = setInterval(tick, 250);
  pageView.setRendering({ panelId: panel.id, url: null, label: '0 %', progress: 0 });
  tick();
  renderChain('model');
  try {
    await prepareSketch(panel, rect);
    const options = { ...renderOptions(preset), prompt: panel.enhanced || null, useSketch: sketchActive(panel) };
    const result = await generator.render({
      project: project(),
      panelId: panel.id,
      rect: { w: rect.w, h: rect.h },
      mode,
      preset,
      options,
      signal: controller.signal,
      onStage: (stage) => {
        if (stage === 'embed' || stage === 'output') progress.phase = stage;
        renderChain(stage === 'output' ? 'output' : 'model');
      },
      onStep: ({ step, total: n, requested }) => {
        Object.assign(progress, { phase: 'model', total: n, requested });
        progress.points.push({ step, t: Date.now() });
        lastStep = step;
        total = n;
      },
      onPreview: ({ image }) => {
        const img = new Image();
        img.onload = () => pageView.setRendering({ ...pageView.rendering, panelId: panel.id, url: image, width: img.naturalWidth, height: img.naturalHeight });
        img.src = image;
      },
    });
    const target = P.locatePanel(project(), panel.id)?.panel;
    if (target) {
      target.versions.push(result.version);
      target.current = result.version.id;
      target.placement = result.placement || { zoom: 1, x: 0, y: 0 };
    }
    await store.url(result.version.assetId);
    await touch({ now: true });
    if (state.randomSeed && result.version.seed !== undefined) $('seed').value = result.version.seed;
    const v = result.version;
    setStatus(t('done', { t: formatDuration((Date.now() - started) / 1000), w: v.width, h: v.height, s: v.seed ?? '–' }));
  } catch (err) {
    if (err.name === 'AbortError' && lastStep) setStatus(t('stoppedAt', { s: lastStep, n: total }));
    else reportError(err, 'renderStopped');
  } finally {
    clearInterval(timer);
    renderGenInfo(null);
    pageView.rendering = null;
    renderChain();
    endTask();
    renderPage();
    renderPanelEditor();
  }
  return null;
}

/* ---------- Tâches ---------- */

function setStatus(text, { error = false } = {}) {
  const status = $('status');
  status.textContent = text;
  status.classList.toggle('error-text', error);
}

function reportError(err, abortedKey) {
  if (err.name === 'AbortError') setStatus(t(abortedKey));
  else setStatus(err.message || String(err), { error: true });
}

function setBusy(busy) {
  state.busy = busy;
  $('generateBtn').hidden = busy;
  $('stopBtn').hidden = !busy;
  for (const id of ['imageModel', 'peModel', 'llmModel', 'seedBtn', 'connBtn', 'format']) {
    $(id).disabled = busy;
    syncPicker($(id));
  }
  for (const b of $('presets').children) b.disabled = busy;
  refreshActionButtons();
  renderModelList();
  if (state.project && state.selectedId) renderImprove();
}

function beginTask() {
  saveSettings();
  setBusy(true);
  state.abort = new AbortController();
  return state.abort;
}

function endTask() {
  state.abort = null;
  setBusy(false);
  if (state.client) refreshRunning().catch(() => {});
}

async function withLock(task) {
  if (state.busy) return;
  setBusy(true);
  try {
    await task();
    setStatus(t('ready'));
  } catch (err) {
    reportError(err, 'cancelled');
  } finally {
    setBusy(false);
    if (state.client) refreshRunning().catch(() => {});
  }
}

/* ---------- Connexion ---------- */

function renderConnButton() {
  if (state.client) setIconLabel($('connBtn'), 'unlink', t('disconnect'));
  else setIconLabel($('connBtn'), 'link', t('connect'));
}

function setConnection(on, text) {
  connectionLabel = on ? text : null;
  $('connDot').classList.toggle('on', on);
  $('connText').textContent = text;
  $('deviceBtn').disabled = !state.client;
  if (!state.client) toggleDevicePanel(false);
  renderConnButton();
  refreshActionButtons();
}

async function connect(base, key) {
  const client = new TiinyClient(base, key);
  const info = await client.deviceInfo();
  state.client = client;
  await refreshModels();
  const link = client.base.includes('172.') ? 'USB' : client.base.replace(/^https?:\/\//, '');
  setConnection(true, `${info.device_name} · ${link} · TiinyOS ${info.tiiny_os}`);
}

// La clé reste enregistrée dans ce navigateur pour faciliter la reconnexion, mais la page ne se reconnecte plus seule.
function disconnect() {
  state.client = null;
  state.models = [];
  state.running = [];
  state.settings.autoConnect = false;
  saveSettings();
  renderModelSelects();
  renderModelList();
  for (const id of ['npuBar', 'memBar']) $(id).style.width = '0';
  $('npuText').textContent = '–';
  $('memText').textContent = '–';
  setConnection(false, t('notConnected'));
  setStatus(t('ready'));
}

async function pollDevice() {
  if (!state.client) return;
  const client = state.client;
  try {
    const npu = await client.npuStatus();
    if (client !== state.client) return;
    const device = npu.devices?.[0];
    if (device) {
      const memory = device.mem_total_mb ? (device.mem_used_mb / device.mem_total_mb) * 100 : 0;
      $('npuBar').style.width = `${device.util_percent}%`;
      $('npuText').textContent = `${Math.round(device.util_percent)} %`;
      $('memBar').style.width = `${memory}%`;
      $('memText').textContent = `${(device.mem_used_mb / 1024).toFixed(1)}/${Math.round(device.mem_total_mb / 1024)} Go`;
    }
    if (!state.busy) await refreshRunning();
    if (!connectionLabel) setConnection(true, t('reconnected'));
  } catch (err) {
    if (client === state.client) setConnection(false, err.message);
  }
}

function openSettings() {
  $('baseUrl').value = state.settings.baseUrl || DEFAULT_BASE_URL;
  $('apiKey').value = state.settings.apiKey || '';
  $('settingsError').textContent = '';
  $('settings').showModal();
}

function toggleDevicePanel(open) {
  $('devicePanel').hidden = !open;
  $('deviceBtn').setAttribute('aria-expanded', String(open));
}

/* ---------- Mise en page : panneaux fixes, blocs repliables ---------- */

// Hauteur réelle des barres fixes du haut et du bas : la zone centrale se cale entre les deux.
function measureBars() {
  const gap = 10;
  const root = document.documentElement.style;
  const fixed = getComputedStyle($('chain')).position === 'fixed';
  root.setProperty('--top-h', fixed ? `${Math.ceil(document.querySelector('.topbar').getBoundingClientRect().bottom + gap)}px` : '0px');
  root.setProperty('--bottom-h', fixed ? `${Math.ceil(window.innerHeight - $('chain').getBoundingClientRect().top + gap)}px` : '0px');
}

function renderCollapsibles() {
  const collapsed = state.settings.collapsed || {};
  for (const btn of document.querySelectorAll('.collapse-btn')) {
    const id = btn.dataset.collapse;
    const closed = !!collapsed[id];
    $(id).classList.toggle('collapsed', closed);
    btn.innerHTML = iconSvg(closed ? 'chevron-down' : 'chevron-up');
    btn.setAttribute('aria-expanded', String(!closed));
    btn.title = t(closed ? 'expandBlock' : 'collapseBlock');
    const h2 = $(id).querySelector('.block-head h2');
    if (h2) h2.title = h2.textContent.trim();
    btn.setAttribute('aria-label', btn.title);
  }
  // Blocs repliés : leurs en-têtes se rangent côte à côte en haut de la colonne, alignés sur la barre de page.
  for (const side of document.querySelectorAll('.side')) {
    const inline = side.querySelector('.side-inline');
    const blocks = [...side.querySelectorAll('.block')].sort((x, y) => x.dataset.order - y.dataset.order);
    for (const block of blocks) (block.classList.contains('collapsed') ? inline : side).append(block);
    // Colonne entièrement repliée : la page récupère sa largeur, seule la ligne d'en-têtes reste.
    const all = blocks.every((b) => b.classList.contains('collapsed'));
    document.body.classList.toggle(side.classList.contains('side-left') ? 'left-collapsed' : 'right-collapsed', all);
  }
}

function bindCollapsibles() {
  document.querySelectorAll('.side .block').forEach((block, i) => { block.dataset.order = i; });
  for (const btn of document.querySelectorAll('.collapse-btn')) {
    btn.addEventListener('click', () => {
      const collapsed = (state.settings.collapsed ||= {});
      collapsed[btn.dataset.collapse] = !collapsed[btn.dataset.collapse];
      renderCollapsibles();
      saveSettings();
    });
  }
  new ResizeObserver(() => fitPageBar()).observe(document.querySelector('.page-bar-wrap'));
  const observer = new ResizeObserver(measureBars);
  observer.observe(document.querySelector('.topbar'));
  observer.observe($('chain'));
  window.addEventListener('resize', measureBars);
  measureBars();
}

/* ---------- Langue ---------- */

function setLanguage(lang) {
  const idle = !state.busy && $('status').textContent === t('ready');
  applyI18n(lang);
  $('language').value = currentLang;
  closePicker();
  renderModelSelects();
  renderModelList();
  renderTemplateMenu();
  for (const select of pickers.keys()) syncPicker(select);
  if (!state.client || !connectionLabel) $('connText').textContent = t('notConnected');
  renderConnButton();
  renderCollapsibles();
  if (state.project) renderAll();
  if (idle || !$('status').textContent) setStatus(t('ready'));
  saveSettings();
}

/* ---------- Démarrage ---------- */

function bindEvents() {
  $('connBtn').addEventListener('click', () => (state.client ? disconnect() : openSettings()));
  $('deviceBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDevicePanel($('devicePanel').hidden);
  });
  document.addEventListener('click', (e) => {
    if (!e.composedPath().some((el) => el.id === 'devicePanel' || el.id === 'deviceBtn')) toggleDevicePanel(false);
    const inMenu = e.composedPath().some((el) => el.classList?.contains('menu') || el.classList?.contains('project-box') || el.classList?.contains('ref-add'));
    if (!inMenu) closeMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenus();
      closePicker(true);
    }
  });
  $('settingsCancel').addEventListener('click', () => $('settings').close());
  $('settingsForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const base = $('baseUrl').value.trim();
    const key = $('apiKey').value.trim();
    $('settingsError').textContent = '';
    try {
      await connect(base, key);
      Object.assign(state.settings, { baseUrl: state.client.base, apiKey: key, autoConnect: true });
      saveSettings();
      $('settings').close();
      setStatus(t('ready'));
    } catch (err) {
      $('settingsError').textContent = err.message;
    }
  });
  $('language').addEventListener('change', () => setLanguage($('language').value));

  // Projet
  $('projectTitle').addEventListener('input', () => {
    project().title = $('projectTitle').value;
    touch();
  });
  $('projectBtn').addEventListener('click', () => toggleMenu('projectBtn', 'projectMenu', renderProjectMenu));
  $('exportBtn').addEventListener('click', () => toggleMenu('exportBtn', 'exportMenu', renderExportMenu));
  $('templateBtn').addEventListener('click', () => toggleMenu('templateBtn', 'templateMenu', renderTemplateMenu));
  $('projectFileInput').addEventListener('change', async () => {
    const file = $('projectFileInput').files[0];
    $('projectFileInput').value = '';
    if (!file) return;
    try {
      await touch({ now: true });
      await openProject(await store.importProjectFile(file));
      setStatus(t('projectImported'));
    } catch (err) {
      setStatus(err.message, { error: true });
    }
  });
  $('projectStyle').addEventListener('input', () => {
    project().style = $('projectStyle').value;
    touch();
  });
  $('synopsis').addEventListener('input', () => {
    project().synopsis = $('synopsis').value;
    touch();
  });

  // Page
  $('format').addEventListener('change', () => setFormat($('format').value));
  for (const b of $('modes').children) b.addEventListener('click', () => setMode(b.dataset.mode));
  for (const b of $('sketchTools').children) b.addEventListener('click', () => setSketchTool(b.dataset.tool));
  $('sketchDrawBtn').addEventListener('click', () => setMode('sketch'));
  $('sketchClearBtn').addEventListener('click', clearSketch);
  $('sketchUse').addEventListener('change', () => {
    const panel = selectedPanel()?.panel;
    if (!panel) return;
    panel.sketch ||= { items: [], use: true };
    panel.sketch.use = $('sketchUse').checked;
    touch();
    renderSketchSection();
  });
  $('splitColsBtn').addEventListener('click', () => splitSelected('row'));
  $('splitRowsBtn').addEventListener('click', () => splitSelected('col'));
  $('removePanelBtn').addEventListener('click', removeSelected);
  $('mergePanelBtn').addEventListener('click', mergeSelected);
  $('regroupBtn').addEventListener('click', () => {
    const page = project().pages[state.pageIndex];
    const leafEntry = state.selectedId && P.findLeaf(page, state.selectedId);
    if (leafEntry) regroup(page, leafEntry.node.id);
  });
  $('prevPageBtn').addEventListener('click', () => goToPage(state.pageIndex - 1));
  $('nextPageBtn').addEventListener('click', () => goToPage(state.pageIndex + 1));
  $('addPageBtn').addEventListener('click', addPage);
  $('removePageBtn').addEventListener('click', removePage);
  $('stripHeight').addEventListener('change', () => {
    const page = project().pages[state.pageIndex];
    page.height = P.clamp(+$('stripHeight').value || P.FORMATS.webtoon.height, P.WEBTOON_MIN_HEIGHT, P.WEBTOON_MAX_HEIGHT);
    touch();
    renderPage();
    renderPresets();
  });

  // Case
  $('prevPanelBtn').addEventListener('click', () => stepPanel(-1));
  $('nextPanelBtn').addEventListener('click', () => stepPanel(1));
  $('description').addEventListener('input', () => {
    const sel = selectedPanel();
    if (!sel) return;
    sel.panel.description = $('description').value;
    touch();
    clearTimeout($('description').renderTimer);
    $('description').renderTimer = setTimeout(() => {
      pageView.refresh();
      renderPageList();
    }, 250);
  });
  $('enhanced').addEventListener('input', () => {
    const sel = selectedPanel();
    if (!sel) return;
    sel.panel.enhanced = $('enhanced').value;
    touch();
  });
  $('clearEnhancedBtn').addEventListener('click', () => {
    const sel = selectedPanel();
    if (!sel) return;
    sel.panel.enhanced = null;
    touch();
    renderPanelEditor();
  });
  $('enhanceBtn').addEventListener('click', enhancePanel);
  for (const b of $('presets').children) {
    b.addEventListener('click', () => {
      state.preset = b.dataset.preset;
      saveSettings();
      renderPresets();
    });
  }
  for (const b of document.querySelectorAll('[data-upscale]')) b.addEventListener('click', () => renderPanel('upscale', b.dataset.upscale));
  $('extendBtn').addEventListener('click', () => renderPanel('extend'));
  $('generateBtn').addEventListener('click', () => renderPanel('generate'));
  $('stopBtn').addEventListener('click', () => state.abort?.abort());
  $('seedBtn').addEventListener('click', () => {
    state.randomSeed = !state.randomSeed;
    renderSeed();
    saveSettings();
  });
  for (const id of ['contextImages', 'contextTexts']) {
    $(id).addEventListener('input', () => {
      if (state.selectedId) renderContextStrip();
      saveSettings();
    });
  }

  // Chaîne
  for (const id of ['imageModel', 'peModel', 'llmModel']) {
    $(id).addEventListener('change', () => {
      saveSettings();
      refreshActionButtons();
      renderChain();
    });
  }
  $('llmToggle').addEventListener('click', () => setExpanded($('llmToggle'), $('llmBody'), $('llmBody').hidden));
  $('modelToggle').addEventListener('click', () => setExpanded($('modelToggle'), $('modelBody'), $('modelBody').hidden));

  // Bibliothèque
  $('uploadBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', () => {
    importImages([...$('fileInput').files]);
    $('fileInput').value = '';
  });
  const panelBox = document.querySelector('.context');
  panelBox.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    panelBox.classList.add('over');
  });
  panelBox.addEventListener('dragleave', () => panelBox.classList.remove('over'));
  panelBox.addEventListener('drop', (e) => {
    panelBox.classList.remove('over');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    importImages([...e.dataTransfer.files]);
  });

  window.addEventListener('beforeunload', () => {
    saveSettings();
    if (state.project) store.saveProject(state.project);
  });
}

async function start() {
  loadSettings();
  applySettings();
  decorateIcons();
  $('language').replaceChildren(...Object.entries(LANGUAGES).map(([code, name]) => new Option(name, code)));
  applyI18n(state.settings.language || detectLanguage());
  $('language').value = currentLang;
  bindEvents();
  bindCollapsibles();
  renderCollapsibles();
  enhancePickers();
  setExpanded($('llmToggle'), $('llmBody'), false);
  setExpanded($('modelToggle'), $('modelBody'), false);
  for (const x of $('modes').children) x.setAttribute('aria-pressed', String(x.dataset.mode === state.mode));
  renderModelSelects();
  renderTemplateMenu();
  renderSeed();
  setConnection(false, t('notConnected'));
  setStatus(t('ready'));

  pageView = new PageView($('viewport'), {
    store,
    onSelect: (panelId) => selectPanel(panelId),
    onChange: (kind) => {
      if (kind === 'stripHeight-live') {
        $('stripHeight').value = P.pageSize(project(), project().pages[state.pageIndex]).height;
        return;
      }
      touch();
      renderPageList();
      if (state.selectedId) {
        renderPresets();
        renderImprove();
        renderSketchSection();
      }
    },
    onSwap: swapPanels,
    onAddRow: addRow,
    onRegroup: (page, nodeId) => regroup(page, nodeId),
    onZoom: (zoom) => { $('zoomLabel').textContent = `${Math.round(zoom * 100)} %`; },
  });
  $('zoomOutBtn').addEventListener('click', () => { pageView.focus = null; pageView.setZoom(pageView.zoom / 1.25); });
  $('zoomInBtn').addEventListener('click', () => { pageView.focus = null; pageView.setZoom(pageView.zoom * 1.25); });
  $('zoomLabel').addEventListener('click', () => { pageView.focus = null; pageView.setZoom(1); });
  generator = new ComicGenerator({
    getClient: () => state.client,
    store,
    ensureLoaded,
    modelInfo: modelById,
  });

  await store.requestPersistence();
  const list = await store.listProjects();
  const wanted = list.find((p) => p.id === state.settings.lastProject) || list[0];
  if (wanted) await openProject(await store.loadProject(wanted.id));
  else await createProject('bd');

  const { baseUrl, apiKey, autoConnect } = state.settings;
  if (baseUrl && apiKey && autoConnect !== false) {
    try {
      await connect(baseUrl, apiKey);
    } catch (err) {
      setConnection(false, err.message);
    }
  } else if (!baseUrl || !apiKey) {
    openSettings();
  }
  setInterval(pollDevice, 3000);
  pollDevice();
}

start();
