import * as fs from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CaptureAndTileInputSchema } from "../schemas/index.js";
import { captureUrl, detectDisplayWidth } from "../services/url-capture.js";
import { tileImage, listTilesInDirectory, readTileAsBase64, computeEstimateForModel } from "../services/image-processor.js";
import { generateInteractivePreview } from "../services/interactive-preview-generator.js";
import { analyzeTiles } from "../services/tile-analyzer.js";
import {
  PNG_COMPRESSION_LEVEL,
  MODEL_CONFIGS,
  DEFAULT_MODEL,
  VISION_MODELS,
  MAX_TILES_PER_BATCH,
  DEFAULT_MAX_DIMENSION,
  CAPTURE_DEFAULT_VIEWPORT_WIDTH,
  WAIT_UNTIL_OPTIONS,
} from "../constants.js";
import { getDefaultOutputBase, sanitizeHostname, buildTileHints } from "../utils.js";
import { confirmTiling } from "../services/elicitation.js";
import type { ModelEstimate } from "../types.js";

const modelList = VISION_MODELS.map((m) => `"${m}"`).join(", ");
const waitOptions = WAIT_UNTIL_OPTIONS.map((o) => `"${o}"`).join(", ");

const CAPTURE_AND_TILE_DESCRIPTION = `Capture a web page screenshot and tile it for LLM vision analysis in one step. Requires Google Chrome installed locally (or set CHROME_PATH env var).

Consider calling tiler_recommend_settings first to compare presets and estimate costs. If the client supports it, the user will be asked to confirm before tiling proceeds.

Combines tiler_capture_url + tiler_tile_image + tiler_get_tiles into a single tool call. Supports full-page scroll-stitching for pages taller than 16,384px.

Args:
  - url (string, required): URL of the web page to capture (http or https)
  - viewportWidth (number, optional): Browser viewport width (default: ${CAPTURE_DEFAULT_VIEWPORT_WIDTH}, range: 320-3840)
  - waitUntil (string, optional): When to consider the page loaded: ${waitOptions} (default: "load")
  - delay (number, optional): Additional delay in ms after page load (default: 0, max: 30000)
  - model (string, optional): Tiling preset — ${modelList} (default: "${DEFAULT_MODEL}")
  - tileSize (number, optional): Override tile size in pixels
  - maxDimension (number, optional): Max dimension for auto-downscaling (default: ${DEFAULT_MAX_DIMENSION}, 0 to disable)
  - format (string, optional): Output format — "webp" (smaller, default) or "png" (lossless)
  - outputDir (string, optional): Custom output directory
  - page (number, optional): Tile page to return (0 = first ${MAX_TILES_PER_BATCH}, 1 = next ${MAX_TILES_PER_BATCH}, etc.)
  - includeMetadata (boolean, optional): Analyze each tile for content hints. Enabled by default; set to false to skip.

Returns:
  1. Text summary with capture + tiling info
  2. Compact JSON with capture details, model, sourceImage, grid, outputDir, tileHints (when metadata enabled), page info, and allModels comparison
  3. Up to ${MAX_TILES_PER_BATCH} tile images as base64 content blocks
  4. Pagination hint if more tiles exist

For more control over the tiling model, use the multi-step flow:
  1. tiler_capture_url \u2192 save screenshot
  2. tiler_recommend_settings with the saved filePath \u2192 compare models, see preview
  3. tiler_tile_image or tiler_prepare_image with the user's chosen model

Only use this one-shot tool when the user has already specified a model, or explicitly requested a quick capture-and-tile.`;

