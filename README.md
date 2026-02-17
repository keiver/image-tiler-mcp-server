# image-tiler-mcp-server

Split large images into optimally-sized tiles so LLM vision models see every detail - no downscaling, no lost text.

<p align="center">
  <img src="assets/preview.gif" alt="Preview of image tiling grid with advised vision models size and token estimates" width="100%" />
</p>

## Installation

### Claude Code

```bash
claude mcp add image-tiler -- npx -y image-tiler-mcp-server
```

> `image-tiler` is a local alias - you can name it anything you like. `image-tiler-mcp-server` is the npm package that gets downloaded and run.

See [Claude Code MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp) for more info.

### Codex CLI

```bash
codex mcp add image-tiler -- npx -y image-tiler-mcp-server
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.image-tiler]
command = "npx"
args = ["-y", "image-tiler-mcp-server"]
```

### VS Code (Cline / Continue)

Add to your VS Code MCP settings:

```json
{
  "image-tiler": {
    "command": "npx",
    "args": ["-y", "image-tiler-mcp-server"]
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "image-tiler": {
      "command": "npx",
      "args": ["-y", "image-tiler-mcp-server"]
    }
  }
}
```

### Claude Desktop

Add to your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "image-tiler": {
      "command": "npx",
      "args": ["-y", "image-tiler-mcp-server"]
    }
  }
}
```

Restart Claude Desktop after editing.

### Global Install (faster startup)

```bash
npm install -g image-tiler-mcp-server
```

Then use the simpler config in any client:

```json
{
  "command": "image-tiler-mcp-server"
}
```

### From Source

```bash
git clone https://github.com/keiver/image-tiler-mcp-server.git
cd image-tiler-mcp-server
npm install
npm run build
```

Then point your MCP config to the built file:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/image-tiler-mcp-server/dist/index.js"]
}
```

## Tiling for LLM Vision

LLM vision systems have a **maximum input resolution**. When you send an image larger than that limit, the model downscales it before processing. A 3600×22810 full-page screenshot gets shrunk to ~247×1568 by Claude - text becomes unreadable, UI details disappear, and the model can't analyze what it can't see.

**Tiling solves this.** This MCP server:

1. Reads the image dimensions and the target model's vision config
2. Calculates an optimal grid that keeps every tile within the model's sweet spot
3. Extracts tiles as individual images (WebP default, PNG optional) and saves them to disk
4. Returns metadata (grid layout, file paths, estimated token cost)
5. Serves tiles back as base64 in paginated batches for the LLM to analyze

Each tile is processed at **full resolution** - no downscaling - preserving text, UI elements, and fine detail across the entire image.

**Auto-downscaling:** Images over 10,000px on their longest side are automatically downscaled before tiling (configurable via `maxDimension`). This prevents extreme tile counts on very long screenshots - e.g., a 3600×22810 page drops from 84 tiles / ~134K tokens to 20 tiles / ~32K tokens with no visible quality loss. Set `maxDimension=0` to disable.

### Supported Models

| Model | Default tile | Tokens/tile | Max tile | ID |
|-------|-------------|-------------|----------|-----|
| Claude | 1092px | 1590 | 1568px | `claude` |
| OpenAI (GPT-4o/o-series) | 768px | 765 | 2048px | `openai` |
| Gemini | 768px | 258 | 768px | `gemini` |
| Gemini 3 | 1536px | 1120 | 3072px | `gemini3` |

> **OpenAI note:** The `openai` config targets the GPT-4o / o-series vision pipeline (512px tile patches). GPT-4.1 uses a fundamentally different pipeline (32x32 pixel patches) and is not currently supported - it would require a separate model config with a different calculation approach.

> **Gemini 3 note:** Gemini 3 uses a fixed token budget per image (1120 tokens regardless of dimensions). Tiling increases total token cost but preserves fine detail. For cases where detail isn't critical, consider sending a single image instead.

## Tools

### `tiler`

One unified tool that handles all image tiling operations. The mode is auto-detected from the parameters you provide:

