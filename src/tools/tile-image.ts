import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TileImageInputSchema } from "../schemas/index.js";
import { tileImage, computeEstimateForModel } from "../services/image-processor.js";
import { generateInteractivePreview } from "../services/interactive-preview-generator.js";
import { resolveImageSource } from "../services/image-source-resolver.js";
import { analyzeTiles } from "../services/tile-analyzer.js";
import { SUPPORTED_FORMATS, MODEL_CONFIGS, DEFAULT_MODEL, VISION_MODELS, DEFAULT_MAX_DIMENSION } from "../constants.js";
import { getDefaultOutputBase, getVersionedOutputDir } from "../utils.js";
import type { ModelEstimate } from "../types.js";

const TILE_IMAGE_DESCRIPTION = (() => {
  const modelLines = VISION_MODELS.map((m) => {
    const c = MODEL_CONFIGS[m];
    const isDefault = m === DEFAULT_MODEL ? " (default)" : "";
    return `  - "${m}"${isDefault}: ${c.defaultTileSize}px tiles, ~${c.tokensPerTile} tokens/tile`;
  }).join("\n");
  const modelList = VISION_MODELS.map((m) => `"${m}"`).join(", ");
  const exampleLines = VISION_MODELS.filter((m) => m !== DEFAULT_MODEL).map(
    (m) => `  - ${MODEL_CONFIGS[m].label} preset: filePath="/path/to/image.png", model="${m}"`
  ).join("\n");
  return `IMPORTANT: Call tiler_recommend_settings first to show the user token cost estimates for all presets. Only call this tool after the user has reviewed the estimates and confirmed their preferred preset and settings.

Split a large image into optimally-sized tiles for LLM vision analysis. The "model" parameter selects a tiling preset (tile size + token cost) optimized for a specific vision pipeline — it does NOT switch which LLM processes the tiles. Your current LLM is always the one that will analyze the output.

${VISION_MODELS.length} tiling presets available via the "model" parameter:
${modelLines}

Tiles are saved as WebP (default) or PNG files to a 'tiles/{name}' subfolder next to the source image (or a custom output directory).

Supported formats: ${SUPPORTED_FORMATS.join(", ")}

Args:
  - filePath (string, optional): Absolute or relative path to the image file
  - sourceUrl (string, optional): HTTPS URL to download the image from (max 50MB, 30s timeout)
  - dataUrl (string, optional): Data URL with base64-encoded image
  - imageBase64 (string, optional): Raw base64-encoded image data
  - model (string, optional): Tiling preset — selects tile size and token cost optimized for a specific vision pipeline. Options: ${modelList} (default: "${DEFAULT_MODEL}")
  - tileSize (number, optional): Override tile size in pixels. If omitted, uses the preset's optimal default. Clamped to the preset's max with a warning if exceeded.
  - maxDimension (number, optional): Max dimension in px (256-65536). When set, the image is resized so its longest side fits within this value before tiling. Reduces token consumption for large images. No-op if the image is already within bounds. Defaults to 10000px. Set to 0 to disable auto-downscaling.
  - outputDir (string, optional): Custom output directory for tiles
  - format (string, optional): Output format for tiles — "webp" (smaller, default) or "png" (lossless)
  - includeMetadata (boolean, optional): When true, analyze each tile and return content hints and brightness stats

At least one image source (filePath, sourceUrl, dataUrl, or imageBase64) is required.

Returns:
  JSON metadata with source image dimensions, grid layout (rows × cols), total tile count,
  estimated token cost, preset used, output directory path, and per-tile details (index, position, dimensions, file path).

After tiling, use tiler_get_tiles to retrieve tile images in batches for visual analysis.

Examples:
  - Tile for Claude preset (default): filePath="/path/to/screenshot.png"
${exampleLines}
  - Tile from URL: sourceUrl="https://example.com/image.png"
  - Custom tile size: filePath="/path/to/image.png", tileSize=800
  - Auto-downscale (default 10000px): images over 10000px on the longest side are automatically downscaled
  - Custom downscale limit: filePath="/path/to/large-screenshot.png", maxDimension=2048
  - Disable downscaling: filePath="/path/to/image.png", maxDimension=0
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
        openWorldHint: true,
      },
    },
    async ({ filePath, sourceUrl, dataUrl, imageBase64, model, tileSize, maxDimension, outputDir, format, includeMetadata }) => {
      // Validate at least one source is provided
      if (!filePath && !sourceUrl && !dataUrl && !imageBase64) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Error: No image source provided. Supply one of: filePath, sourceUrl, dataUrl, or imageBase64.",
            },
          ],
        };
      }

      const source = await resolveImageSource({ filePath, sourceUrl, dataUrl, imageBase64 });
      try {
        const localPath = source.localPath;

        const ext = path.extname(localPath).toLowerCase().replace(".", "");
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

        // Determine output directory
        let resolvedOutputDir: string;
        if (outputDir) {
          resolvedOutputDir = outputDir;
        } else if (source.sourceType === "file") {
          const basename = path.basename(localPath, path.extname(localPath));
          const baseOutputDir = path.join(path.dirname(path.resolve(localPath)), "tiles", basename);
          resolvedOutputDir = await getVersionedOutputDir(baseOutputDir);
        } else {
          // Non-file sources: use ~/Desktop/tiles/tiled_<timestamp> (or Downloads/home)
          resolvedOutputDir = path.join(getDefaultOutputBase(), "tiles", `tiled_${Date.now()}`);
        }

        const result = await tileImage(
          localPath,
          effectiveTileSize,
          resolvedOutputDir,
          config.tokensPerTile,
          maxDimension === 0 ? undefined : maxDimension,
          config.maxTileSize,
          format
        );

        // For non-file sources, copy the source image (or resized version) to outputDir
        // so preview.html can reference it with a relative path
        let previewSourcePath = localPath;
        if (source.sourceType !== "file") {
          const sourceExt = path.extname(localPath) || ".png";
          const copiedPath = path.join(result.outputDir, `source${sourceExt}`);
          try {
            await fs.copyFile(localPath, copiedPath);
            previewSourcePath = copiedPath;
          } catch {
            // If copy fails, preview background may not work, but tiling still succeeds
            warnings.push("Could not copy source image to output directory — preview background may not display");
          }
        }

        // Compute all-model estimates using effective (post-resize) dimensions
        const allModels: ModelEstimate[] = VISION_MODELS.map((m) =>
          computeEstimateForModel(m, result.sourceImage.width, result.sourceImage.height)
        );

        let previewPath: string | undefined;
        try {
          previewPath = await generateInteractivePreview(
            {
              sourceImagePath: previewSourcePath,
              effectiveWidth: result.sourceImage.width,
              effectiveHeight: result.sourceImage.height,
              originalWidth: result.resize ? result.resize.originalWidth : result.sourceImage.width,
              originalHeight: result.resize ? result.resize.originalHeight : result.sourceImage.height,
              maxDimension: maxDimension ?? DEFAULT_MAX_DIMENSION,
              recommendedModel: model,
              models: allModels,
            },
            result.outputDir
          );
        } catch (previewError) {
          const msg = previewError instanceof Error ? previewError.message : String(previewError);
          warnings.push(`Preview generation failed: ${msg}`);
        }

        const summaryLines: string[] = [];

        if (result.resize) {
          const r = result.resize;
          summaryLines.push(
            `Downscaled from ${r.originalWidth}×${r.originalHeight} → ${r.resizedWidth}×${r.resizedHeight} (${r.scaleFactor}x) before tiling`
          );
        }

        summaryLines.push(
          `Tiled ${result.sourceImage.width}×${result.sourceImage.height} ${result.sourceImage.format} image for ${config.label}`,
          `→ ${result.grid.cols}×${result.grid.rows} grid = ${result.grid.totalTiles} tiles of ${result.grid.tileSize}px`,
          `→ Estimated tokens: ~${result.grid.estimatedTokens.toLocaleString()} (all tiles, ${config.tokensPerTile}/tile)`,
          `→ Saved to: ${result.outputDir}`,
        );

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

        if (result.resize) {
          structuredOutput.resize = result.resize;
        }

        if (includeMetadata) {
          const tileMetadata = await analyzeTiles(result.tiles.map((t) => t.filePath));
          structuredOutput.tileMetadata = tileMetadata;
        }

        if (previewPath) {
          structuredOutput.previewPath = previewPath;
        }

        if (warnings.length > 0) {
          structuredOutput.warnings = warnings;
        }

        const content: Array<{ type: "text"; text: string }> = [
          { type: "text" as const, text: summary },
          {
            type: "text" as const,
            text: JSON.stringify(structuredOutput, null, 2),
          },
        ];

        if (previewPath) {
          content.push({
            type: "text" as const,
            text: `Preview: ${previewPath}`,
          });
        }

        return { content };
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
      } finally {
        await source.cleanup?.();
      }
    }
  );
}
