import { z } from "zod";
import {
  MIN_TILE_SIZE,
  MAX_TILES_PER_BATCH,
  VISION_MODELS,
  DEFAULT_MODEL,
  MODEL_CONFIGS,
} from "../constants.js";

// Global max across all models (gemini3 allows up to 3072)
const GLOBAL_MAX_TILE_SIZE = 3072;

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
    .min(MIN_TILE_SIZE, `Tile size must be at least ${MIN_TILE_SIZE}px`)
    .max(
      GLOBAL_MAX_TILE_SIZE,
      `Tile size must not exceed ${GLOBAL_MAX_TILE_SIZE}px`
    )
    .optional()
    .describe(
      `Tile size in pixels. If omitted, uses the model's optimal default (${defaultDescriptions}). Clamped to the model's max if it exceeds the model's limit.`
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
