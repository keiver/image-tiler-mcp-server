import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { getImageMetadata, computeEstimateForModel, tileImage, listTilesInDirectory, readTileAsBase64 } from "./image-processor.js";
import { generateInteractivePreview } from "./interactive-preview-generator.js";
import { analyzeTiles } from "./tile-analyzer.js";
import {
  MODEL_CONFIGS,
  VISION_MODELS,
  DEFAULT_MAX_DIMENSION,
  SUPPORTED_FORMATS,
  MAX_TILES_PER_BATCH,
} from "../constants.js";
import type { VisionModel, TileOutputFormat } from "../constants.js";
import {
  getDefaultOutputBase,
  getVersionedOutputDir,
  stripVersionSuffix,
  formatModelComparisonTable,
  simulateDownscale,
  buildTileHints,
  formatTileHintsSummary,
} from "../utils.js";
import type { ModelEstimate, TileImageResult, AnalysisResult, ImageSourceType } from "../types.js";

// ─── Output directory resolution ────────────────────────────────────────────

export async function resolveOutputDir(
  sourceType: ImageSourceType,
  localPath: string,
  explicitOutputDir?: string,
): Promise<string> {
  if (explicitOutputDir) return path.resolve(explicitOutputDir);
  if (sourceType === "file") {
    const basename = stripVersionSuffix(path.basename(localPath, path.extname(localPath)));
    const baseOutputDir = path.join(path.dirname(path.resolve(localPath)), "tiles", basename);
    return getVersionedOutputDir(baseOutputDir);
  }
  return path.join(getDefaultOutputBase(), "tiles", `tiled_${Date.now()}_${randomBytes(3).toString("hex")}`);
}

export function resolveOutputDirForCapture(explicitOutputDir?: string): string {
  if (explicitOutputDir) return path.resolve(explicitOutputDir);
  return path.join(getDefaultOutputBase(), "tiles", `capture_${Date.now()}_${randomBytes(3).toString("hex")}`);
}

// ─── Format validation ─────────────────────────────────────────────────────

export function validateFormat(localPath: string): string | null {
  const ext = path.extname(localPath).toLowerCase().replace(".", "");
  if (ext && !SUPPORTED_FORMATS.includes(ext as typeof SUPPORTED_FORMATS[number])) {
    return `Error: Unsupported image format '.${ext}'. Supported formats: ${SUPPORTED_FORMATS.join(", ")}`;
  }
  return null;
}

// ─── Tile size clamping ─────────────────────────────────────────────────────

export function clampTileSize(
  model: VisionModel,
  tileSize?: number,
): { effectiveTileSize: number; warnings: string[] } {
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

  return { effectiveTileSize, warnings };
}

// ─── Cheapest model selection ────────────────────────────────────────────────

export function findCheapestModel(allModels: ModelEstimate[]): VisionModel {
  let cheapest = allModels[0];
  for (const m of allModels) {
    if (m.tokens < cheapest.tokens) cheapest = m;
  }
  return cheapest.model as VisionModel;
}

// ─── Lightweight elicitation data (no preview, no file copy) ────────────────

export async function computeElicitationData(
  sourcePath: string,
  maxDimension: number,
): Promise<{ width: number; height: number; allModels: ModelEstimate[] }> {
  const imgMeta = await getImageMetadata(sourcePath);
  const effectiveMaxDim = maxDimension === 0 ? undefined : maxDimension;
  const allModels = VISION_MODELS.map((m) =>
    computeEstimateForModel(m, imgMeta.width, imgMeta.height, undefined, effectiveMaxDim)
  );
  return { width: imgMeta.width, height: imgMeta.height, allModels };
}

// ─── Preview gate ───────────────────────────────────────────────────────────

/**
 * Checks if a Phase 1 preview exists in outputDir.
 * When sourcePath is provided, only matches a preview tied to that source image.
 * This prevents stale previews from a different image skipping Phase 1.
 */
export async function checkPreviewGate(outputDir: string, sourcePath?: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(outputDir);
    if (sourcePath) {
      const baseName = path.basename(sourcePath, path.extname(sourcePath));
      const expected = `${baseName}-preview.html`;
      return entries.includes(expected) ? path.join(outputDir, expected) : null;
    }
    const preview = entries.find((e) => e.endsWith("-preview.html"));
    return preview ? path.join(outputDir, preview) : null;
  } catch {
    return null;
  }
}

