# Changelog

## [2.1.0]

### Added
- **`preset` parameter** — replaces `model` as the external-facing param for selecting a vision model; deprecated `model` still accepted with warning
- **Entropy-based tile classification** — content analysis uses Shannon entropy (0-8 range) instead of stdDev for low-detail/mixed/high-detail classification; stdDev < 5 blank detection unchanged
- **Entropy + sharpness in TileMetadata** — `entropy` and `sharpness` fields exposed in metadata, get-tiles annotations, and Phase 2 structured JSON
- **Blank-tile skipping** — get-tiles mode skips blank tiles by default (`skipBlankTiles` param to opt out)
- **Summary-first Phase 2** — Phase 2 returns metadata-only; clients fetch tiles via tilesDir + get-tiles
- npm keywords for discoverability

### Changed
- Elicitation schema property renamed from `model` to `preset`
- Phase 1/Phase 2 instruction text references `preset` instead of `model`
- README rewritten with badges, collapsible install sections, and improved structure
- Test assets upgraded to higher-resolution images (landscape 8192×4320, portrait 3600×20220)
- Get-tiles annotations now show `(mixed, entropy=5.8, sharpness=12.3)` format

### Fixed
- Chrome zero-dimension fallback catches negative values (not just zero)

## [2.0.1]

### Fixed
- Remove `required` constraint from elicitation schema to prevent SDK validation crash
- AI acknowledgment added to README

## [2.0.0]

### Breaking
- **Consolidated 3 MCP tools into 1 unified `tiler` tool** — `tiler_tile_image`, `tiler_get_tiles`, and `tiler_capture_and_tile` are removed. Mode is auto-detected from parameters: `tilesDir` for pagination, `url`/`screenshotPath` for capture, image source fields for tiling
- Unified `TilerInputSchema` replaces 3 separate schemas

### Added
- **URL capture via Chrome DevTools Protocol** — full-page screenshots from `http:`/`https:` URLs with headless Chrome. `CHROME_PATH` env var overrides auto-detection. Pages taller than 16,384px are scroll-stitched automatically
- **WebP default output** — tiles now output as WebP (quality 80) instead of PNG. `format` param (`"webp"` | `"png"`) to override
- **Tile metadata analysis** — `includeMetadata: true` runs per-tile content classification (blank, low-detail, mixed, high-detail) via Sharp stats
- **MCP elicitation support** — elicitation-capable clients get an interactive model picker; others fall through to the comparison table flow
- **Two-phase confirmation workflow** — Phase 1 returns model comparison table with STOP instruction; Phase 2 performs tiling with user's chosen model
- **Versioned output directories** — file-source tiling creates versioned output dirs to avoid overwriting previous runs
- **`prebuild` script** — `rm -rf dist` before each build to prevent stale artifacts
- **`pretest` script** — runs build before tests so CLI tests find `dist/index.js`
- `test:coverage` script for vitest coverage reporting
- `types` field in package.json for explicit TypeScript declaration entry point
- `screenshotPath` param to reuse an existing screenshot without re-capturing
- `waitUntil` param for capture (`load`, `networkidle`, `domcontentloaded`)
- `viewportWidth` param for capture (auto-detects screen width, falls back to 1280)
- `delay` param for capture (additional wait after page load)
- Resize info now shown in model comparison table when downscaling occurs
- `withTimeout` utility for Sharp operations to prevent hangs

### Changed
- `model` parameter description now explicitly discourages use on Phase 1 (first call)
- Phase 1 response now starts with "STOP" instruction before the comparison table
- Auto-selects cheapest model preset when `model` omitted on Phase 2
- Shared tiling pipeline (`tiling-pipeline.ts`) replaces duplicated logic across tools

### Fixed
- `withTimeout` timer now properly cleared on successful completion (prevented timer leak)
- Magic-bytes extension detection preferred over Content-Type header for URL downloads
- Temp file cleanup warnings now surfaced as structured warnings in MCP responses instead of logging to stderr
- Low-severity `qs` dependency vulnerability resolved via audit fix
- `CHROME_PATH` env var now validates file existence and executable permission
- Chrome stderr parsing optimized to process per-line instead of re-scanning full buffer

