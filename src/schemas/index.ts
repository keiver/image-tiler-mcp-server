import { z } from "zod";
import {
  MAX_IMAGE_DIMENSION,
  MAX_TILES_PER_BATCH,
  VISION_MODELS,
  DEFAULT_MODEL,
  MODEL_CONFIGS,
  DEFAULT_MAX_DIMENSION,
} from "../constants.js";

const modelDescriptions = VISION_MODELS.map(
  (m) => `"${m}" (${MODEL_CONFIGS[m].defaultTileSize}px tiles, ~${MODEL_CONFIGS[m].tokensPerTile} tokens/tile)`
).join(", ");

const defaultDescriptions = VISION_MODELS.map(
  (m) => `${MODEL_CONFIGS[m].label}: ${MODEL_CONFIGS[m].defaultTileSize}`
).join(", ");

export const TileImageInputSchema = {
  filePath: z
    .string()
    .min(1, "File path cannot be empty")
    .describe("Absolute or relative path to the image file to tile"),
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
