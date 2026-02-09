import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TileImageResult } from "../types.js";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function generatePreview(
  result: TileImageResult,
  sourceImagePath: string,
  model: string
): Promise<string> {
  const outputDir = result.outputDir;
  const relativeSourcePath = path.relative(
    outputDir,
    path.resolve(sourceImagePath)
  );

  const { width, height } = result.sourceImage;
  const { cols, rows, totalTiles, tileSize, estimatedTokens } = result.grid;

  const tilesJson = JSON.stringify(
    result.tiles.map((t) => ({
      index: t.index,
      row: t.row,
      col: t.col,
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      filename: t.filename,
    }))
  );

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tile Preview — ${escapeHtml(path.basename(sourceImagePath))}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 20px; }
  .header { margin-bottom: 20px; }
  .header h1 { font-size: 1.4em; margin-bottom: 8px; color: #fff; }
  .meta { display: flex; flex-wrap: wrap; gap: 16px; font-size: 0.85em; color: #aaa; }
  .meta span { background: #16213e; padding: 4px 10px; border-radius: 4px; }
  .toggle { display: flex; gap: 8px; margin: 16px 0; }
  .toggle button { padding: 8px 18px; border: 1px solid #334; background: #16213e; color: #ccc; border-radius: 6px; cursor: pointer; font-size: 0.9em; transition: all 0.15s; }
  .toggle button.active { background: #0f3460; color: #fff; border-color: #1a8; }
  .toggle button:hover { background: #0f3460; }
  .view { display: none; }
  .view.active { display: block; }

  /* Source View */
  .source-container { position: relative; display: inline-block; max-width: 100%; }
  .source-container img { display: block; max-width: 100%; height: auto; }
  .source-container svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
  .source-container svg line { stroke: rgba(255, 60, 60, 0.7); stroke-width: 1.5; }
  .source-container svg text { fill: rgba(255, 255, 255, 0.85); font-size: 14px; font-family: monospace; text-anchor: middle; dominant-baseline: central; paint-order: stroke; stroke: rgba(0,0,0,0.6); stroke-width: 3px; }

  /* Tile View */
  .tile-grid { display: grid; gap: 4px; }
  .tile-cell { position: relative; background: #16213e; border-radius: 4px; overflow: hidden; }
  .tile-cell img { display: block; width: 100%; height: auto; }
  .tile-badge { position: absolute; top: 4px; left: 4px; background: rgba(0,0,0,0.7); color: #fff; font-size: 11px; font-family: monospace; padding: 2px 6px; border-radius: 3px; pointer-events: none; }
  .tile-cell .tooltip { display: none; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.9); color: #fff; padding: 6px 10px; border-radius: 4px; font-size: 12px; font-family: monospace; white-space: nowrap; z-index: 10; pointer-events: none; }
  .tile-cell:hover .tooltip { display: block; }
</style>
</head>
<body>
<div class="header">
  <h1>Tile Preview</h1>
  <div class="meta">
    <span>Source: ${escapeHtml(path.basename(sourceImagePath))}</span>
    <span>${width} × ${height}</span>
    <span>Grid: ${cols} × ${rows} = ${totalTiles} tiles</span>
    <span>Tile size: ${tileSize}px</span>
    <span>Model: ${escapeHtml(model)}</span>
    <span>~${estimatedTokens.toLocaleString()} tokens</span>
  </div>
</div>

<div class="toggle">
  <button id="btn-source" class="active" onclick="showView('source')">Source View</button>
  <button id="btn-tiles" onclick="showView('tiles')">Tile View</button>
</div>

<div id="view-source" class="view active">
  <div class="source-container">
    <img id="source-img" src="${escapeHtml(relativeSourcePath)}" alt="Source image" />
    <svg id="grid-overlay" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet"></svg>
  </div>
</div>

<div id="view-tiles" class="view">
  <div class="tile-grid" id="tile-grid" style="grid-template-columns: repeat(${cols}, 1fr);"></div>
</div>

<script>
(function() {
  var META = {
    width: ${width},
    height: ${height},
    cols: ${cols},
    rows: ${rows},
    tileSize: ${tileSize},
    totalTiles: ${totalTiles},
    model: ${JSON.stringify(model)}
  };
  var TILES = ${tilesJson};

  // Draw grid overlay on source view
  var svg = document.getElementById('grid-overlay');
  // Vertical lines
  for (var c = 1; c < META.cols; c++) {
    var x = c * META.tileSize;
    var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x); line.setAttribute('y1', 0);
    line.setAttribute('x2', x); line.setAttribute('y2', META.height);
    svg.appendChild(line);
  }
  // Horizontal lines
  for (var r = 1; r < META.rows; r++) {
    var y = r * META.tileSize;
    var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', 0); line.setAttribute('y1', y);
    line.setAttribute('x2', META.width); line.setAttribute('y2', y);
    svg.appendChild(line);
  }
  // Tile index labels at cell centers
  for (var i = 0; i < TILES.length; i++) {
    var t = TILES[i];
    var cx = t.x + t.width / 2;
    var cy = t.y + t.height / 2;
    var text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', cx);
    text.setAttribute('y', cy);
    text.textContent = String(t.index);
    svg.appendChild(text);
  }

  // Build tile grid
  var grid = document.getElementById('tile-grid');
  for (var i = 0; i < TILES.length; i++) {
    var t = TILES[i];
    var cell = document.createElement('div');
    cell.className = 'tile-cell';

    var img = document.createElement('img');
    img.src = t.filename;
    img.alt = 'Tile ' + t.index;
    cell.appendChild(img);

    var badge = document.createElement('div');
    badge.className = 'tile-badge';
    badge.textContent = t.index + ' [' + t.row + ',' + t.col + ']';
    cell.appendChild(badge);

    var tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.textContent = 'Tile ' + t.index + ' — row ' + t.row + ', col ' + t.col + ' — pos(' + t.x + ',' + t.y + ') — ' + t.width + '×' + t.height + 'px';
    cell.appendChild(tooltip);

    grid.appendChild(cell);
  }
})();

function showView(name) {
  document.getElementById('view-source').className = 'view' + (name === 'source' ? ' active' : '');
  document.getElementById('view-tiles').className = 'view' + (name === 'tiles' ? ' active' : '');
  document.getElementById('btn-source').className = name === 'source' ? 'active' : '';
  document.getElementById('btn-tiles').className = name === 'tiles' ? 'active' : '';
}
</script>
</body>
</html>`;

  const previewPath = path.join(outputDir, "preview.html");
  await fs.writeFile(previewPath, html, "utf-8");
  return previewPath;
}
