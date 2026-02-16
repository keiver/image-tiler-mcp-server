# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP server that splits large images into optimally-sized tiles for LLM vision systems (Claude, OpenAI, Gemini, Gemini 3). Prevents automatic downscaling by keeping each tile within each model's sweet spot. Also captures full-page screenshots from URLs via Chrome DevTools Protocol, with scroll-stitching for pages exceeding Chrome's 16,384px capture limit. Built with the MCP SDK, Sharp (libvips), `ws` (WebSocket for CDP), and Zod.

Published as `image-tiler-mcp-server` on npm. Requires **Node >= 20**. This is a **library/tool** (not an app) — inputs come from MCP clients, not untrusted end users.

**Supported image formats:** PNG, JPEG, WebP, TIFF, GIF.

**Default tile output format:** WebP (quality 80). The `tiler` tool accepts a `format` param (`"webp"` | `"png"`) to override.

**URL capture:** Requires Chrome/Chromium installed. Set `CHROME_PATH` env var to override auto-detection. Supports `http:` and `https:` URLs. Pages taller than 16,384px are automatically scroll-stitched.

**Supported vision models:**

| Model | Default tile | Tokens/tile | Max tile |
|-------|-------------|-------------|----------|
| Claude | 1092px | 1590 | 1568px |
| OpenAI (GPT-4o/o-series) | 768px | 765 | 2048px |
| Gemini | 768px | 258 | 768px |
| Gemini 3 | 1536px | 1120 | 3072px |

**Memory:** Expect ~350-400MB peak for large PNGs due to Sharp decompression. Token cost: `totalTiles × tokensPerTile` (model-specific).

**OpenAI pipeline scope:** The `openai` model config targets the GPT-4o / o-series vision pipeline (512px tile patches). GPT-4.1 uses a fundamentally different pipeline (32x32 pixel patches) and would require a separate model config entry if support is desired.

**Gemini 3 trade-off:** Gemini 3 uses a fixed token budget per image (1120 tokens regardless of dimensions), unlike the area/tile-based formulas of other models. Tiling a large image into N pieces costs N × 1120 tokens, which *increases* total cost compared to sending a single image. The trade-off is more tiles = more tokens but better detail preservation. For cases where fine detail isn't critical, consider sending a single image to Gemini 3 instead of tiling.

## Commands

```bash
npm run build        # Compile TypeScript → dist/
npm run dev          # Watch mode (tsc --watch)
npm start            # Run the compiled server (node dist/index.js)
npm run inspect      # Launch MCP Inspector for interactive testing
npm test             # Run test suite (vitest)
npm run test:watch   # Run tests in watch mode
```

Run a single test file:
```bash
npx vitest run src/__tests__/schemas.test.ts
```

No linter is configured.

## Architecture

**Transport:** stdio only (single-session, local). Entry point is `src/index.ts` which creates an `McpServer` and connects via `StdioServerTransport`.

**One unified MCP tool registered:**

**`tiler`** (`src/tools/tiler.ts`) — Single tool that handles all image tiling operations. Mode is auto-detected based on which params are provided:

- **Tile-image mode** (has `filePath`/`sourceUrl`/`dataUrl`/`imageBase64`) — Accepts an image from file path, URL, data URL, or base64. Splits it into a grid of tiles (WebP default) saved to `tiles/{name}/` next to the source image (or a custom output directory). Returns tiles inline with pagination via `page` param. `maxDimension` param (default: 10000px) auto-downscales images before tiling. Optional `includeMetadata` triggers per-tile content analysis. Returns JSON metadata plus up to 5 tile images inline. Generates an interactive HTML preview.
- **Capture-and-tile mode** (has `url` or `screenshotPath`) — Captures a URL screenshot via Chrome CDP, tiles it, and returns the first batch of tile images inline. Includes capture metadata in structured output. `screenshotPath` param reuses an existing screenshot. Stop after Phase 1 for screenshot-only use cases.
- **Get-tiles mode** (has `tilesDir`) — Reads tiles from disk and returns them as base64 image content blocks in batches of 5. Supports pagination via `start`/`end` indices. Handles both `.png` and `.webp` tiles with dynamic MIME types.

