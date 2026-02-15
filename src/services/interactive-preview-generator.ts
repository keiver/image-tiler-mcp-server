import * as fs from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";
import { escapeHtml } from "../utils.js";
import { MAX_PREVIEW_PIXELS } from "../constants.js";
import type { ModelEstimate } from "../types.js";

export interface InteractivePreviewData {
  sourceImagePath: string;
  effectiveWidth: number;
  effectiveHeight: number;
  originalWidth: number;
  originalHeight: number;
  maxDimension: number;
  recommendedModel: string;
  models: ModelEstimate[];
}

export async function generateInteractivePreview(
  data: InteractivePreviewData,
  outputDir: string
): Promise<string> {
  const {
    sourceImagePath,
    effectiveWidth,
    effectiveHeight,
    originalWidth,
    originalHeight,
    models,
  } = data;

  const filename = path.basename(sourceImagePath);

  // Downsize large images for browser-safe preview (Safari caps at ~16M pixels)
  const sharpMeta = await sharp(path.resolve(sourceImagePath)).metadata();
  const sourcePixels = (sharpMeta.width ?? 0) * (sharpMeta.height ?? 0);
  let previewImagePath = sourceImagePath;

  if (sourcePixels > MAX_PREVIEW_PIXELS && sharpMeta.width && sharpMeta.height) {
    const scale = Math.sqrt(MAX_PREVIEW_PIXELS / sourcePixels);
    const previewW = Math.round(sharpMeta.width * scale);
    const previewH = Math.round(sharpMeta.height * scale);
    const previewFilename = `${path.basename(sourceImagePath, path.extname(sourceImagePath))}-preview-bg.png`;
    const previewBgPath = path.join(outputDir, previewFilename);
    await sharp(path.resolve(sourceImagePath))
      .resize(previewW, previewH)
      .png({ compressionLevel: 6 })
      .toFile(previewBgPath);
    previewImagePath = previewBgPath;
  }

  const relativePreviewImagePath = path.relative(
    outputDir,
    path.resolve(previewImagePath)
  );
  const wasResized = effectiveWidth !== originalWidth || effectiveHeight !== originalHeight;

  const modelsJson = JSON.stringify(
    models.map((m) => ({
      model: m.model,
      label: m.label,
      tileSize: m.tileSize,
      cols: m.cols,
      rows: m.rows,
      tiles: m.tiles,
      tokens: m.tokens,
    }))
  );

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tiling Preview - ${escapeHtml(filename)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #141422; color: #e0e0e0; padding: 24px 28px; }
  .header { margin-bottom: 14px; }
  .header h1 { font-size: 1.5em; margin-bottom: 8px; color: #f0f0f0; font-weight: 600; letter-spacing: -0.01em; }
  .header h1 .dim { font-weight: 400; color: #888; font-size: 0.7em; margin-left: 6px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
  .tab { padding: 9px 20px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(0, 0, 0, 0.5); color: #999; cursor: pointer; font-size: 0.85em; font-weight: 500; font-family: inherit; transition: all 0.2s ease; position: relative; backdrop-filter: blur(4px); text-align: center; line-height: 1.4; }
  .tab:hover { background: rgba(0, 0, 0, 0.7); color: #ccc; border-color: rgba(255, 255, 255, 0.15); }
  .tab.active { background: rgba(0, 0, 0, 0.8); color: #f5d547; border-color: rgba(245, 213, 71, 0.35); box-shadow: 0 0 12px rgba(245, 213, 71, 0.1); }
  .tab .tab-stats { display: block; font-size: 0.75em; font-weight: 400; color: #777; }
  .tab.active .tab-stats { color: #c9b84a; }
  .tab:hover .tab-stats { color: #aaa; }
  .source-container { position: relative; display: inline-block; max-width: 100%; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4); }
  .source-container img { display: block; max-width: 100%; height: auto; }
  .source-container svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
  .source-container svg line { stroke: rgba(255, 255, 255, 0.35); stroke-width: 1.5; stroke-dasharray: 8 4; }
  .source-container svg text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-anchor: middle; dominant-baseline: central; }
  .source-container svg text.tile-index { fill: #fff; }
  .source-container svg text.tile-pos { fill: rgba(255, 255, 255, 0.7); }
  .footer { margin-top: 24px; font-size: 0.75em; color: #555; text-align: center; }
  .subtitle { font-size: 0.85em; color: #888; margin-bottom: 12px; }
</style>
</head>
<body>
<div class="header">
  <h1>${escapeHtml(filename)} <span class="dim">${originalWidth} \u00d7 ${originalHeight}${wasResized ? ` \u2192 ${effectiveWidth} \u00d7 ${effectiveHeight}` : ""}</span></h1>
  <p class="subtitle">Pick the tiling preset that matches your LLM's vision pipeline.</p>
</div>

<div class="tabs" id="model-tabs"></div>

<div class="source-container">
  <img src="${escapeHtml(relativePreviewImagePath)}" alt="Source image" />
  <svg id="grid-overlay" viewBox="0 0 ${effectiveWidth} ${effectiveHeight}" preserveAspectRatio="xMinYMin meet"></svg>
</div>

<div class="footer">Generated by image-tiler-mcp-server - this file is safe to delete</div>

<script>
(function() {
  var MODELS = ${modelsJson};
  var W = ${effectiveWidth};
  var H = ${effectiveHeight};

  var tabsEl = document.getElementById('model-tabs');
  var svg = document.getElementById('grid-overlay');
  var ns = 'http://www.w3.org/2000/svg';
  var activeModel = MODELS[0].model;

  function renderTabs() {
    tabsEl.innerHTML = '';
    for (var i = 0; i < MODELS.length; i++) {
      var m = MODELS[i];
      var btn = document.createElement('button');
      btn.className = 'tab' + (m.model === activeModel ? ' active' : '');
      var label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = (m.label || m.model) + ' \u00b7 ' + m.tileSize + 'px';
      var stats = document.createElement('span');
      stats.className = 'tab-stats';
      stats.textContent = m.tiles + ' tiles \u00b7 ~' + m.tokens.toLocaleString() + ' tokens';
      btn.appendChild(label);
      btn.appendChild(stats);
      btn.setAttribute('data-model', m.model);
      btn.addEventListener('click', function() {
        activeModel = this.getAttribute('data-model');
        renderTabs();
        renderGrid();
      });
      tabsEl.appendChild(btn);
    }
  }

  function getModel(name) {
    for (var i = 0; i < MODELS.length; i++) {
      if (MODELS[i].model === name) return MODELS[i];
    }
    return MODELS[0];
  }

  function renderGrid() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var m = getModel(activeModel);
    var ts = m.tileSize;
    var cols = m.cols;
    var rows = m.rows;

    // Vertical grid lines
    for (var c = 1; c < cols; c++) {
      var x = c * ts;
      var line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', x); line.setAttribute('y1', 0);
      line.setAttribute('x2', x); line.setAttribute('y2', H);
      svg.appendChild(line);
    }
    // Horizontal grid lines
    for (var r = 1; r < rows; r++) {
      var y = r * ts;
      var line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', 0); line.setAttribute('y1', y);
      line.setAttribute('x2', W); line.setAttribute('y2', y);
      svg.appendChild(line);
    }

    // Tile labels
    var fontSize = Math.max(12, Math.min(ts * 0.08, 48));
    var subFontSize = fontSize * 0.65;
    var idx = 0;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var tx = c * ts;
        var ty = r * ts;
        var tw = (c === cols - 1) ? W - tx : ts;
        var th = (r === rows - 1) ? H - ty : ts;
        var cx = tx + tw / 2;
        var cy = ty + th / 2;

        var circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('cx', cx);
        circle.setAttribute('cy', cy);
        circle.setAttribute('r', fontSize * 1.4);
        circle.setAttribute('fill', 'rgba(0, 0, 0, 0.55)');
        svg.appendChild(circle);

        var idxText = document.createElementNS(ns, 'text');
        idxText.setAttribute('class', 'tile-index');
        idxText.setAttribute('x', cx);
        idxText.setAttribute('y', cy - subFontSize * 0.45);
        idxText.setAttribute('font-size', fontSize);
        idxText.textContent = String(idx);
        svg.appendChild(idxText);

        var posText = document.createElementNS(ns, 'text');
        posText.setAttribute('class', 'tile-pos');
        posText.setAttribute('x', cx);
        posText.setAttribute('y', cy + fontSize * 0.55);
        posText.setAttribute('font-size', subFontSize);
        posText.textContent = '(' + r + ',' + c + ')';
        svg.appendChild(posText);

        idx++;
      }
    }
  }

  renderTabs();
  renderGrid();
})();
</script>
</body>
</html>`;

  const baseName = path.basename(sourceImagePath, path.extname(sourceImagePath));
  const previewPath = path.join(outputDir, `${baseName}-preview.html`);
  await fs.writeFile(previewPath, html, "utf-8");
  return previewPath;
}