- **`tilesDir`** present → **Tile retrieval mode** (read-only pagination)
- **`url`** or **`screenshotPath`** present → **URL capture mode** (screenshot + tile)
- **`filePath`**, **`sourceUrl`**, **`dataUrl`**, or **`imageBase64`** present → **Tile-image mode**

> **Mode priority:** When multiple mode params are present, the tool resolves by priority:
> `tilesDir` > `url`/`screenshotPath` > `filePath`/`sourceUrl`/`dataUrl`/`imageBase64`.
> Avoid passing params from different modes in the same call.

**Two-phase workflow (recommended):**

1. **Phase 1** — Provide only the image source. Returns a model comparison table with a STOP instruction.
   Present the options to the user and wait for their choice.
2. **Phase 2** — Call again with the user's chosen `model` + `outputDir` from Phase 1, plus:
   - **Tile-image mode:** re-include your original image source (`filePath`, `sourceUrl`, etc.)
   - **Capture mode:** include `screenshotPath` from Phase 1 (not the original `url`)

> **One-shot bypass:** If both `model` and `outputDir` are provided on the first call, Phase 1 is skipped — the server generates the preview and tiles in one step.

> **Elicitation clients:** Clients that support elicitation get an interactive model picker instead of the comparison table, streamlining the workflow into a single step.

#### Parameters — Image Source (tile-image mode)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `filePath` | string | no* | - | Absolute or relative path to the image file |
| `sourceUrl` | string | no* | - | HTTPS URL to download the image from (max 50MB, 30s timeout) |
| `dataUrl` | string | no* | - | Data URL with base64-encoded image |
| `imageBase64` | string | no* | - | Raw base64-encoded image data |

*At least one image source is required for tile-image mode.

#### Parameters — URL Capture (capture mode)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | no | - | URL of the web page to capture. Requires Chrome/Chromium installed (or `CHROME_PATH` env var). |
| `screenshotPath` | string | no | - | Path to a previously captured screenshot. Skips URL capture when provided. |
| `viewportWidth` | number | no | Auto-detect (fallback 1280) | Browser viewport width in pixels (320-3840) |
| `waitUntil` | string | no | `"load"` | When to consider the page loaded: `"load"`, `"networkidle"`, or `"domcontentloaded"` |
| `delay` | number | no | `0` | Additional delay in ms after page load (max 30000) |

Supports scroll-stitching for pages taller than 16,384px.

#### Parameters — Tile Retrieval (pagination mode)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `tilesDir` | string | no | - | Path to tiles directory (returned by a previous tiling call as `outputDir`) |
| `start` | number | no | `0` | Start tile index (0-based, inclusive) |
| `end` | number | no | start + 4 | End tile index (0-based, inclusive). Max 5 tiles per batch. |

#### Parameters — Tiling Config (shared across modes)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `model` | string | no | Auto (cheapest) | Target vision model: `"claude"`, `"openai"`, `"gemini"`, `"gemini3"`. Auto-selects the most token-efficient preset when omitted. Provide on Phase 2, not Phase 1. |
| `tileSize` | number | no | Model default | Tile size in pixels. Clamped to model's supported range with a warning if out of bounds. |
| `maxDimension` | number | no | `10000` | Max dimension in px (0 to disable, or 256-65536). Values 1-255 are silently clamped to 256. Pre-downscales the image so its longest side fits within this value before tiling. |
| `outputDir` | string | no | See below | Directory to save tiles. Defaults: for file sources, `tiles/{name}_vN/` next to source (auto-incrementing: `_v1`, `_v2`, ..., `_vN`); for captures, `{base}/tiles/capture_{timestamp}_{hex}/` where `{base}` is `~/Desktop`, `~/Downloads`, or `~` (first available). |
| `page` | number | no | `0` | Tile page to return (0 = first 5, 1 = next 5, etc.) |
| `format` | string | no | `"webp"` | Output format: `"webp"` (smaller, default) or `"png"` (lossless) |
| `includeMetadata` | boolean | no | `true` | Analyze each tile and return content hints (text-heavy, image-rich, low-detail, mixed) and brightness stats |

#### Response Structure

**Phase 1 JSON** (second content block):

