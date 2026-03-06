# Architecture Details

Extended reference for `image-tiler-mcp-server`. See the root `CLAUDE.md` for the concise project guide.

## Vision Model Comparison

| Model | Default tile | Tokens/tile | Max tile |
|-------|-------------|-------------|----------|
| Claude | 1092px | 1590 | 1568px |
| OpenAI (GPT-4o/o-series) | 768px | 765 | 2048px |
| Gemini | 768px | 258 | 768px |
| Gemini 3 | 1536px | 1120 | 3072px |

**Memory:** Expect ~350-400MB peak for large PNGs due to Sharp decompression. Token cost: `totalTiles * tokensPerTile` (model-specific).

**OpenAI pipeline scope:** The `openai` model config targets the GPT-4o / o-series vision pipeline (512px tile patches). GPT-4.1 uses a fundamentally different pipeline (32x32 pixel patches) and would require a separate model config entry if support is desired.

**Gemini 3 trade-off:** Gemini 3 uses a fixed token budget per image (1120 tokens regardless of dimensions), unlike the area/tile-based formulas of other models. Tiling a large image into N pieces costs N x 1120 tokens, which *increases* total cost compared to sending a single image. The trade-off is more tiles = more tokens but better detail preservation.

## Key Layers (Full Export Inventory)

- `src/tools/tiler.ts`: Exports `registerTilerTool(server)`.
- `src/security.ts`: `assertSafePath()` (enforces `TILER_ALLOWED_DIRS` path containment via `fs.realpath()` on reads, nearest-existing-ancestor walk on writes) and `isUrlCaptureDisabled()` (checks `TILER_DISABLE_URL_CAPTURE=1`). Called by tiler.ts and tiling-pipeline.ts.
- `src/prompts/index.ts`: Registers two MCP prompts: `tile-and-analyze` (guides structured tiling of local images) and `capture-and-analyze` (guides web capture + tiling). Exports `registerPrompts(server)`.
- `src/resources/index.ts`: Registers two MCP resources: `tiler://models` (JSON dump of MODEL_CONFIGS with tile sizes and token rates) and `tiler://guide` (plain-text quick-reference). Exports `registerResources(server)`.
- `src/services/image-processor.ts`: All Sharp image operations: metadata reading, grid calculation, tile extraction (WebP/PNG), base64 encoding, directory listing.
- `src/services/image-source-resolver.ts`: Resolves image sources (file path, URL, data URL, base64) to a local file path with cleanup. SSRF filtering via `request-filtering-agent` on `https:`. `http:` allows private IPs by default; set `TILER_DENY_HTTP_PRIVATE=1` to opt-in to blocking. Includes Content-Type validation for URL downloads, buffer size checks, base64 input validation, and exported helper functions (`guessExtensionFromContentType`, `guessExtensionFromMagicBytes`, `mimeSubtypeToExtension`).
- `src/services/url-capture.ts`: Chrome DevTools Protocol capture: Chrome detection (`findChromePath`), headless Chrome spawning, CDP WebSocket communication, wait conditions (load/networkidle/domcontentloaded), scroll-stitching for pages >16,384px, lazy image triggering (`triggerLazyLoading`), cleanup.
- `src/services/tile-analyzer.ts`: Per-tile content analysis using Sharp `.stats()`. Classifies tiles: blank (`stdDev < 5`), low-detail (`entropy < 4.0`), high-detail (`entropy > 6.5`), mixed (everything else). Used when `includeMetadata: true`.
- `src/services/interactive-preview-generator.ts`: Generates the interactive HTML preview (`{basename}-preview.html`) with per-model tabs showing grid overlays, token estimates, and model comparison.
- `src/services/elicitation.ts`: Elicitation fast path: elicitation-capable clients get a `oneOf` preset picker via `server.elicitInput()` with per-model token estimates; non-elicitation clients fall through to the preview gate flow.
- `src/services/tiling-pipeline.ts`: Shared tiling pipeline. Exports: `resolveOutputDir()`, `resolveOutputDirForCapture()`, `validateFormat()`, `clampTileSize()`, `findCheapestModel()`, `computeElicitationData()`, `checkPreviewGate()`, `analyzeAndPreview()` (Phase 1), `executeTiling()` (Phase 2), `buildPhase1Response()`, `buildPhase2Response()` (accepts `Phase2ResponseOptions` with `autoSelected` flag).
- `src/utils.ts`: Shared utilities: `escapeHtml()`, `getDefaultOutputBase()`, `sanitizeHostname()`, `getVersionedFilePath()`, `getVersionedOutputDir()`, `stripVersionSuffix()`, `formatModelComparisonTable()`, `simulateDownscale()`, `buildTileHints()`.
- `src/schemas/index.ts`: Zod input schema (`TilerInputSchema`): unified superset covering all three modes. External param is `preset`; deprecated `model` alias still accepted.
- `src/types.ts`: TypeScript interfaces (`ImageMetadata`, `TileGridInfo`, `TileInfo`, `TileImageResult`, `ResolvedImageSource`, `CaptureUrlOptions`, `CaptureResult`, `TileMetadata`).
- `src/constants.ts`: Model vision configs (`MODEL_CONFIGS` keyed by `"claude" | "openai" | "gemini" | "gemini3"`), per-model tile sizes and token rates, backward-compatible aliases, batch limit (5), PNG compression level (6), WebP quality (80), download limits, Chrome capture constants, wait-until options, allowed protocols, security env var names (`TILER_ALLOWED_DIRS`, `TILER_DISABLE_URL_CAPTURE`, `TILER_DENY_HTTP_PRIVATE`).

