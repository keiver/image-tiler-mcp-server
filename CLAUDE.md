# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP server that splits large images into optimally-sized tiles for LLM vision systems (Claude, OpenAI, Gemini, Gemini 3). Prevents automatic downscaling by keeping each tile within each model's sweet spot. Built with the MCP SDK, Sharp (libvips), and Zod.

Published as `image-tiler-mcp-server` on npm. This is a **library/tool** (not an app) — inputs come from MCP clients, not untrusted end users.

**Supported image formats:** PNG, JPEG, WebP, TIFF, GIF.

**Supported vision models:**

| Model | Default tile | Tokens/tile | Max tile |
|-------|-------------|-------------|----------|
| Claude (default) | 1092px | 1590 | 1568px |
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

**Four MCP tools registered:**

1. **`tiler_tile_image`** (`src/tools/tile-image.ts`) — Accepts an image from file path, URL, data URL, or base64. Splits it into a grid of PNG tiles saved to `tiles/{name}/` next to the source image (or a custom output directory). `maxDimension` param (default: 10000px) auto-downscales images so the longest side fits within the given px value before tiling. Returns JSON metadata (model, grid dimensions, token estimate, file paths, preview path, optional resize info) and generates an interactive HTML preview.

2. **`tiler_get_tiles`** (`src/tools/get-tiles.ts`) — Reads tiles from disk and returns them as base64 image content blocks in batches of 5. Supports pagination via `start`/`end` indices.

3. **`tiler_recommend_settings`** (`src/tools/recommend-settings.ts`) — Dry-run estimator: reads image dimensions and returns cost estimates without tiling. Includes heuristic-based recommendations (intent/budget), per-model comparison across all 4 models, and grid dimensions. Read-only — no tiles are created.

4. **`tiler_prepare_image`** (`src/tools/prepare-image.ts`) — One-shot convenience: chains tile-image + get-tiles into a single tool call. Returns tiling metadata plus the first batch of tile images inline. Supports pagination via `page` param.

**Key layers:**

- `src/tools/` — Tool registration and MCP response formatting. Each file exports a `register*Tool(server)` function.
- `src/services/image-processor.ts` — All Sharp image operations: metadata reading, grid calculation, tile extraction, base64 encoding, directory listing.
- `src/services/image-source-resolver.ts` — Resolves image sources (file path, URL, data URL, base64) to a local file path with cleanup. Includes Content-Type validation for URL downloads, buffer size checks, base64 input validation, and exported helper functions (`isImageContentType`, `getImageMagicBytes`, `isImageSubtype`). Used by tile-image, recommend-settings, and prepare-image tools.
- `src/services/preview-generator.ts` — Generates a static HTML preview (`preview.html`) visualizing the tile grid layout with overlay annotations.
- `src/services/interactive-preview-generator.ts` — Generates an interactive HTML preview with per-model tabs showing grid overlays, token estimates, and model comparison.
- `src/utils.ts` — Shared utilities: `escapeHtml()` for safe HTML output in preview generators.
- `src/schemas/index.ts` — Zod input schemas for all tools. Shared `imageSourceFields` used by tile-image, recommend-settings, and prepare-image.
- `src/types.ts` — TypeScript interfaces (`ImageMetadata`, `TileGridInfo`, `TileInfo`, `TileImageResult`, `ResolvedImageSource`, `RecommendationResult`).
- `src/constants.ts` — Model vision configs (`MODEL_CONFIGS` keyed by `"claude" | "openai" | "gemini" | "gemini3"`), per-model tile sizes and token rates, backward-compatible aliases, batch limit (5), PNG compression level (6), download limits, intent/budget enums.

**Sharp configuration** (in `image-processor.ts`): Cache limited to 10 items / 200MB, concurrency set to 2. Tiles are extracted sequentially row-by-row, left-to-right.

**Tile naming convention:** `tile_ROW_COL.png` with zero-padded 3-digit indices (e.g., `tile_000_003.png`).

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
- `schemas.test.ts` — Zod schema boundary validation (min/max, defaults, required fields) for all 4 schemas
- `image-processor.test.ts` — Core logic with mocked Sharp + fs (calculateGrid, tileImage, readTileAsBase64, listTilesInDirectory)
- `image-source-resolver.test.ts` — Source resolution: file passthrough, data URL parsing, base64 decoding, cleanup idempotency, URL resolution (success, HTTP errors, timeout, size limits, Content-Type validation), helper function tests (`isImageContentType`, `getImageMagicBytes`, `isImageSubtype`)
- `tile-image-tool.test.ts` — Tool handler: format validation, response formatting, error wrapping, source resolution integration
- `get-tiles-tool.test.ts` — Tool handler: pagination, batch limits, content block structure
- `recommend-settings-tool.test.ts` — Recommend tool: heuristic rules, all-model comparison, intent/budget effects
- `prepare-image-tool.test.ts` — Prepare tool: combined tile+get response, pagination, cleanup
- `preview-generator.test.ts` — Preview HTML generation: template rendering, file writing, error handling
- `utils.test.ts` — `escapeHtml` unit tests covering HTML entities, mixed content, empty strings
- `interactive-preview-generator.test.ts` — Interactive preview HTML generation: model tabs, grid rendering, token estimates
- `integration.test.ts` — Real Sharp + real filesystem using `assets/landscape.png` (7680×4032) and `assets/portrait.png` (3600×22810)

**Mocking strategy:** Unit tests mock Sharp (via `vi.hoisted` + `vi.mock`) and `node:fs/promises`. Tool handler tests mock the entire service layer. Integration tests use no mocks.

**Test images in `assets/`:** Do not delete — used by integration tests.

## Adding a New Tool

1. Create `src/tools/my-tool.ts` exporting `registerMyTool(server: McpServer)`.
2. Add input schema to `src/schemas/index.ts` using Zod.
3. Add any needed types to `src/types.ts`.
4. Register in `src/index.ts` by calling `registerMyTool(server)`.