export function registerCaptureAndTileTool(server: McpServer): void {
  server.registerTool(
    "tiler_capture_and_tile",
    {
      title: "Capture URL & Tile",
      description: CAPTURE_AND_TILE_DESCRIPTION,
      inputSchema: CaptureAndTileInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, viewportWidth, waitUntil, delay, model, tileSize, maxDimension, format, outputDir, page, includeMetadata }) => {
      try {
        // 1. Capture the page
        const resolvedViewport = viewportWidth ?? detectDisplayWidth() ?? CAPTURE_DEFAULT_VIEWPORT_WIDTH;
        const captureResult = await captureUrl({ url, viewportWidth: resolvedViewport, waitUntil, delay });

        // Determine output directory
        const resolvedOutputDir = outputDir
          ? path.resolve(outputDir)
          : path.join(getDefaultOutputBase(), "tiles", `capture_${Date.now()}`);
        await fs.mkdir(resolvedOutputDir, { recursive: true });

        // Always save the intermediate screenshot as PNG — WebP has dimension limits
        // that fail on tall pages. The `format` param controls tile output only.
        const baseName = sanitizeHostname(url);
        const screenshotPath = path.join(resolvedOutputDir, `${baseName}.png`);
        await sharp(captureResult.buffer)
          .png({ compressionLevel: PNG_COMPRESSION_LEVEL })
          .toFile(screenshotPath);

        // 2. Tile the screenshot
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

        // Elicitation: ask user to confirm before tiling (if client supports it)
        const preEstimate = computeEstimateForModel(model, captureResult.pageWidth, captureResult.pageHeight, effectiveTileSize, maxDimension === 0 ? undefined : maxDimension);
        const { confirmed } = await confirmTiling(
          server, captureResult.pageWidth, captureResult.pageHeight, model,
          preEstimate.cols, preEstimate.rows, preEstimate.tiles, preEstimate.tokens
        );
        if (!confirmed) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Tiling cancelled by user.\n\nCaptured: ${captureResult.pageWidth} x ${captureResult.pageHeight}\nScreenshot saved to: ${screenshotPath}\nPreset: ${config.label} (${preEstimate.cols}x${preEstimate.rows} grid, ${preEstimate.tiles} tiles, ~${preEstimate.tokens.toLocaleString()} tokens)`,
              },
            ],
          };
        }

        const result = await tileImage(
          screenshotPath,
          effectiveTileSize,
          resolvedOutputDir,
          config.tokensPerTile,
          maxDimension === 0 ? undefined : maxDimension,
          config.maxTileSize,
          format
        );

        // Compute all-model estimates
        const allModels: ModelEstimate[] = VISION_MODELS.map((m) =>
          computeEstimateForModel(m, result.sourceImage.width, result.sourceImage.height)
        );

        // Generate preview
        let previewPath: string | undefined;
        try {
          previewPath = await generateInteractivePreview(
            {
              sourceImagePath: screenshotPath,
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

        // 3. Build summary
        const summaryLines: string[] = [];

        summaryLines.push(
          `Captured ${captureResult.pageWidth}x${captureResult.pageHeight} screenshot of ${url}`
        );
        if (captureResult.segmentsStitched) {
          summaryLines.push(
            `  Scroll-stitched ${captureResult.segmentsStitched} segments`
          );
        }

        if (result.resize) {
          const r = result.resize;
          summaryLines.push(
            `Downscaled from ${r.originalWidth}×${r.originalHeight} → ${r.resizedWidth}×${r.resizedHeight} (${r.scaleFactor}x) before tiling`
          );
        }

        summaryLines.push(
          `Tiled ${result.sourceImage.width}x${result.sourceImage.height} image for ${config.label}`,
          `  ${result.grid.cols}x${result.grid.rows} grid, ${result.grid.totalTiles} tiles at ${result.grid.tileSize}px (~${result.grid.estimatedTokens.toLocaleString()} tokens)`,
          `  Saved to: ${result.outputDir}`,
        );

        if (previewPath) {
          summaryLines.push(`  Preview: ${previewPath}`);
        }

        if (warnings.length > 0) {
          summaryLines.push("", `⚠ ${warnings.join("\n⚠ ")}`);
        }

        // 4. Read tiles for requested page
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

        // Structured JSON
        const structuredOutput: Record<string, unknown> = {
          capture: {
            url: captureResult.url,
            pageWidth: captureResult.pageWidth,
            pageHeight: captureResult.pageHeight,
            segmentsStitched: captureResult.segmentsStitched ?? null,
            viewportWidth: resolvedViewport,
            waitUntil,
          },
          model,
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
        structuredOutput.allModels = allModels;
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
              text: `Error capturing and tiling URL: ${message}`,
            },
          ],
        };
      }
    }
  );
}
