# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP server that splits large images into optimally-sized tiles for LLM vision systems (Claude, OpenAI, Gemini, Gemini 3). Prevents automatic downscaling by keeping each tile within each model's sweet spot. Also captures full-page screenshots from URLs via Chrome DevTools Protocol, with scroll-stitching for pages exceeding Chrome's 16,384px capture limit. Built with the MCP SDK, Sharp (libvips), `ws` (WebSocket for CDP), and Zod.

Published as `image-tiler-mcp-server` on npm. Requires **Node >= 20**. This is a **library/tool** (not an app): inputs come from MCP clients, not untrusted end users.

Model configs available via `tiler://models` resource. See `docs/architecture.md` for full module and test inventory.

## Commands

```bash
npm run build        # Compile TypeScript -> dist/
npm run dev          # Watch mode (tsc --watch)
npm start            # Run the compiled server (node dist/index.js)
npm run inspect      # Launch MCP Inspector for interactive testing
npm test             # Run test suite (vitest)
npm run test:watch   # Run tests in watch mode
npx vitest run src/__tests__/schemas.test.ts  # Single test file
```

No linter is configured.

## Architecture

**Transport:** stdio only (single-session, local). Entry point is `src/index.ts`.

**One unified MCP tool: `tiler`** (`src/tools/tiler.ts`). Mode is auto-detected from params:

- **Tile-image mode** (has `filePath`/`sourceUrl`/`dataUrl`/`imageBase64`): Splits image into grid tiles saved to `tiles/{name}/`. Returns JSON metadata + up to 5 tile images inline with pagination.
- **Capture-and-tile mode** (has `url` or `screenshotPath`): Captures URL screenshot via Chrome CDP, tiles it, returns first batch inline. Stop after Phase 1 for screenshot-only use.
- **Get-tiles mode** (has `tilesDir`): Reads tiles from disk, returns base64 images in batches of 5 with pagination via `start`/`end`.

**Two-phase workflow:** Phase 1 returns a model comparison table with STOP instruction. Phase 2 (with user's chosen preset + outputDir) performs tiling. Elicitation-capable clients get an interactive preset picker. When preset is omitted on Phase 2, auto-selects cheapest. External param is `preset`; deprecated `model` param still accepted. All internal code uses `model`.

**Key layers (one sentence each):**

- `security.ts`: Path containment (`TILER_ALLOWED_DIRS`) and URL capture toggle.
- `services/image-processor.ts`: All Sharp operations, grid calculation, tile extraction.
- `services/image-source-resolver.ts`: Resolves file/URL/dataURL/base64 to local path with SSRF filtering.
- `services/url-capture.ts`: Chrome CDP capture with scroll-stitching for tall pages.
- `services/tile-analyzer.ts`: Per-tile content classification (blank/low/high/mixed detail).
- `services/tiling-pipeline.ts`: Shared pipeline for Phase 1 (preview gate) and Phase 2 (tiling).
- `services/elicitation.ts`: Interactive preset picker for elicitation-capable clients.
- `services/interactive-preview-generator.ts`: HTML preview with per-model tabs.
- `schemas/index.ts`: Unified Zod input schema covering all three modes.
- `constants.ts`: Model vision configs, tile sizes, token rates, limits.
- `utils.ts`: Shared helpers (escapeHtml, formatModelComparisonTable, etc.).

## TypeScript Configuration

- ESM (`"type": "module"` in package.json), Target: ES2022, Module: Node16
- Strict mode enabled. All imports use `.js` extensions (required for Node16 module resolution).

## Testing

**Framework:** Vitest. Tests in `src/__tests__/`, excluded from build output.

**Mocking strategy:** Unit tests mock Sharp (via `vi.hoisted` + `vi.mock`) and `node:fs/promises`. Tool handler tests mock the entire service layer. Integration tests use no mocks.

**Test images in `assets/`:** Do not delete, used by integration tests.

## Test Quality Rules

**Forbidden patterns:**

- Duplicate assertions: same field/value in two `it` blocks unless different code path.
- Trivial passthrough tests: standalone `it` that only asserts a field echoes input.
- Over-specified mock call assertions with `undefined` fields the test never provided.
- Dead tests: every `it` must have at least one `expect(...)` that can fail.
- Same code path, different name: identical branch + setup + assertion = delete one.
- Implementation-detail assertions: prefer asserting outputs over spying on internals.

**Shared setup:** If 3+ lines of mock setup repeat across `it` blocks in a `describe`, lift to `beforeEach`. Repeated mock objects must be shared factories.

## Adding a New Tool

1. Create `src/tools/my-tool.ts` exporting `registerMyTool(server: McpServer)`.
2. Add input schema to `src/schemas/index.ts` using Zod.
3. Add any needed types to `src/types.ts`.
4. Register in `src/index.ts` by calling `registerMyTool(server)`.
