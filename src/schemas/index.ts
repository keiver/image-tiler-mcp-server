import { z } from "zod";
import {
  MAX_IMAGE_DIMENSION,
  MAX_TILES_PER_BATCH,
  VISION_MODELS,
  DEFAULT_MODEL,
  MODEL_CONFIGS,
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
  outputDir: z
    .string()
    .optional()
    .describe(
      "Directory to save tiles. Defaults to a 'tiles' subfolder next to the source image"
    ),
  cleanup: z
    .boolean()
    .default(false)
    .describe(
      "If true, tiles directory will be deleted after the last batch is served by tiler_get_tiles. Default: false (tiles persist on disk)."
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
  cleanup: z
    .boolean()
    .default(false)
    .describe(
      "If true, delete the tiles directory after serving the last batch. Passed from tiler_tile_image metadata."
    ),
};
