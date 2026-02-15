import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RecommendSettingsInputSchema } from "../schemas/index.js";
import { resolveImageSource } from "../services/image-source-resolver.js";
import { getImageMetadata, calculateGrid, computeEstimateForModel } from "../services/image-processor.js";
import { generateInteractivePreview } from "../services/interactive-preview-generator.js";
import {
  VISION_MODELS,
  MODEL_CONFIGS,
  DEFAULT_MODEL,
  DEFAULT_MAX_DIMENSION,
  SUPPORTED_FORMATS,
} from "../constants.js";
import type { ImageIntent, BudgetLevel } from "../constants.js";
import type { ModelEstimate, RecommendationResult } from "../types.js";

function applyHeuristics(
  model: string,
  explicitTileSize: number | undefined,
  explicitMaxDimension: number | undefined,
  intent: ImageIntent | undefined,
  budget: BudgetLevel | undefined,
  aspectRatio: number
): { tileSize: number; maxDimension: number; rationale: string[] } {
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  const rationale: string[] = [];

  let tileSize = explicitTileSize ?? config.defaultTileSize;
  let maxDimension = explicitMaxDimension ?? DEFAULT_MAX_DIMENSION;

  // Clamp tile size to model bounds
  if (tileSize > config.maxTileSize) {
    tileSize = config.maxTileSize;
  }
  if (tileSize < config.minTileSize) {
    tileSize = config.minTileSize;
  }

  // Intent adjustments (only if no explicit maxDimension override)
  if (explicitMaxDimension === undefined && intent) {
    if (intent === "text_heavy" && aspectRatio > 2.5) {
      const capped = Math.min(maxDimension, 6000);
      if (capped < maxDimension) {
        rationale.push(
          `Tall text-heavy image (aspect ratio ${aspectRatio.toFixed(1)}): reduced maxDimension to ${capped}px to save tokens while preserving readability`
        );
        maxDimension = capped;
      }
    } else if (intent === "diagram" && explicitTileSize === undefined) {
      const larger = Math.min(Math.round(config.defaultTileSize * 1.3), config.maxTileSize);
      if (larger > tileSize) {
        rationale.push(
          `Diagram image: increased tile size to ${larger}px for better detail per tile`
        );
        tileSize = larger;
      }
    }
  }

  // Budget adjustments (stacks on intent)
  if (explicitMaxDimension === undefined && budget) {
    if (budget === "low") {
      const reduced = Math.round(maxDimension * 0.6);
      rationale.push(`Low budget: reduced maxDimension to ${reduced}px`);
      maxDimension = reduced;
    } else if (budget === "max_detail") {
      const increased = Math.max(maxDimension, 15000);
      if (increased > maxDimension) {
        rationale.push(`Max detail: increased maxDimension to ${increased}px`);
        maxDimension = increased;
      }
    }
  }

  if (rationale.length === 0) {
    rationale.push("Using default settings — no heuristic adjustments applied");
  }

  return { tileSize, maxDimension, rationale };
}

const modelList = VISION_MODELS.map((m) => `"${m}"`).join(", ");

const RECOMMEND_DESCRIPTION = `IMPORTANT: Always call this tool FIRST before tiling any image. This is the mandatory first step in the tiling workflow.

Workflow:
  1. Call tiler_recommend_settings with the image → get cost estimates for all tiling presets
  2. Present the allModels comparison to the user and wait for them to choose a preset and confirm the tile count before proceeding
  3. Only after user confirmation, call tiler_tile_image or tiler_prepare_image with the confirmed settings

Reads image dimensions and returns cost estimates WITHOUT creating any tiles. Each "model" entry in the response is a tiling preset (tile size + token cost) optimized for a specific vision pipeline — it does NOT switch which LLM processes the tiles. Your current LLM is always the one that will analyze the output. Pick the preset that matches your LLM's vision pipeline.

Inputs: At least one image source (filePath, sourceUrl, dataUrl, or imageBase64). Optional: model, tileSize, maxDimension, intent, budget.
Works with any image source including screenshots from tiler_capture_url.

Supported formats: ${SUPPORTED_FORMATS.join(", ")}

Intent hints: "text_heavy" (tall docs/scrollshots), "ui_screenshot", "diagram", "photo", "general"
Budget: "low" (fewer tokens), "default", "max_detail" (preserve all detail)

Returns JSON with:
  - recommended: { model, tileSize, maxDimension }
  - rationale: why these settings were chosen
  - imageInfo: { width, height, megapixels, aspectRatio }
  - estimate: { gridCols, gridRows, totalTiles, estimatedTokens }
  - allModels: comparison across all ${VISION_MODELS.length} tiling presets (${modelList})
  - previewPath: path to an interactive HTML preview with preset-switching tabs
  - warnings: any issues detected`;

