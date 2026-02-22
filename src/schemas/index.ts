import { z } from "zod";
import {
  MAX_IMAGE_DIMENSION,
  MAX_TILES_PER_BATCH,
  VISION_MODELS,
  MODEL_CONFIGS,
  DEFAULT_MAX_DIMENSION,
  MAX_BASE64_LENGTH,
  MAX_DATA_URL_LENGTH,
  TILE_OUTPUT_FORMATS,
  WAIT_UNTIL_OPTIONS,
} from "../constants.js";

const modelDescriptions = VISION_MODELS.map(
  (m) => `"${m}" (${MODEL_CONFIGS[m].defaultTileSize}px tiles, ~${MODEL_CONFIGS[m].tokensPerTile} tokens/tile)`
).join(", ");

const defaultDescriptions = VISION_MODELS.map(
  (m) => `${MODEL_CONFIGS[m].label}: ${MODEL_CONFIGS[m].defaultTileSize}`
).join(", ");

export const TilerInputSchema = {
  // ── Image source fields (tile-image mode) ──
  filePath: z
    .string()
    .min(1, "File path cannot be empty")
    .optional()
    .describe("Absolute or relative path to the image file"),
  sourceUrl: z
    .string()
    .url("Must be a valid URL")
    .optional()
    .describe("HTTPS URL to download the image from (max 50MB, 30s timeout)"),
  dataUrl: z
    .string()
    .max(MAX_DATA_URL_LENGTH, `Data URL must not exceed ${MAX_DATA_URL_LENGTH} characters`)
    .optional()
    .describe('Data URL with base64-encoded image (e.g. "data:image/png;base64,...")'),
  imageBase64: z
    .string()
    .max(MAX_BASE64_LENGTH, `Base64 string must not exceed ${MAX_BASE64_LENGTH} characters`)
    .optional()
    .describe("Raw base64-encoded image data (no data URL prefix)"),

  // ── URL capture fields (capture mode) ──
  url: z
    .string()
    .url("Must be a valid URL")
    .optional()
    .describe("URL of the web page to capture. Requires Chrome/Chromium installed."),
  viewportWidth: z
    .number()
    .int()
    .min(320, "Viewport width must be >= 320px")
    .max(3840, "Viewport width must be <= 3840px")
    .optional()
    .describe("Browser viewport width in pixels. Defaults to 1280 if omitted."),
  waitUntil: z
    .enum(WAIT_UNTIL_OPTIONS)
    .default("load")
    .describe('When to consider the page loaded: "load" (default), "networkidle", or "domcontentloaded"'),
  delay: z
    .number()
    .int()
    .min(0, "Delay must be >= 0")
    .max(30000, "Delay must be <= 30000ms")
    .default(0)
    .describe("Additional delay in ms after the page is loaded, before capturing (default: 0)"),
  screenshotPath: z
    .string()
    .optional()
    .describe(
      "Path to a previously captured screenshot. When provided and accessible, skips URL capture."
    ),

  // ── Tile retrieval fields (get-tiles mode) ──
  tilesDir: z
    .string()
    .min(1, "Tiles directory path cannot be empty")
    .optional()
    .describe(
      "Path to the tiles directory (returned as outputDir from a previous tiling call). When provided, returns tiles as base64 images for pagination."
    ),
  start: z
    .number()
    .int()
    .min(0, "Start index must be >= 0")
    .default(0)
    .describe("Start tile index (0-based, inclusive). Used with tilesDir for pagination."),
  end: z
    .number()
    .int()
    .min(0, "End index must be >= 0")
    .optional()
    .describe(
      `End tile index (0-based, inclusive). Defaults to start + ${MAX_TILES_PER_BATCH - 1}. Max ${MAX_TILES_PER_BATCH} tiles per batch to stay within MCP response limits.`
    ),
  skipBlankTiles: z
    .boolean()
    .default(true)
    .describe("Skip blank tiles in get-tiles mode, returning text annotations instead of images. Set to false to include all tiles. Default: true."),

  // ── Tiling config fields (shared by tile-image and capture modes) ──
  preset: z
    .enum(VISION_MODELS)
    .optional()
    .describe(
      `DO NOT provide on Phase 1 (first call). Only specify on Phase 2 after the user has chosen from the comparison table. ` +
      `Available: ${modelDescriptions}. Auto-selects cheapest when omitted on Phase 2.`
    ),
  model: z
    .enum(VISION_MODELS)
    .optional()
    .describe(
      `Deprecated: use "preset" instead. Accepted for backward compatibility. ` +
      `Available: ${modelDescriptions}.`
    ),
  tileSize: z
    .number()
    .int()
    .min(1, "Tile size must be a positive integer")
    .max(
      MAX_IMAGE_DIMENSION,
      `Tile size must not exceed ${MAX_IMAGE_DIMENSION}px`
    )
    .optional()
    .describe(
      `Tile size in pixels. If omitted, uses the model's optimal default (${defaultDescriptions}). Values outside the model's supported range are automatically clamped with a warning.`
    ),
  maxDimension: z
    .number()
    .int()
    .min(0, "maxDimension must be >= 0 (0 disables auto-downscaling)")
    .max(MAX_IMAGE_DIMENSION, `maxDimension must not exceed ${MAX_IMAGE_DIMENSION}px`)
    .default(DEFAULT_MAX_DIMENSION)
    .transform((val) => {
      // Clamp degenerate values 1-255 up to 256 — these produce unusably small images
      if (val > 0 && val < 256) return 256;
      return val;
    })
    .describe(
      `Max dimension in px (0 to disable, or 256-${MAX_IMAGE_DIMENSION}). When set, the image is resized so its longest side fits within this value before tiling. Reduces token consumption for large images. Defaults to ${DEFAULT_MAX_DIMENSION}px. Set to 0 to disable auto-downscaling.`
    ),
  outputDir: z
    .string()
    .optional()
    .describe(
      "Directory to save tiles. Defaults to tiles/{name}_vN/ next to source for filePath; {base}/tiles/tiled_{ts}_{hex}/ for URL/base64 sources; {base}/tiles/capture_{ts}_{hex}/ for captures."
    ),
  page: z
    .number()
    .int()
    .min(0, "Page must be >= 0")
    .default(0)
    .describe("Tile page to return (0 = first 5, 1 = next 5, etc.). Default: 0"),
  format: z
    .enum(TILE_OUTPUT_FORMATS)
    .default("webp")
    .describe('Output format for tiles: "webp" (smaller, default) or "png" (lossless)'),
  includeMetadata: z
    .boolean()
    .default(true)
    .describe("Analyze each tile and return content hints (blank, low-detail, mixed, high-detail) and brightness stats. Enabled by default; set to false to skip."),
};