| Field | Type | Description |
|---|---|---|
| `status` | string | Always `"pending_confirmation"` |
| `outputDir` | string | Directory to pass back on Phase 2 |
| `previewPath` | string \| null | Interactive HTML preview path |
| `allModels` | array | `{ model, label, tileSize, cols, rows, tiles, tokens }` per preset |
| `screenshotPath` | string | *(capture mode only)* Path to screenshot for Phase 2 |
| `warnings` | array | *(when present)* Warning messages (e.g., preview generation failures) |

**Phase 2 JSON** (second content block):

| Field | Type | Description |
|---|---|---|
| `model` | string | Selected model ID |
| `sourceImage` | object | `{ width, height, format, fileSize, channels }` of the (possibly resized) source |
| `grid` | object | `{ cols, rows, totalTiles, tileSize, estimatedTokens }` |
| `outputDir` | string | Tiles directory |
| `page` | object | `{ current, tilesReturned, totalTiles, hasMore }` |
| `capture` | object | *(capture mode only)* `{ url, pageWidth, pageHeight, segmentsStitched, viewportWidth, waitUntil }` |
| `autoSelected` | boolean | `true` when model was auto-selected (no elicitation) |
| `tileHints` | array | *(when `includeMetadata: true`)* Per-tile content analysis |
| `resize` | object | *(when downscaled)* `{ originalWidth, originalHeight, resizedWidth, resizedHeight, scaleFactor }` |
| `previewPath` | string | Interactive HTML preview path (when available) |
| `warnings` | array | *(when present)* Warning messages (e.g., tile size clamping, source conflicts) |
| `allModels` | array | *(when `autoSelected: true`)* All model estimates for manual override |

## Usage

### Quick Start

```
> Tile the screenshot at ./screenshots/full-page.png and analyze the layout

Your MCP client will:
1. Call tiler(filePath="./screenshots/full-page.png") → see model comparison table (Phase 1)
2. Call tiler(filePath="./screenshots/full-page.png", model="claude", outputDir="...") → get first batch of tiles (Phase 2)
3. Call tiler(tilesDir="...", start=5, end=9) for subsequent batches
```

> **Auto-model selection:** When `model` is omitted on Phase 2, the server automatically picks the most token-efficient preset for the image dimensions. The response includes a comparison table so you can override with a specific model if needed.

### With Other Models

The `model` parameter is optional — omit it for automatic selection, or specify explicitly to override:

```
> Tile this image for GPT-4o analysis

Your MCP client will:
1. Call tiler(filePath="./image.png", model="openai", outputDir="...")
2. Tiles sized at 768px for OpenAI's vision pipeline, returned inline
```

### URL Capture + Tiling

Capture full-page screenshots directly from URLs:

```
> Capture and tile the page at https://example.com

Your MCP client will:
1. Call tiler(url="https://example.com") → screenshot + model comparison (Phase 1)
2. Call tiler(screenshotPath="...", model="claude", outputDir="...") → tiles inline (Phase 2)
```

Screenshot only (no tiling) — stop after Phase 1:

```
> Take a screenshot of https://example.com

Your MCP client will:
1. Call tiler(url="https://example.com") → screenshot saved, comparison returned
2. (No second call needed — screenshot path is in the response)
```

### Auto-Downscaling

Images over 10,000px are automatically downscaled before tiling. You can customize the limit:

```
> Tile this 7680x4032 screenshot but downscale to 2048px first to save tokens

Your MCP client will:
1. Call tiler(filePath="./image.png", maxDimension=2048)
2. Image is downscaled to 2048x1076 before tiling
3. Fewer tiles = lower token cost (e.g., 4 tiles instead of 32)
```

To disable auto-downscaling entirely:

```
> Tile this image at full resolution, no downscaling

Your MCP client will:
1. Call tiler(filePath="./image.png", maxDimension=0)
2. Image is tiled at its original dimensions
```

### Using URLs / Base64

The `tiler` tool supports multiple input sources:

```
> Tile this image from a URL

Your MCP client will:
1. Call tiler(sourceUrl="https://example.com/screenshot.png")

> Tile this base64 image

Your MCP client will:
1. Call tiler(imageBase64="iVBORw0KGgo...")
```