export function registerRecommendSettingsTool(server: McpServer): void {
  server.registerTool(
    "tiler_recommend_settings",
    {
      title: "Recommend Tiling Settings",
      description: RECOMMEND_DESCRIPTION,
      inputSchema: RecommendSettingsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ filePath, sourceUrl, dataUrl, imageBase64, model, tileSize, maxDimension, intent, budget }) => {
      const source = await resolveImageSource({ filePath, sourceUrl, dataUrl, imageBase64 });
      try {
        const metadata = await getImageMetadata(source.localPath);
        const warnings: string[] = [];

        const effectiveModel = model ?? DEFAULT_MODEL;
        const aspectRatio = Math.max(metadata.width, metadata.height) / Math.min(metadata.width, metadata.height);

        const { tileSize: recTileSize, maxDimension: recMaxDim, rationale } = applyHeuristics(
          effectiveModel,
          tileSize,
          maxDimension,
          intent as ImageIntent | undefined,
          budget as BudgetLevel | undefined,
          aspectRatio
        );

        // All-model comparison (each using its own defaults, but same maxDimension)
        const allModels: ModelEstimate[] = VISION_MODELS.map((m) =>
          computeEstimateForModel(m, metadata.width, metadata.height, undefined, recMaxDim)
        );

        // Simulate downscale for grid calculation
        let simW = metadata.width;
        let simH = metadata.height;
        if (recMaxDim > 0) {
          const longestSide = Math.max(simW, simH);
          if (longestSide > recMaxDim) {
            const scale = recMaxDim / longestSide;
            simW = Math.round(simW * scale);
            simH = Math.round(simH * scale);
          }
        }
        const recConfig = MODEL_CONFIGS[effectiveModel as keyof typeof MODEL_CONFIGS];
        const grid = calculateGrid(simW, simH, recTileSize, recConfig.tokensPerTile, recConfig.maxTileSize);

        // Generate interactive preview
        let previewPath: string | undefined;
        try {
          let previewOutputDir: string;
          let previewSourcePath: string;

          if (source.sourceType === "file") {
            previewOutputDir = path.dirname(path.resolve(source.localPath));
            previewSourcePath = source.localPath;
          } else {
            previewOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), "tiler-recommend-"));
            // Copy source to output dir so preview.html can reference it
            const sourceExt = path.extname(source.localPath) || ".png";
            const copiedPath = path.join(previewOutputDir, `source${sourceExt}`);
            await fs.copyFile(source.localPath, copiedPath);
            previewSourcePath = copiedPath;
          }

          previewPath = await generateInteractivePreview(
            {
              sourceImagePath: previewSourcePath,
              effectiveWidth: simW,
              effectiveHeight: simH,
              originalWidth: metadata.width,
              originalHeight: metadata.height,
              maxDimension: recMaxDim,
              recommendedModel: effectiveModel,
              models: allModels,
            },
            previewOutputDir
          );
        } catch (previewError) {
          const msg = previewError instanceof Error ? previewError.message : String(previewError);
          warnings.push(`Preview generation failed: ${msg}`);
        }

        const result: RecommendationResult = {
          recommended: {
            model: effectiveModel,
            tileSize: recTileSize,
            maxDimension: recMaxDim,
          },
          rationale,
          imageInfo: {
            width: metadata.width,
            height: metadata.height,
            megapixels: Math.round((metadata.width * metadata.height) / 10000) / 100,
            aspectRatio: Math.round(aspectRatio * 1000) / 1000,
          },
          estimate: {
            gridCols: grid.cols,
            gridRows: grid.rows,
            totalTiles: grid.totalTiles,
            estimatedTokens: grid.estimatedTokens,
          },
          allModels,
          warnings,
          previewPath,
        };

        const content: Array<{ type: "text"; text: string }> = [];

        if (previewPath) {
          content.push({
            type: "text" as const,
            text: `Preview: ${previewPath}`,
          });
        }

        content.push({
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        });

        return { content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error analyzing image: ${message}`,
            },
          ],
        };
      } finally {
        await source.cleanup?.();
      }
    }
  );
}
