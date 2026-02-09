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

No linter is configured.

## Architecture

**Transport:** stdio only (single-session, local). Entry point is `src/index.ts` which creates an `McpServer` and connects via `StdioServerTransport`.

**Two MCP tools registered:**

1. **`tiler_tile_image`** (`src/tools/tile-image.ts`) — Takes an image path and optional `model` param (`"claude"` | `"openai"` | `"gemini"` | `"gemini3"`), splits it into a grid of PNG tiles saved to `tiles/{name}/` next to the source image (or a custom output directory). Returns JSON metadata (grid dimensions, model-specific token estimate, file paths).

2. **`tiler_get_tiles`** (`src/tools/get-tiles.ts`) — Reads tiles from disk and returns them as base64 image content blocks in batches of 5. Supports pagination via `start`/`end` indices.

**Key layers:**

- `src/tools/` — Tool registration and MCP response formatting. Each file exports a `register*Tool(server)` function.
- `src/services/image-processor.ts` — All Sharp image operations: metadata reading, grid calculation, tile extraction, base64 encoding, directory listing.
- `src/schemas/index.ts` — Zod input schemas for both tools. Shared by tool registration and type inference.
- `src/types.ts` — TypeScript interfaces (`ImageMetadata`, `TileGridInfo`, `TileInfo`, `TileImageResult`).
- `src/constants.ts` — Model vision configs (`MODEL_CONFIGS` keyed by `"claude" | "openai" | "gemini" | "gemini3"`), per-model tile sizes and token rates, backward-compatible aliases (`DEFAULT_TILE_SIZE`, `MAX_TILE_SIZE`, etc. point to Claude config), batch limit (5), PNG compression level (6).

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
- `schemas.test.ts` — Zod schema boundary validation (min/max, defaults, required fields)
- `image-processor.test.ts` — Core logic with mocked Sharp + fs (calculateGrid, tileImage, readTileAsBase64, listTilesInDirectory)
- `tile-image-tool.test.ts` — Tool handler: format validation, response formatting, error wrapping
- `get-tiles-tool.test.ts` — Tool handler: pagination, batch limits, content block structure
- `integration.test.ts` — Real Sharp + real filesystem using `assets/landscape.png` (7680×4032) and `assets/portrait.png` (3600×21994)

**Mocking strategy:** Unit tests mock Sharp (via `vi.hoisted` + `vi.mock`) and `node:fs/promises`. Tool handler tests mock the entire service layer. Integration tests use no mocks.

**Test images in `assets/`:** Do not delete — used by integration tests.

## Adding a New Tool

1. Create `src/tools/my-tool.ts` exporting `registerMyTool(server: McpServer)`.
2. Add input schema to `src/schemas/index.ts` using Zod.
3. Add any needed types to `src/types.ts`.
4. Register in `src/index.ts` by calling `registerMyTool(server)`.