### Security
- Input validation hardening across all image source types
- Chrome CDP communication uses bounded buffers (`MAX_CHROME_STDERR_BYTES`, `MAX_CHROME_JSON_BYTES`)
- URL protocol allowlisting (`https:` for image downloads, `http:`/`https:` for capture)
- Hostname sanitization for output directory naming

### Removed
- `tiler_tile_image` tool (replaced by `tiler` tile-image mode)
- `tiler_get_tiles` tool (replaced by `tiler` get-tiles mode)
- `tiler_capture_and_tile` tool (replaced by `tiler` capture-and-tile mode)
- `tiler_recommend_settings` tool (replaced by Phase 1 comparison table)
- `tiler_prepare_image` tool (replaced by `tiler` with `page` param)
- Redundant `.npmignore` (superseded by `files` whitelist in package.json)

## [1.5.0] - 2026-02-13

### Added
- `tiler_recommend_settings` tool — dry-run estimator with cost estimates for all 4 models, heuristic recommendations (intent/budget hints), and interactive HTML preview with model-switching tabs
- `tiler_prepare_image` tool — one-shot convenience combining tile + get-tiles in a single call with pagination
- Multi-source image input — `sourceUrl`, `dataUrl`, `imageBase64` as alternatives to `filePath` for all image-accepting tools
- Heuristic engine for `tiler_recommend_settings`: `intent` (text_heavy, ui_screenshot, diagram, photo, general) and `budget` (low, default, max_detail) parameters
- Interactive HTML preview generation with per-model tabs showing grid overlays
- Remainder absorption in grid calculation — thin edge strips (<15% of tileSize) absorbed into the last tile to reduce tile count
- `escapeHtml()` utility for safe HTML output in preview generators
- `MIN_REMAINDER_RATIO`, `IMAGE_INTENTS`, `BUDGET_LEVELS`, `MAX_DATA_URL_LENGTH` constants

### Security
- Decoded buffer size validation after base64/data URL decode (defense-in-depth against oversized payloads)
- Content-Type validation on URL downloads — rejects non-image responses (text/html, application/json, etc.)
- Base64 input validation — reject invalid characters, handle whitespace-only strings
- Data URL length limit enforced in schema (`MAX_DATA_URL_LENGTH`)
### Fixed
- URL downloads of non-image content (e.g. HTML error pages) now fail with a clear error instead of a cryptic Sharp decode error

## [1.4.0] - 2026-02-12

### Changed
- Version bump release (no functional changes from v1.3.0)

## [1.3.0] - 2026-02-11

### Added
- `maxDimension` parameter for `tiler_tile_image` — pre-downscales images so the longest side fits within the given pixel value before tiling, reducing tile count and token cost
- Auto-downscaling enabled by default at 10,000px — images under 10K are unaffected; a 3600×22810 screenshot drops from 84 tiles / ~134K tokens to 20 tiles / ~32K tokens
- `maxDimension=0` disables auto-downscaling for full-resolution tiling
- `resize` field in tool output metadata (present only when downscaling occurred) with original/resized dimensions and scale factor
- `DEFAULT_MAX_DIMENSION` constant (10000)
- `ResizeInfo` type export

### Changed
- Temp file for resize operations now uses `crypto.randomUUID()` for guaranteed uniqueness

## [1.2.0] - 2026-02-10

### Changed
- Removed `cleanup` parameter — both tools are now purely idempotent
- `get-tiles` tool annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`

## [1.1.4] - 2026-02-10

### Fixed
- README fixes

## [1.1.3] - 2026-02-10

### Fixed
- Added sample assets after tiling for CI

## [1.1.2] - 2026-02-09

### Fixed
- Removed claude config files from published package

### Changed
- Removed cleanup flag that broke idempotency

## [1.1.0] - 2026-02-09

### Added
- Interactive HTML preview generation (`preview.html`) for tile grid visualization
- Multi-model support: Claude, OpenAI (GPT-4o/o-series), Gemini, Gemini 3
- Dynamic `GLOBAL_MAX_TILE_SIZE` derived from `MODEL_CONFIGS`
- Server version synced from `package.json`

## [1.0.0] - 2026-02-09

### Added
- Initial release
- `tiler_tile_image` tool — splits images into optimally-sized tiles for LLM vision
- `tiler_get_tiles` tool — serves tiles as base64 in paginated batches
- Support for PNG, JPEG, WebP, TIFF, GIF formats
- Claude-optimized tiling (1092px default, 1590 tokens/tile)
