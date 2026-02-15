import { z } from "zod";
import {
  MAX_IMAGE_DIMENSION,
  MAX_TILES_PER_BATCH,
  VISION_MODELS,
  DEFAULT_MODEL,
  MODEL_CONFIGS,
  DEFAULT_MAX_DIMENSION,
  MAX_BASE64_LENGTH,
  MAX_DATA_URL_LENGTH,
  IMAGE_INTENTS,
  BUDGET_LEVELS,
  TILE_OUTPUT_FORMATS,
  WAIT_UNTIL_OPTIONS,
} from "../constants.js";

const modelDescriptions = VISION_MODELS.map(
  (m) => `"${m}" (${MODEL_CONFIGS[m].defaultTileSize}px tiles, ~${MODEL_CONFIGS[m].tokensPerTile} tokens/tile)`
).join(", ");

const defaultDescriptions = VISION_MODELS.map(
  (m) => `${MODEL_CONFIGS[m].label}: ${MODEL_CONFIGS[m].defaultTileSize}`
).join(", ");

// Shared image source fields — used by tile-image, recommend-settings, and prepare-image
export const imageSourceFields = {
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
};

export const TileImageInputSchema = {
  ...imageSourceFields,
  model: z
    .enum(VISION_MODELS)
    .default(DEFAULT_MODEL)
    .describe(
      `Target vision model: ${modelDescriptions}. Default: "${DEFAULT_MODEL}"`
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
    .describe(
      `Max dimension in px (256-${MAX_IMAGE_DIMENSION}). When set, the image is resized so its longest side fits within this value before tiling. Reduces token consumption for large images. Defaults to ${DEFAULT_MAX_DIMENSION}px. Set to 0 to disable auto-downscaling.`
    ),
  outputDir: z
    .string()
    .optional()
    .describe(
      "Directory to save tiles. Defaults to a 'tiles' subfolder next to the source image"
    ),
  format: z
    .enum(TILE_OUTPUT_FORMATS)
    .default("webp")
    .describe('Output format for tiles: "webp" (smaller, default) or "png" (lossless)'),
  includeMetadata: z
    .boolean()
    .default(false)
    .describe("When true, analyze each tile and return content hints (text-heavy, image-rich, low-detail, mixed) and brightness stats"),
};

export const GetTilesInputSchema = {
  tilesDir: z
    .string()
    .min(1, "Tiles directory path cannot be empty")
    .describe(
      "Path to the tiles directory (returned by tiler_tile_image as outputDir)"
    ),
  start: z
    .number()
    .int()
    .min(0, "Start index must be >= 0")
    .default(0)
    .describe("Start tile index (0-based, inclusive)"),
  end: z
    .number()
    .int()
    .min(0, "End index must be >= 0")
    .optional()
    .describe(
      `End tile index (0-based, inclusive). Defaults to start + ${MAX_TILES_PER_BATCH - 1}. Max ${MAX_TILES_PER_BATCH} tiles per batch to stay within MCP response limits`
    ),
};

export const RecommendSettingsInputSchema = {
  ...imageSourceFields,
  model: z
    .enum(VISION_MODELS)
    .optional()
    .describe(
      `Target vision model. If omitted, recommendations use the default ("${DEFAULT_MODEL}") but all-model comparison is always returned.`
    ),
  tileSize: z
    .number()
    .int()
    .min(1, "Tile size must be a positive integer")
    .max(MAX_IMAGE_DIMENSION, `Tile size must not exceed ${MAX_IMAGE_DIMENSION}px`)
    .optional()
    .describe("Override tile size. If provided, skips tile-size heuristics."),
  maxDimension: z
    .number()
    .int()
    .min(0, "maxDimension must be >= 0 (0 disables auto-downscaling)")
    .max(MAX_IMAGE_DIMENSION, `maxDimension must not exceed ${MAX_IMAGE_DIMENSION}px`)
    .optional()
    .describe("Override max dimension. If provided, skips maxDimension heuristics."),
  intent: z
    .enum(IMAGE_INTENTS)
    .optional()
    .describe('Image intent hint: "text_heavy", "ui_screenshot", "diagram", "photo", or "general". Affects heuristic recommendations.'),
  budget: z
    .enum(BUDGET_LEVELS)
    .optional()
    .describe('Token budget preference: "low" (fewer tokens), "default", or "max_detail" (preserve all detail).'),
};

export const PrepareImageInputSchema = {
  ...imageSourceFields,
  model: z
    .enum(VISION_MODELS)
    .default(DEFAULT_MODEL)
    .describe(
      `Target vision model: ${modelDescriptions}. Default: "${DEFAULT_MODEL}"`
    ),
  tileSize: z
    .number()
    .int()
    .min(1, "Tile size must be a positive integer")
    .max(MAX_IMAGE_DIMENSION, `Tile size must not exceed ${MAX_IMAGE_DIMENSION}px`)
    .optional()
    .describe(
      `Tile size in pixels. If omitted, uses the model's optimal default (${defaultDescriptions}).`
    ),
  maxDimension: z
    .number()
    .int()
    .min(0, "maxDimension must be >= 0 (0 disables auto-downscaling)")
    .max(MAX_IMAGE_DIMENSION, `maxDimension must not exceed ${MAX_IMAGE_DIMENSION}px`)
    .default(DEFAULT_MAX_DIMENSION)
    .describe(
      `Max dimension in px. Defaults to ${DEFAULT_MAX_DIMENSION}px. Set to 0 to disable.`
    ),
  outputDir: z
    .string()
    .optional()
    .describe("Directory to save tiles. Defaults to a 'tiles' subfolder next to the source image"),
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
    .default(false)
    .describe("When true, analyze each tile and return content hints (text-heavy, image-rich, low-detail, mixed) and brightness stats"),
};

// Shared capture fields — used by capture-url and capture-and-tile
export const captureFields = {
  url: z.string().url("Must be a valid URL").describe("URL of the web page to capture"),
  viewportWidth: z
    .number()
    .int()
    .min(320, "Viewport width must be >= 320px")
    .max(3840, "Viewport width must be <= 3840px")
    .optional()
    .describe("Browser viewport width in pixels. Auto-detects screen width if omitted, falls back to 1280."),
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
};

export const CaptureUrlInputSchema = {
  ...captureFields,
  outputDir: z
    .string()
    .optional()
    .describe("Directory to save the screenshot. Defaults to ~/Desktop/captures/ (or ~/Downloads/captures/, ~/captures/)"),
  format: z
    .enum(TILE_OUTPUT_FORMATS)
    .default("webp")
    .describe('Output format for the screenshot: "webp" (smaller, default) or "png" (lossless)'),
};

export const CaptureAndTileInputSchema = {
  ...captureFields,
  model: z
    .enum(VISION_MODELS)
    .default(DEFAULT_MODEL)
    .describe(
      `Target vision model: ${modelDescriptions}. Default: "${DEFAULT_MODEL}"`
    ),
  tileSize: z
    .number()
    .int()
    .min(1, "Tile size must be a positive integer")
    .max(MAX_IMAGE_DIMENSION, `Tile size must not exceed ${MAX_IMAGE_DIMENSION}px`)
    .optional()
    .describe(
      `Tile size in pixels. If omitted, uses the model's optimal default (${defaultDescriptions}).`
    ),
  maxDimension: z
    .number()
    .int()
    .min(0, "maxDimension must be >= 0 (0 disables auto-downscaling)")
    .max(MAX_IMAGE_DIMENSION, `maxDimension must not exceed ${MAX_IMAGE_DIMENSION}px`)
    .default(DEFAULT_MAX_DIMENSION)
    .describe(
      `Max dimension in px. Defaults to ${DEFAULT_MAX_DIMENSION}px. Set to 0 to disable.`
    ),
  format: z
    .enum(TILE_OUTPUT_FORMATS)
    .default("webp")
    .describe('Output format for tiles: "webp" (smaller, default) or "png" (lossless)'),
  outputDir: z
    .string()
    .optional()
    .describe("Directory to save tiles. Defaults to ~/Desktop/tiles/capture_<timestamp>/ (or ~/Downloads, ~)"),
  page: z
    .number()
    .int()
    .min(0, "Page must be >= 0")
    .default(0)
    .describe("Tile page to return (0 = first 5, 1 = next 5, etc.). Default: 0"),
  includeMetadata: z
    .boolean()
    .default(false)
    .describe("When true, analyze each tile and return content hints and brightness stats"),
};
