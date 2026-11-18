# TiinyComics: architecture

A static web page with no backend and no build step, like TiinyPaint: plain `<script>` files loaded in order by `web/index.html`, the browser talks directly to the Tiiny API. The UI shares TiinyPaint's base (glass panels, top bar with device, NPU and memory meters, styled pickers with load and unload buttons). The generation graph of TiinyPaint is replaced by a bar of three model pickers: diffusion model, prompt enhancer (optional), LLM (optional).

## Files

| File | Role | Globals it defines |
|---|---|---|
| `web/api.js` | Tiiny API client, copied from TiinyPaint | `TiinyClient`, `TiinyError`, `readSse` |
| `web/prompts.js` | Official PE-I2I and PE-T2I system prompts (Qwen research license) | `window.TP_PROMPTS` |
| `web/icons.js` | Lucide 0.460.0 icons | `iconSvg(name)`, `flagSvg(lang)` |
| `web/i18n.js` | Translations, `t(key, params)` | `I18N`, `t`, `applyI18n`, `currentLang` |
| `web/project.js` | Pure data model: formats, layout tree, geometry, reading order, render sizes. Tested by `tests/project.test.js` | `TC_PROJECT` |
| `web/store.js` | IndexedDB persistence of projects and images | `ComicStore` |
| `web/editor.js` | TiinyPaint's canvas editor (mask, lasso...), reused for text correction | `Editor`, `makeCanvas` |
| `web/generate.js` | Context building, LLM and PE chain, render requests, presets, upscale, extend | `ComicGenerator` |
| `web/export.js` | Page rendering to canvas, PNG, ZIP and PDF export | `ComicExport` |
| `web/pageview.js` | Interactive page view: panels, dividers, selection, image framing | `PageView` |
| `web/app.js` | Wiring: connection, model pickers, project and panel UI | – |

Any module may call `t()` and `iconSvg()`. Only `app.js` reads or writes the DOM of the main page outside its own container.

## Data model (`web/project.js`)

```
Project {
  id, version: 1, title, format: 'bd' | 'comics' | 'manga' | 'webtoon',
  style,      // global style prompt, prepended to every render
  synopsis,   // story context for the LLM
  margin?, gutter?, border?,  // override the format defaults, in page units (border: black panel outline width)
  library: [{ assetId, name }],  // project reference images (characters, places)
  pages: [Page], createdAt, updatedAt
}
Page   { id, height?, layout: Node }        // height: webtoon only, user-defined
Node   = { id, kind: 'panel', panel: Panel }
       | { id, kind: 'split', dir: 'row' | 'col', children: [Node], ratios: [number] }  // ratios sum to 1
Panel  {
  id, description,            // scene description written by the user
  refs: [assetId],            // reference images of this panel (from the library)
  versions: [Version], current: versionId | null,
  placement: { zoom, x, y },  // framing: zoom 1 = image covers the panel; x, y = centre offset as a fraction of the panel
  enhanced: string | null,    // last prompt rewritten by the LLM/PE, editable
  sketch: null | { items: [...], use, assetId, sig }   // vector items in panel-relative coords (web/sketch.js); assetId = last rasterized PNG, kept like every asset
}
Version {
  id, assetId, width, height, createdAt,
  mode: 'generate' | 'upscale' | 'extend' | 'textfix' | 'import',
  preset: 'draft' | 'mp1' | 'mp2' | 'mp4',
  description, prompt,        // what the user wrote, and the exact prompt sent
  model, seed, steps, guidance, refs: [assetId], contextPanels: [panelId],
  sketchAssetId?, maskAssetId?, parent?: versionId
}
```

- **Reading order** is the order of the children in the tree, always. In manga, `computeLayout` places the first child of a `row` split on the right. `readingOrder(project)` lists every panel across pages; `previousPanels(project, panelId, n)` gives the context of a panel.
- **Geometry**: `computeLayout(project, page)` returns panel rectangles and divider handles in page units. Page units are print pixels: `bd` 2400 × 3200 (24 × 32 cm), `comics` 1988 × 3075 (US), `manga` 1500 × 2133 (B6, right to left), `webtoon` 800 × `page.height`.
- **Render sizes**: `presetSize(preset, panelW, panelH)` gives a Tiiny-valid size (multiples of 32, at most 16896 latent tokens) at the panel ratio, clamped to 1:4..4:1. `draft` = long side 512, `mp1` ≈ 1024², `mp2` ≈ 2 MP, `mp4` = 2048² (Qwen-Image 2.1 supports it). `upscaleAvailable(target, w, h)` is false (greyed out) when the image is already at or above the target.
- **Framing**: `placeImage(imgW, imgH, panelW, panelH, placement)` gives the image rectangle inside the panel. `hasUncovered(...)` tells whether "Extend" has something to fill.

## Persistence (`web/store.js`)

IndexedDB `tiinycomics`: store `projects` (the project JSON) and store `assets` (`{ id, projectId, blob, kind, name, width, height, createdAt }`, `kind` in `ref`, `render`, `sketch`, `mask`, `import`). Nothing is deleted automatically: every render, version and sketch is kept as long as the project exists. A `.tiinycomic` file (JSON with images as data URIs) saves or moves a whole project.

## Generation

For the selected panel, the request carries, in this order and within the 10-image limit of the API:
1. the panel's reference images,
2. the images of the previous panels in reading order (the most recent first dropped last), so that characters and setting stay consistent,
3. the panel's sketch when there is one. With a sketch, it goes first (`<image1>`) with a short "transform this sketch" prompt, plus the library refs; previous panels are not sent as images (tested on the Tiiny: they get copied).

The prompt states the format, the project style, a short summary of the previous panels (their descriptions), then the current panel's description, and names each image as `<imageN>`.

Optional chain before the render: **LLM** (any chat model) writes a scene prompt from the story context (synopsis, previous descriptions, their images when the model reads images), then **PE** (PE-I2I with images, PE-T2I without) polishes it for Qwen-Image. Either can be off. The result is shown and editable before rendering.

Modes: `generate` (preset), `upscale` (current image as `<image1>`, same composition, larger size), `extend` (the framed image on a canvas at the panel ratio, the uncovered part filled with a blurred mirror of the image's edges and repainted, then the original pixels recomposited with a wide feather; a magenta fill does not work here: the model ignores it and enlarges the picture), `textfix` (later phase: a masked bubble repainted with typed text).
