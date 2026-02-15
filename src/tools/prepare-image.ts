import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PrepareImageInputSchema } from "../schemas/index.js";
import { tileImage, listTilesInDirectory, readTileAsBase64, computeEstimateForModel } from "../services/image-processor.js";
import { generateInteractivePreview } from "../services/interactive-preview-generator.js";
import { resolveImageSource } from "../services/image-source-resolver.js";
import { analyzeTiles } from "../services/tile-analyzer.js";
import { SUPPORTED_FORMATS, MODEL_CONFIGS, DEFAULT_MODEL, VISION_MODELS, MAX_TILES_PER_BATCH, DEFAULT_MAX_DIMENSION } from "../constants.js";
import { getDefaultOutputBase, getVersionedOutputDir } from "../utils.js";
import type { ModelEstimate } from "../types.js";

const modelList = VISION_MODELS.map((m) => `"${m}"`).join(", ");

const PREPARE_IMAGE_DESCRIPTION = `IMPORTANT: Call tiler_recommend_settings first to show the user token cost estimates. Only use this after the user has confirmed a preset and settings.

Convenience tool for when the user has already confirmed settings via tiler_recommend_settings and wants tiling + first batch of tiles in one call. Combines tiler_tile_image + tiler_get_tiles into one round-trip.

Accepts image from: filePath, sourceUrl, dataUrl, or imageBase64 (at least one required).

Supported formats: ${SUPPORTED_FORMATS.join(", ")}

Args:
  - filePath (string, optional): Path to the image file
  - sourceUrl (string, optional): HTTPS URL to download the image from
  - dataUrl (string, optional): Data URL with base64-encoded image
  - imageBase64 (string, optional): Raw base64-encoded image data
  - model (string, optional): Tiling preset — selects tile size and token cost optimized for a specific vision pipeline. Options: ${modelList} (default: "${DEFAULT_MODEL}")
  - tileSize (number, optional): Override tile size in pixels
  - maxDimension (number, optional): Max dimension for auto-downscaling (default: 10000, 0 to disable)
  - outputDir (string, optional): Custom output directory
  - page (number, optional): Tile page to return (0 = tiles 0-4, 1 = tiles 5-9, etc.). Default: 0

Returns:
  1. Text summary (same as tiler_tile_image)
  2. JSON metadata with tiling result + page info
  3. Up to ${MAX_TILES_PER_BATCH} tile images as base64 content blocks
  4. Pagination hint if more tiles exist`;

export function registerPrepareImageTool(server: McpServer): void {
  server.registerTool(
    "tiler_prepare_image",
    {
      title: "Prepare Image (Tile + Get)",
      description: PREPARE_IMAGE_DESCRIPTION,
      inputSchema: PrepareImageInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ filePath, sourceUrl, dataUrl, imageBase64, model, tileSize, maxDimension, outputDir, page, format, includeMetadata }) => {
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

        // Copy source image for non-file sources so preview works
        let previewSourcePath = localPath;
        if (source.sourceType !== "file") {
          const sourceExt = path.extname(localPath) || ".png";
          const copiedPath = path.join(result.outputDir, `source${sourceExt}`);
          try {
            await fs.copyFile(localPath, copiedPath);
            previewSourcePath = copiedPath;
          } catch {
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

        // Build summary
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
          summaryLines.push("", `⚠ ${warnings.join("\n⚠ ")}`);
        }

        // Read tiles for requested page
        const tilePaths = await listTilesInDirectory(result.outputDir);
        const totalTiles = tilePaths.length;
        const start = page * MAX_TILES_PER_BATCH;
        const end = Math.min(start + MAX_TILES_PER_BATCH - 1, totalTiles - 1);
        const hasMore = end < totalTiles - 1;

        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [];

        content.push({ type: "text" as const, text: summaryLines.join("\n") });

        // Structured JSON with page info
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
          page: {
            current: page,
            tilesReturned: start <= end ? end - start + 1 : 0,
            totalTiles,
            hasMore,
          },
        };
        if (result.resize) structuredOutput.resize = result.resize;
        if (includeMetadata) {
          const tileMetadata = await analyzeTiles(result.tiles.map((t) => t.filePath));
          structuredOutput.tileMetadata = tileMetadata;
        }
        if (previewPath) structuredOutput.previewPath = previewPath;
        if (warnings.length > 0) structuredOutput.warnings = warnings;

        content.push({
          type: "text" as const,
          text: JSON.stringify(structuredOutput, null, 2),
        });

        if (previewPath) {
          content.push({
            type: "text" as const,
            text: `Preview: ${previewPath}`,
          });
        }

        // Add tile images for this page
        if (start < totalTiles) {
          for (let i = start; i <= end; i++) {
            const tilePath = tilePaths[i];
            const filename = path.basename(tilePath);
            const match = filename.match(/tile_(\d+)_(\d+)\.(png|webp)/);
            const row = match ? parseInt(match[1], 10) : -1;
            const col = match ? parseInt(match[2], 10) : -1;
            const mimeType = path.extname(tilePath) === ".webp" ? "image/webp" : "image/png";

            content.push({
              type: "text" as const,
              text: `--- Tile ${i} (row ${row}, col ${col}) ---`,
            });

            const base64Data = await readTileAsBase64(tilePath);
            content.push({
              type: "image" as const,
              data: base64Data,
              mimeType,
            });
          }
        }

        // Pagination hint
        if (hasMore) {
          content.push({
            type: "text" as const,
            text: `Next page: tiler_get_tiles(tilesDir="${result.outputDir}", start=${end + 1}) or tiler_prepare_image(..., page=${page + 1})`,
          });
        }

        return { content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error preparing image: ${message}`,
            },
          ],
        };
      } finally {
        await source.cleanup?.();
      }
    }
  );
}