## Sharp Configuration

In `image-processor.ts`: Cache limited to 10 items / 200MB, concurrency set to 2. Tiles are extracted sequentially row-by-row, left-to-right.

## Tile Naming Convention

`tile_ROW_COL.{format}` with zero-padded 3-digit indices (e.g., `tile_000_003.webp`).

## Test File Inventory

- `constants.test.ts`: Value snapshot tests for all exported constants
- `schemas.test.ts`: Zod schema boundary validation (min/max, defaults, required fields) for the unified TilerInputSchema
- `image-processor.test.ts`: Core logic with mocked Sharp + fs (calculateGrid, tileImage, readTileAsBase64, listTilesInDirectory)
- `image-source-resolver.test.ts`: Source resolution: file passthrough, data URL parsing, base64 decoding, cleanup idempotency, URL resolution (success, HTTP errors, timeout, size limits, Content-Type validation), helper function tests
- `tiler-tool.test.ts`: Unified tool handler: all three modes (tile-image, get-tiles, capture-and-tile), format validation, response formatting, error wrapping, source resolution, pagination, Phase 1 stop instruction
- `tiling-pipeline.test.ts`: Shared pipeline: resolveOutputDir, validateFormat, clampTileSize, findCheapestModel, computeElicitationData, analyzeAndPreview, checkPreviewGate, executeTiling, buildPhase1Response, buildPhase2Response
- `utils.test.ts`: `escapeHtml` unit tests covering HTML entities, mixed content, empty strings
- `interactive-preview-generator.test.ts`: Interactive preview HTML generation: template rendering, file writing, error handling, model tabs, grid rendering, token estimates
- `tile-analyzer.test.ts`: Tile content analysis: stdDev thresholds, isBlank detection, boundary values, batch analysis
- `url-capture.test.ts`: Chrome detection (CHROME_PATH env, not found), CDP flow, URL validation, cleanup on error
- `elicitation.test.ts`: Elicitation confirmation: accept/decline/cancel, capability detection, error propagation, message content, schema structure
- `security.test.ts`: `assertSafePath()` and `isUrlCaptureDisabled()`: allowed dirs enforcement, path traversal rejection, write-path ancestor walk, env var toggling
- `prompts.test.ts`: MCP prompt registration: correct prompt names, argument schemas, message content
- `resources.test.ts`: MCP resource registration: `tiler://models` JSON structure, `tiler://guide` text content, PRESETS section values
- `cli.test.ts`: CLI flag tests (--version, -v, --help, -h) using `execFile` against the compiled entry point
- `integration.test.ts`: Real Sharp + real filesystem using `assets/landscape.png` (8192x4320) and `assets/portrait.png` (3600x20220)
- `helpers/mock-server.ts`: Shared mock MCP server factory (`createMockServer`) for tool handler tests