**Mandatory two-phase workflow:** Phase 1 returns a model comparison table with STOP instruction; Phase 2 (with user's chosen model + outputDir) performs tiling. With elicitation-capable clients, shows an interactive model picker. When model is omitted on Phase 2, auto-selects cheapest preset.

**Key layers:**

- `src/tools/tiler.ts` — Single unified tool registration with mode detection and MCP response formatting. Exports `registerTilerTool(server)`.
- `src/services/image-processor.ts` — All Sharp image operations: metadata reading, grid calculation, tile extraction (WebP/PNG), base64 encoding, directory listing.
- `src/services/image-source-resolver.ts` — Resolves image sources (file path, URL, data URL, base64) to a local file path with cleanup. Includes Content-Type validation for URL downloads, buffer size checks, base64 input validation, and exported helper functions (`isImageContentType`, `getImageMagicBytes`, `isImageSubtype`). Used by tile-image mode.
- `src/services/url-capture.ts` — Chrome DevTools Protocol capture: Chrome detection (`findChromePath`), headless Chrome spawning, CDP WebSocket communication, wait conditions (load/networkidle/domcontentloaded), scroll-stitching for pages >16,384px, cleanup. Used by capture-and-tile mode.
- `src/services/tile-analyzer.ts` — Per-tile content analysis using Sharp `.stats()`. Classifies tiles by stdDev: low-detail/blank (<5), text-heavy (5-25), mixed (25-60), image-rich (>60). Used when `includeMetadata: true`.
- `src/services/preview-generator.ts` — Generates a static HTML preview (`preview.html`) visualizing the tile grid layout with overlay annotations.
- `src/services/interactive-preview-generator.ts` — Generates an interactive HTML preview with per-model tabs showing grid overlays, token estimates, and model comparison.
- `src/services/elicitation.ts` — Elicitation fast path: elicitation-capable clients get a `oneOf` model picker via `server.elicitInput()` with per-model token estimates; non-elicitation clients fall through to the preview gate flow. Used by the tiler tool.
- `src/services/tiling-pipeline.ts` — Shared tiling pipeline used by the tiler tool. Exports: `resolveOutputDir()`, `resolveOutputDirForCapture()`, `validateFormat()`, `clampTileSize()`, `findCheapestModel()` (picks model with lowest token estimate), `computeElicitationData()` (lightweight metadata + all-model estimates without preview generation), `checkPreviewGate()`, `analyzeAndPreview()` (Phase 1), `executeTiling()` (Phase 2), `buildPhase1Response()` (starts with STOP instruction), `buildPhase2Response()` (accepts `Phase2ResponseOptions` with `autoSelected` flag — when true, appends comparison table + override instructions to the response), `appendTilesPage()`.
- `src/utils.ts` — Shared utilities: `escapeHtml()`, `getDefaultOutputBase()`, `sanitizeHostname()`, `getVersionedFilePath()`, `getVersionedOutputDir()`, `stripVersionSuffix()`, `formatModelComparisonTable()`, `simulateDownscale()`, `buildTileHints()`.
- `src/schemas/index.ts` — Zod input schema (`TilerInputSchema`) — unified superset covering all three modes (image source fields, capture fields, tile retrieval fields, tiling config).
- `src/types.ts` — TypeScript interfaces (`ImageMetadata`, `TileGridInfo`, `TileInfo`, `TileImageResult`, `ResolvedImageSource`, `CaptureUrlOptions`, `CaptureResult`, `TileMetadata`).
- `src/constants.ts` — Model vision configs (`MODEL_CONFIGS` keyed by `"claude" | "openai" | "gemini" | "gemini3"`), per-model tile sizes and token rates, backward-compatible aliases, batch limit (5), PNG compression level (6), WebP quality (80), download limits, Chrome capture constants (max height, viewport, timeouts), wait-until options, allowed protocols.

**Sharp configuration** (in `image-processor.ts`): Cache limited to 10 items / 200MB, concurrency set to 2. Tiles are extracted sequentially row-by-row, left-to-right.

**Tile naming convention:** `tile_ROW_COL.{format}` with zero-padded 3-digit indices (e.g., `tile_000_003.webp`).

## TypeScript Configuration

- ESM (`"type": "module"` in package.json)
- Target: ES2022, Module: Node16
- Strict mode enabled
- All imports use `.js` extensions (required for Node16 module resolution)
- Output includes declaration files and source maps

## Testing

**Framework:** Vitest (zero-config ESM + TypeScript support). Tests live in `src/__tests__/` and are excluded from `tsconfig.json` build output.

**Test structure:**

- `constants.test.ts` — Value snapshot tests for all exported constants
- `schemas.test.ts` — Zod schema boundary validation (min/max, defaults, required fields) for the unified TilerInputSchema
- `image-processor.test.ts` — Core logic with mocked Sharp + fs (calculateGrid, tileImage, readTileAsBase64, listTilesInDirectory)
- `image-source-resolver.test.ts` — Source resolution: file passthrough, data URL parsing, base64 decoding, cleanup idempotency, URL resolution (success, HTTP errors, timeout, size limits, Content-Type validation), helper function tests (`isImageContentType`, `getImageMagicBytes`, `isImageSubtype`)
- `tiler-tool.test.ts` — Unified tool handler: all three modes (tile-image, get-tiles, capture-and-tile), format validation, response formatting, error wrapping, source resolution, pagination, Phase 1 stop instruction
- `tiling-pipeline.test.ts` — Shared pipeline: resolveOutputDir, validateFormat, clampTileSize, findCheapestModel, computeElicitationData, analyzeAndPreview, checkPreviewGate, executeTiling, buildPhase1Response, buildPhase2Response (including autoSelected flag), appendTilesPage
- `preview-generator.test.ts` — Preview HTML generation: template rendering, file writing, error handling
- `utils.test.ts` — `escapeHtml` unit tests covering HTML entities, mixed content, empty strings
- `interactive-preview-generator.test.ts` — Interactive preview HTML generation: model tabs, grid rendering, token estimates
- `tile-analyzer.test.ts` — Tile content analysis: stdDev thresholds, isBlank detection, boundary values, batch analysis
- `url-capture.test.ts` — Chrome detection (CHROME_PATH env, not found), CDP flow, URL validation, cleanup on error
- `elicitation.test.ts` — Elicitation confirmation: accept/decline/cancel, capability detection, error propagation, message content, schema structure
- `integration.test.ts` — Real Sharp + real filesystem using `assets/landscape.png` (7680×4032) and `assets/portrait.png` (3600×22810)

**Mocking strategy:** Unit tests mock Sharp (via `vi.hoisted` + `vi.mock`) and `node:fs/promises`. Tool handler tests mock the entire service layer. Integration tests use no mocks.

**Test images in `assets/`:** Do not delete — used by integration tests.

## Adding a New Tool

1. Create `src/tools/my-tool.ts` exporting `registerMyTool(server: McpServer)`.
2. Add input schema to `src/schemas/index.ts` using Zod.
3. Add any needed types to `src/types.ts`.
4. Register in `src/index.ts` by calling `registerMyTool(server)`.