// ─── Phase 1: Analyze & generate preview ────────────────────────────────────

export interface AnalyzeOptions {
  model?: VisionModel;
  maxDimension: number;
  tileSize?: number;
}

export async function analyzeAndPreview(
  sourcePath: string,
  outputDir: string,
  opts: AnalyzeOptions,
): Promise<AnalysisResult> {
  const imgMeta = await getImageMetadata(sourcePath);
  const effectiveMaxDim = opts.maxDimension === 0 ? undefined : opts.maxDimension;

  const allModels: ModelEstimate[] = VISION_MODELS.map((m) =>
    computeEstimateForModel(m, imgMeta.width, imgMeta.height, undefined, effectiveMaxDim)
  );

  // Compute post-downscale dimensions for preview and table
  const { width: effW, height: effH } = simulateDownscale(
    imgMeta.width, imgMeta.height, effectiveMaxDim ?? 0
  );
  const wasResized = effW !== imgMeta.width || effH !== imgMeta.height;

  // Ensure output dir exists for preview
  await fs.mkdir(outputDir, { recursive: true });

  // Copy source for non-local preview references
  let previewSourcePath = sourcePath;
  if (!sourcePath.startsWith(outputDir)) {
    const sourceExt = path.extname(sourcePath) || ".png";
    const copiedPath = path.join(outputDir, `source${sourceExt}`);
    try {
      await fs.copyFile(sourcePath, copiedPath);
      previewSourcePath = copiedPath;
    } catch {
      // Preview background may not work, but analysis still succeeds
    }
  }

  const recommendedModel = opts.model ?? findCheapestModel(allModels);

  const warnings: string[] = [];
  let previewPath: string | undefined;
  try {
    previewPath = await generateInteractivePreview(
      {
        sourceImagePath: previewSourcePath,
        effectiveWidth: effW,
        effectiveHeight: effH,
        originalWidth: imgMeta.width,
        originalHeight: imgMeta.height,
        maxDimension: opts.maxDimension || DEFAULT_MAX_DIMENSION,
        recommendedModel,
        models: allModels,
      },
      outputDir
    );
  } catch (previewError) {
    const msg = previewError instanceof Error ? previewError.message : String(previewError);
    warnings.push(`Preview generation failed: ${msg}`);
  }

  return {
    outputDir,
    previewPath,
    sourceImage: { width: imgMeta.width, height: imgMeta.height },
    ...(wasResized ? { effectiveImage: { width: effW, height: effH } } : {}),
    allModels,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ─── Phase 1 response builder ───────────────────────────────────────────────

export function buildPhase1Response(
  analysis: AnalysisResult,
  extraFields?: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const { sourceImage, effectiveImage, allModels, previewPath, outputDir, warnings } = analysis;

  const tableW = effectiveImage?.width ?? sourceImage.width;
  const tableH = effectiveImage?.height ?? sourceImage.height;
  const table = formatModelComparisonTable(sourceImage.width, sourceImage.height, allModels, tableW, tableH);

  const parts: string[] = [
    `ACTION REQUIRED: Present the tiling options below to the user and wait for their choice.\n` +
    `Do NOT pick a model yourself — always default to the cheapest if you must choose.\n` +
    `\n---\n\n`,
    table,
  ];
  if (previewPath) {
    parts.push(`\nPreview: ${previewPath}`);
  }
  parts.push(
    `\n\nAsk the user which preset they want (claude, openai, gemini3, or gemini).`
  );
  if (warnings && warnings.length > 0) {
    parts.push(`\n\n⚠ ${warnings.join("\n⚠ ")}`);
  }

  const structured: Record<string, unknown> = {
    status: "awaiting_user_choice",
    previewPath: previewPath ?? null,
    outputDir,
    allModels,
    ...extraFields,
  };
  if (warnings && warnings.length > 0) {
    structured.warnings = warnings;
  }

  return {
    content: [
      { type: "text" as const, text: parts.join("") },
      { type: "text" as const, text: JSON.stringify(structured, null, 2) },
    ],
  };
}

// ─── Phase 2: Execute tiling ────────────────────────────────────────────────

export interface ExecuteTilingOptions {
  model: VisionModel;
  tileSize?: number;
  maxDimension: number;
  format: TileOutputFormat;
  includeMetadata: boolean;
}

export async function executeTiling(
  sourcePath: string,
  outputDir: string,
  opts: ExecuteTilingOptions,
): Promise<{ result: TileImageResult; warnings: string[] }> {
  const { effectiveTileSize, warnings } = clampTileSize(opts.model, opts.tileSize);
  const config = MODEL_CONFIGS[opts.model];
  const effectiveMaxDim = opts.maxDimension === 0 ? undefined : opts.maxDimension;

  const result = await tileImage(
    sourcePath,
    effectiveTileSize,
    outputDir,
    config.tokensPerTile,
    effectiveMaxDim,
    config.maxTileSize,
    opts.format
  );

  const allWarnings = [...warnings, ...(result.warnings ?? [])];
  return { result, warnings: allWarnings };
}

// ─── Phase 2 response builder ───────────────────────────────────────────────

export interface Phase2ResponseOptions {
  model: VisionModel;
  includeMetadata: boolean;
  warnings: string[];
  /** maxDimension used for tiling (for accurate preview generation) */
  maxDimension: number;
  /** For capture-and-tile: extra capture info in structured output */
  captureInfo?: Record<string, unknown>;
  /** True when model was auto-selected (non-elicitation client) */
  autoSelected?: boolean;
  /** Source path for preview gate matching in Phase 2 */
  sourcePath?: string;
}

export async function buildPhase2Response(
  result: TileImageResult,
  opts: Phase2ResponseOptions,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const config = MODEL_CONFIGS[opts.model];
  const warnings = [...opts.warnings];

  // Compute all-model estimates using effective (post-resize) dimensions
  const allModels: ModelEstimate[] = VISION_MODELS.map((m) =>
    computeEstimateForModel(m, result.sourceImage.width, result.sourceImage.height)
  );

  // Generate preview for Phase 2 (if not already present)
  const existingPreview = await checkPreviewGate(result.outputDir, opts.sourcePath);
  let previewPath = existingPreview;

  if (!previewPath) {
    // Find source image for preview (look for source.* in outputDir, else use any image)
    let previewSourcePath: string | undefined;
    try {
      const entries = await fs.readdir(result.outputDir);
      const sourceFile = entries.find((e) => e.startsWith("source."));
      if (sourceFile) {
        previewSourcePath = path.join(result.outputDir, sourceFile);
      }
    } catch { /* ok */ }

    if (previewSourcePath) {
      try {
        previewPath = await generateInteractivePreview(
          {
            sourceImagePath: previewSourcePath,
            effectiveWidth: result.sourceImage.width,
            effectiveHeight: result.sourceImage.height,
            originalWidth: result.resize ? result.resize.originalWidth : result.sourceImage.width,
            originalHeight: result.resize ? result.resize.originalHeight : result.sourceImage.height,
            maxDimension: opts.maxDimension || DEFAULT_MAX_DIMENSION,
            recommendedModel: opts.model,
            models: allModels,
          },
          result.outputDir
        );
      } catch (previewError) {
        const msg = previewError instanceof Error ? previewError.message : String(previewError);
        warnings.push(`Preview generation failed: ${msg}`);
      }
    }
  }

  // Build summary
  const summaryLines: string[] = [];

  if (opts.autoSelected) {
    summaryLines.push(
      `Auto-selected ${config.label} preset (lowest token cost: ~${result.grid.estimatedTokens.toLocaleString()} tokens)`
    );
  }

  if (result.resize) {
    const r = result.resize;
    summaryLines.push(
      `Downscaled from ${r.originalWidth}×${r.originalHeight} → ${r.resizedWidth}×${r.resizedHeight} (${r.scaleFactor}x) before tiling`
    );
  }

  // Compute tile hints early so we can include the summary in text output
  let tileHints: Record<string, number[]> | undefined;
  if (opts.includeMetadata) {
    const tileMetadata = await analyzeTiles(result.tiles.map((t) => t.filePath));
    tileHints = buildTileHints(tileMetadata);
  }

  summaryLines.push(
    `Tiled ${result.sourceImage.width}x${result.sourceImage.height} image for ${config.label}`,
    `  ${result.grid.cols}x${result.grid.rows} grid, ${result.grid.totalTiles} tiles at ${result.grid.tileSize}px (~${result.grid.estimatedTokens.toLocaleString()} tokens)`,
  );

  if (tileHints) {
    const hintSummary = formatTileHintsSummary(tileHints);
    if (hintSummary) summaryLines.push(`  ${hintSummary}`);
  }

  summaryLines.push(`  Saved to: ${result.outputDir}`);

  if (previewPath) {
    summaryLines.push(`  Preview: ${previewPath}`);
  }

  if (opts.autoSelected) {
    const origW = result.resize?.originalWidth ?? result.sourceImage.width;
    const origH = result.resize?.originalHeight ?? result.sourceImage.height;
    const effW = result.resize ? result.sourceImage.width : undefined;
    const effH = result.resize ? result.sourceImage.height : undefined;
    const table = formatModelComparisonTable(origW, origH, allModels, effW, effH);
    summaryLines.push("", table);
    summaryLines.push(`\nTo use a different vision preset, specify model="claude" | "openai" | "gemini3" | "gemini"`);
  }

  if (warnings.length > 0) {
    summaryLines.push("", `⚠ ${warnings.join("\n⚠ ")}`);
  }

  // Structured output
  const structuredOutput: Record<string, unknown> = {
    ...(opts.captureInfo ? { capture: opts.captureInfo } : {}),
    model: opts.model,
    sourceImage: result.sourceImage,
    grid: result.grid,
    outputDir: result.outputDir,
  };

  if (opts.autoSelected) {
    structuredOutput.autoSelected = true;
    structuredOutput.allModels = allModels;
  }

  if (tileHints) {
    structuredOutput.tileHints = tileHints;
  }

  if (result.resize) structuredOutput.resize = result.resize;
  if (previewPath) structuredOutput.previewPath = previewPath;
  if (warnings.length > 0) structuredOutput.warnings = warnings;

  return {
    content: [
      { type: "text" as const, text: summaryLines.join("\n") },
      { type: "text" as const, text: JSON.stringify(structuredOutput, null, 2) },
    ],
  };
}

// ─── Tile pagination helper ─────────────────────────────────────────────

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export async function appendTilesPage(
  phase2Response: { content: Array<{ type: "text"; text: string }> },
  outputDir: string,
  page: number,
): Promise<{ content: ContentBlock[] }> {
  const tilePaths = await listTilesInDirectory(outputDir);
  const totalTiles = tilePaths.length;
  const start = page * MAX_TILES_PER_BATCH;
  const end = Math.min(start + MAX_TILES_PER_BATCH - 1, totalTiles - 1);
  const hasMore = end < totalTiles - 1;

  // Patch structured JSON to include page info
  const jsonBlock = phase2Response.content[1];
  const structuredOutput = JSON.parse(jsonBlock.text);
  structuredOutput.page = {
    current: page,
    tilesReturned: start <= end ? end - start + 1 : 0,
    totalTiles,
    hasMore,
  };
  jsonBlock.text = JSON.stringify(structuredOutput, null, 2);

  // Build hint map from structured output (if available)
  const hintMap = new Map<number, string>();
  if (structuredOutput.tileHints) {
    for (const [hint, indices] of Object.entries(structuredOutput.tileHints)) {
      for (const idx of indices as number[]) {
        hintMap.set(idx, hint);
      }
    }
  }

  const content: ContentBlock[] = [...phase2Response.content];

  if (start < totalTiles) {
    for (let i = start; i <= end; i++) {
      const tilePath = tilePaths[i];
      const filename = path.basename(tilePath);
      const match = filename.match(/tile_(\d+)_(\d+)\.(png|webp)/);
      const row = match ? parseInt(match[1], 10) : -1;
      const col = match ? parseInt(match[2], 10) : -1;
      const mimeType = path.extname(tilePath) === ".webp" ? "image/webp" : "image/png";

      const hint = hintMap.get(i);
      const hintSuffix = hint ? ` (${hint})` : "";
      content.push({ type: "text" as const, text: `Tile ${i + 1}/${totalTiles} [index ${i}, row ${row}, col ${col}]${hintSuffix}` });
      const base64Data = await readTileAsBase64(tilePath);
      content.push({ type: "image" as const, data: base64Data, mimeType });
    }
  }

  return { content };
}
