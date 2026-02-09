import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TileImageInputSchema } from "../schemas/index.js";
import { tileImage } from "../services/image-processor.js";
import { generatePreview } from "../services/preview-generator.js";
import { SUPPORTED_FORMATS, MODEL_CONFIGS, DEFAULT_MODEL, VISION_MODELS } from "../constants.js";

const TILE_IMAGE_DESCRIPTION = (() => {
  const modelLines = VISION_MODELS.map((m) => {
    const c = MODEL_CONFIGS[m];
    const isDefault = m === DEFAULT_MODEL ? " (default)" : "";
    return `  - "${m}"${isDefault}: ${c.defaultTileSize}px tiles, ~${c.tokensPerTile} tokens/tile`;
  }).join("\n");
  const modelList = VISION_MODELS.map((m) => `"${m}"`).join(", ");
  const exampleLines = VISION_MODELS.filter((m) => m !== DEFAULT_MODEL).map(
    (m) => `  - Tile for ${MODEL_CONFIGS[m].label}: filePath="/path/to/image.png", model="${m}"`
  ).join("\n");
  return `Split a large image into optimally-sized tiles for LLM vision analysis.

Supports ${VISION_MODELS.length} vision models via the "model" parameter:
${modelLines}

Tiles are saved as PNG files to a 'tiles' subfolder next to the source image (or a custom output directory).

Supported formats: ${SUPPORTED_FORMATS.join(", ")}

Args:
  - filePath (string, required): Absolute or relative path to the image file
  - model (string, optional): Target vision model — ${modelList} (default: "${DEFAULT_MODEL}")
  - tileSize (number, optional): Override tile size in pixels. If omitted, uses the model's optimal default. Clamped to the model's max with a warning if exceeded.
  - outputDir (string, optional): Custom output directory for tiles

Returns:
  JSON metadata with source image dimensions, grid layout (rows × cols), total tile count,
  estimated token cost, model used, output directory path, and per-tile details (index, position, dimensions, file path).

After tiling, use tiler_get_tiles to retrieve tile images in batches for visual analysis.

Examples:
  - Tile for Claude (default): filePath="/path/to/screenshot.png"
${exampleLines}
  - Custom tile size: filePath="/path/to/image.png", tileSize=800
  - Custom output: filePath="/path/to/image.png", outputDir="/tmp/my-tiles"`;
})();

export function registerTileImageTool(server: McpServer): void {
  server.registerTool(
    "tiler_tile_image",
    {
      title: "Tile Image for LLM Vision",
      description: TILE_IMAGE_DESCRIPTION,
      inputSchema: TileImageInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filePath, model, tileSize, outputDir, cleanup }) => {
      try {
        const ext = path.extname(filePath).toLowerCase().replace(".", "");
        if (ext && !SUPPORTED_FORMATS.includes(ext as typeof SUPPORTED_FORMATS[number])) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Error: Unsupported image format '.${ext}'. Supported formats: ${SUPPORTED_FORMATS.join(", ")}`,
              },
            ],
          };
        }

        const config = MODEL_CONFIGS[model];
        const warnings: string[] = [];

        let effectiveTileSize = tileSize ?? config.defaultTileSize;

        // Clamp to model bounds (per project philosophy: clamp, don't reject)
        if (effectiveTileSize > config.maxTileSize) {
          warnings.push(
            `Tile size ${effectiveTileSize}px exceeds ${config.label}'s maximum of ${config.maxTileSize}px — clamped to ${config.maxTileSize}px`
          );
          effectiveTileSize = config.maxTileSize;
        }
        if (effectiveTileSize < config.minTileSize) {
          warnings.push(
            `Tile size ${effectiveTileSize}px is below minimum of ${config.minTileSize}px — clamped to ${config.minTileSize}px`
          );
          effectiveTileSize = config.minTileSize;
        }

        const resolvedOutputDir =
          outputDir || path.join(path.dirname(path.resolve(filePath)), "tiles");

        const result = await tileImage(
          filePath,
          effectiveTileSize,
          resolvedOutputDir,
          config.tokensPerTile
        );

        let previewPath: string | undefined;
        try {
          previewPath = await generatePreview(result, filePath, model);
        } catch (previewError) {
          const msg = previewError instanceof Error ? previewError.message : String(previewError);
          warnings.push(`Preview generation failed: ${msg}`);
        }

        const summaryLines = [
          `Tiled ${result.sourceImage.width}×${result.sourceImage.height} ${result.sourceImage.format} image for ${config.label}`,
          `→ ${result.grid.cols}×${result.grid.rows} grid = ${result.grid.totalTiles} tiles of ${result.grid.tileSize}px`,
          `→ Estimated tokens: ~${result.grid.estimatedTokens.toLocaleString()} (all tiles, ${config.tokensPerTile}/tile)`,
          `→ Saved to: ${result.outputDir}`,
        ];

        if (previewPath) {
          summaryLines.push(
            `→ Preview: preview.html (open in browser to visualize the grid)`
          );
        }

        if (cleanup) {
          summaryLines.push(
            `→ Tiles will be cleaned up after last batch is served`
          );
        }

        if (warnings.length > 0) {
          summaryLines.push("");
          summaryLines.push(`⚠ ${warnings.join("\n⚠ ")}`);
        }

        summaryLines.push(
          "",
          `Use tiler_get_tiles with tilesDir="${result.outputDir}" to retrieve tiles in batches.`,
          `Tiles are numbered 0-${result.grid.totalTiles - 1}, reading left-to-right, top-to-bottom.`
        );

        const summary = summaryLines.join("\n");

        const structuredOutput: Record<string, unknown> = {
          model,
          sourceImage: result.sourceImage,
          grid: result.grid,
          outputDir: result.outputDir,
          tiles: result.tiles.map((t) => ({
            index: t.index,
            row: t.row,
            col: t.col,
            position: `${t.x},${t.y}`,
            dimensions: `${t.width}×${t.height}`,
            filePath: t.filePath,
          })),
        };

        if (previewPath) {
          structuredOutput.previewPath = previewPath;
        }

        if (cleanup) {
          structuredOutput.cleanup = true;
        }

        if (warnings.length > 0) {
          structuredOutput.warnings = warnings;
        }

        return {
          content: [
            { type: "text" as const, text: summary },
            {
              type: "text" as const,
              text: JSON.stringify(structuredOutput, null, 2),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error tiling image: ${message}`,
            },
          ],
        };
      }
    }
  );
}
