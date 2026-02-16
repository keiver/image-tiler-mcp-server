# Changelog

## [Unreleased]

### Fixed
- Temp file cleanup warnings now surfaced as structured warnings in MCP responses instead of logging to stderr
- Low-severity `qs` dependency vulnerability resolved via audit fix

### Added
- `test:coverage` script for vitest coverage reporting
- `types` field in package.json for explicit TypeScript declaration entry point

### Changed
- Consolidated 3 MCP tools (`tiler_tile_image`, `tiler_get_tiles`, `tiler_capture_and_tile`) into 1 unified `tiler` tool
- Mode auto-detected from parameters: `tilesDir` for pagination, `url`/`screenshotPath` for capture, image source fields for tiling
- `model` parameter description now explicitly discourages use on Phase 1 (first call)
- Phase 1 response now starts with "STOP" instruction before the comparison table
- Unified `TilerInputSchema` replaces 3 separate schemas

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
