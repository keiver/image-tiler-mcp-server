import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PrepareImageInputSchema } from "../schemas/index.js";
import { tileImage, listTilesInDirectory, readTileAsBase64, computeEstimateForModel, getImageMetadata } from "../services/image-processor.js";
import { generateInteractivePreview } from "../services/interactive-preview-generator.js";
import { resolveImageSource } from "../services/image-source-resolver.js";
import { analyzeTiles } from "../services/tile-analyzer.js";
import { SUPPORTED_FORMATS, MODEL_CONFIGS, DEFAULT_MODEL, VISION_MODELS, MAX_TILES_PER_BATCH, DEFAULT_MAX_DIMENSION } from "../constants.js";
import { getDefaultOutputBase, getVersionedOutputDir, stripVersionSuffix, buildTileHints } from "../utils.js";
import { confirmTiling } from "../services/elicitation.js";
import type { ModelEstimate } from "../types.js";

const modelList = VISION_MODELS.map((m) => `"${m}"`).join(", ");

const PREPARE_IMAGE_DESCRIPTION = `Convenience tool that combines tiling + first batch of tiles in one call (tiler_tile_image + tiler_get_tiles). Consider calling tiler_recommend_settings first to compare presets and estimate costs. If the client supports it, the user will be asked to confirm before tiling proceeds.

**Two-phase confirmation flow:** When called without \`confirmed=true\`, this tool returns a model comparison table instead of tiling. Review the estimates, then call again with \`confirmed=true\` (and optionally a different \`model\`) to proceed.

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
  - confirmed (boolean, optional): Set to true to skip confirmation and proceed with tiling. Use after reviewing the model comparison from a previous call.

Returns:
  1. Text summary with grid dimensions, token estimate, output path, and preview path
  2. Compact JSON with model, sourceImage, grid, outputDir, tileHints (when metadata enabled), page info, and previewPath
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
    async ({ filePath, sourceUrl, dataUrl, imageBase64, model, tileSize, maxDimension, outputDir, page, format, includeMetadata, confirmed }) => {
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

        // Compute all-model estimates before confirmation
        const imgMeta = await getImageMetadata(localPath);
        const effectiveMaxDim = maxDimension === 0 ? undefined : maxDimension;
        const allModelsPreEstimate: ModelEstimate[] = VISION_MODELS.map((m) =>
          computeEstimateForModel(m, imgMeta.width, imgMeta.height, undefined, effectiveMaxDim)
        );
        const preEstimate = computeEstimateForModel(model, imgMeta.width, imgMeta.height, effectiveTileSize, effectiveMaxDim);

        // Confirmation: elicitation (Path A), pending confirmation (Path B), or bypass
        const confirmResult = await confirmTiling(server, {
          width: imgMeta.width,
          height: imgMeta.height,
          model,
          gridCols: preEstimate.cols,
          gridRows: preEstimate.rows,
          totalTiles: preEstimate.tiles,
          estimatedTokens: preEstimate.tokens,
          allModels: allModelsPreEstimate,
          confirmed,
        });

        if (confirmResult.pendingConfirmation) {
          return {
            content: [
              {
                type: "text" as const,
                text: confirmResult.pendingConfirmation.summary,
              },
              {
                type: "text" as const,
                text: JSON.stringify({ status: "pending_confirmation", allModels: confirmResult.pendingConfirmation.allModels }, null, 2),
              },
            ],
          };
        }

        if (!confirmResult.confirmed) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Tiling cancelled by user.\n\nImage: ${imgMeta.width} x ${imgMeta.height}\nPreset: ${config.label} (${preEstimate.cols}x${preEstimate.rows} grid, ${preEstimate.tiles} tiles, ~${preEstimate.tokens.toLocaleString()} tokens)`,
              },
            ],
          };
        }

        // If user selected a different model via elicitation, switch to it
        let effectiveModel: string = model;
        let effectiveConfig = config;
        if (confirmResult.selectedModel && confirmResult.selectedModel !== model) {
          effectiveModel = confirmResult.selectedModel;
          effectiveConfig = MODEL_CONFIGS[effectiveModel as keyof typeof MODEL_CONFIGS];
          effectiveTileSize = tileSize ?? effectiveConfig.defaultTileSize;
          if (effectiveTileSize > effectiveConfig.maxTileSize) {
            effectiveTileSize = effectiveConfig.maxTileSize;
          }
          if (effectiveTileSize < effectiveConfig.minTileSize) {
            effectiveTileSize = effectiveConfig.minTileSize;
          }
        }

        // Determine output directory
        let resolvedOutputDir: string;
        if (outputDir) {
          resolvedOutputDir = outputDir;
        } else if (source.sourceType === "file") {
          const basename = stripVersionSuffix(path.basename(localPath, path.extname(localPath)));
          const baseOutputDir = path.join(path.dirname(path.resolve(localPath)), "tiles", basename);
          resolvedOutputDir = await getVersionedOutputDir(baseOutputDir);
        } else {
          resolvedOutputDir = path.join(getDefaultOutputBase(), "tiles", `tiled_${Date.now()}`);
        }

        const result = await tileImage(
          localPath,
          effectiveTileSize,
          resolvedOutputDir,
          effectiveConfig.tokensPerTile,
          effectiveMaxDim,
          effectiveConfig.maxTileSize,
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
              recommendedModel: effectiveModel,
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
          `Tiled ${result.sourceImage.width}x${result.sourceImage.height} image for ${effectiveConfig.label}`,
          `  ${result.grid.cols}x${result.grid.rows} grid, ${result.grid.totalTiles} tiles at ${result.grid.tileSize}px (~${result.grid.estimatedTokens.toLocaleString()} tokens)`,
          `  Saved to: ${result.outputDir}`,
        );
        if (previewPath) {
          summaryLines.push(`  Preview: ${previewPath}`);
        }
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
          model: effectiveModel,
          sourceImage: result.sourceImage,
          grid: result.grid,
          outputDir: result.outputDir,
          page: {
            current: page,
            tilesReturned: start <= end ? end - start + 1 : 0,
            totalTiles,
            hasMore,
          },
        };
        if (includeMetadata) {
          const tileMetadata = await analyzeTiles(result.tiles.map((t) => t.filePath));
          structuredOutput.tileHints = buildTileHints(tileMetadata);
        }
        if (result.resize) structuredOutput.resize = result.resize;
        if (previewPath) structuredOutput.previewPath = previewPath;
        if (warnings.length > 0) structuredOutput.warnings = warnings;

        content.push({
          type: "text" as const,
          text: JSON.stringify(structuredOutput, null, 2),
        });

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
              text: `Tile ${i + 1}/${totalTiles} [row ${row}, col ${col}]`,
            });

            const base64Data = await readTileAsBase64(tilePath);
            content.push({
              type: "image" as const,
              data: base64Data,
              mimeType,
            });
          }
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
