# Changelog

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