### Typical Workflow

1. Capture a full-page screenshot with your browser extension
2. Ask your AI assistant: _"Tile `/path/to/screencapture-localhost-3000.png` and review all sections"_
3. The client pages through tiles automatically, analyzing each batch

## Behaviors

**Source conflict:** When multiple image source params are provided (e.g., both `filePath` and `sourceUrl`), the server uses the highest-precedence source and emits a warning: `filePath` > `sourceUrl` > `dataUrl` > `imageBase64`.

**Preview gate re-entry:** If an `outputDir` already contains a `*-preview.html` file from a previous Phase 1, the server skips Phase 1 and proceeds directly to Phase 2 (tiling).

**Elicitation cancellation:** When a user cancels the elicitation model picker, the server returns `"Tiling cancelled by user."` and does not tile.

**Versioned output directories:** Repeated tiling of the same source image creates `_v1`, `_v2`, ..., `_vN` directories automatically to avoid overwriting previous results.

**Tile naming convention:** Tiles are named `tile_ROW_COL.{format}` with zero-padded 3-digit indices (e.g., `tile_000_003.webp`), ordered row-by-row, left-to-right.

## Token Cost Reference

Costs vary by model. Formula: `tokens = totalTiles x tokensPerTile`

### Claude (1092px tiles, 1590 tokens/tile)

| Image Dimensions | Tiles | Estimated Tokens |
|---|---|---|
| 1440x3000 | 6 | ~9,540 |
| 3600x5000 | 20 | ~31,800 |
| 3600x22810 | 84 | ~133,560 |

### OpenAI - GPT-4o/o-series (768px tiles, 765 tokens/tile)

| Image Dimensions | Tiles | Estimated Tokens |
|---|---|---|
| 1440x3000 | 8 | ~6,120 |
| 3600x5000 | 35 | ~26,775 |
| 3600x22810 | 150 | ~114,750 |

### Gemini (768px tiles, 258 tokens/tile)

| Image Dimensions | Tiles | Estimated Tokens |
|---|---|---|
| 1440x3000 | 8 | ~2,064 |
| 3600x5000 | 35 | ~9,030 |
| 3600x22810 | 150 | ~38,700 |

### Gemini 3 (1536px tiles, 1120 tokens/tile)

| Image Dimensions | Tiles | Estimated Tokens |
|---|---|---|
| 1440x3000 | 2 | ~2,240 |
| 3600x5000 | 12 | ~13,440 |
| 3600x22810 | 45 | ~50,400 |

> **Note:** Gemini 3 uses a fixed 1120 tokens per image regardless of dimensions. More tiles = more total tokens but better detail preservation.

## Supported Formats

PNG, JPEG, WebP, TIFF, GIF

## Troubleshooting

**"Command not found"** - Make sure Node.js 20+ is installed: `node --version`

**"File not found"** - Use absolute paths. Relative paths resolve from the MCP server's working directory.

**"MCP tools not available"** - Restart your MCP client after config changes. In Claude Code, run `/mcp` to check server status.

**"Chrome not found"** - Install Google Chrome or set the `CHROME_PATH` environment variable to the Chrome executable (must be an absolute path).

**Running as root / in Docker** - Set `CHROME_NO_SANDBOX=1` to launch Chrome without sandbox (also enabled automatically when running as root).

**`viewportWidth` auto-detection** - Auto-detection of screen width works on macOS only. On other platforms, falls back to 1280px.

## Security

Local stdio server — runs with the same filesystem permissions as the MCP client that spawns it. No path sandboxing, no SSRF protection on URL downloads.

**If deploying remotely:** Add path validation, SSRF protection (block private/internal IP ranges), and authentication. This server is not designed for multi-tenant or network-exposed use.

## Requirements

- Node.js 20+
- Compatible MCP client (Claude Code, Codex CLI, VS Code, Cursor, Claude Desktop)

## License

MIT

## Links

- [GitHub Repository](https://github.com/keiver/image-tiler-mcp-server)
- [NPM Package](https://www.npmjs.com/package/image-tiler-mcp-server)
- [Report Issues](https://github.com/keiver/image-tiler-mcp-server/issues)
