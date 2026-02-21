import * as fs from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TilerInputSchema } from "../schemas/index.js";
import { resolveImageSource } from "../services/image-source-resolver.js";
import { captureUrl } from "../services/url-capture.js";
import {
  listTilesInDirectory,
  readTileAsBase64,
} from "../services/image-processor.js";
import {
  resolveOutputDir,
  resolveOutputDirForCapture,
  validateFormat,
  checkPreviewGate,
  analyzeAndPreview,
  buildPhase1Response,
  executeTiling,
  buildPhase2Response,
  appendTilesPage,
  findCheapestModel,
  computeElicitationData,
} from "../services/tiling-pipeline.js";
import { tryElicitation } from "../services/elicitation.js";
import { sanitizeHostname, buildTileHints, withTimeout } from "../utils.js";
import { analyzeTiles } from "../services/tile-analyzer.js";
import type { ResolvedImageSource } from "../types.js";
import {
  PNG_COMPRESSION_LEVEL,
  VISION_MODELS,
  MODEL_CONFIGS,
  MAX_TILES_PER_BATCH,
  CAPTURE_DEFAULT_VIEWPORT_WIDTH,
  SHARP_OPERATION_TIMEOUT_MS,
} from "../constants.js";

const modelLines = VISION_MODELS.map((m) => {
  const c = MODEL_CONFIGS[m];
  return `  - "${m}": ${c.defaultTileSize}px tiles, ~${c.tokensPerTile} tokens/tile`;
}).join("\n");

const TILER_DESCRIPTION = `Split images into optimally-sized tiles for LLM vision analysis, or capture web page screenshots and tile them.

MANDATORY two-phase workflow — DO NOT skip Phase 1:

  Phase 1 (REQUIRED first): Provide ONLY the image source (filePath, sourceUrl, url, etc).
           DO NOT include preset, tileSize, or outputDir.
           Returns a model comparison table with token estimates and an outputDir.
           You MUST present this table to the user and ask which preset they prefer.
           DO NOT select a preset yourself — the user decides. If you must auto-select, always use the cheapest option.

  Phase 2: Call again with the user's chosen preset + the outputDir from Phase 1.
           Re-include your original image source (filePath, sourceUrl, etc.).
           For captures, use screenshotPath from Phase 1 instead of url.
           Returns tiled images inline (${MAX_TILES_PER_BATCH} per page).

To retrieve more tiles after Phase 2, call with tilesDir + start/end for pagination.

Stop after Phase 1 if you only need the screenshot (capture mode) or comparison data.

${VISION_MODELS.length} tiling presets available:
${modelLines}

Supports: local files (filePath), remote images (sourceUrl), data URLs, base64, and web page capture (url — Chrome required).
Tiles saved as WebP (default) or PNG. Auto-downscales images over 10000px by default.`;

export function registerTilerTool(server: McpServer): void {
  server.registerTool(
    "tiler",
    {
      title: "Image Tiler for LLM Vision",
      description: TILER_DESCRIPTION,
      inputSchema: TilerInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      // Image source
      filePath, sourceUrl, dataUrl, imageBase64,
      // Capture
      url, viewportWidth, waitUntil, delay, screenshotPath: existingScreenshotPath,
      // Tile retrieval
      tilesDir, start, end,
      // Tiling config
      preset: explicitPreset, model: deprecatedModel, tileSize, maxDimension, outputDir, page, format, includeMetadata,
    }) => {
      // Resolve preset vs deprecated model param
      const explicitModel = explicitPreset ?? deprecatedModel;
      const deprecationWarnings: string[] = [];
      if (deprecatedModel && !explicitPreset) {
        deprecationWarnings.push('The "model" parameter is deprecated. Use "preset" instead.');
      }
      // ── Mode: get-tiles (read-only pagination) ──
      if (tilesDir) {
        // Support `page` param for get-tiles mode: convert page to start/end
        // when start is at default (0) and end is not specified
        let effectiveStart = start;
        let effectiveEnd = end;
        if (page > 0 && start === 0 && end === undefined) {
          effectiveStart = page * MAX_TILES_PER_BATCH;
          effectiveEnd = effectiveStart + MAX_TILES_PER_BATCH - 1;
        }
        return handleGetTiles(tilesDir, effectiveStart, effectiveEnd);
      }

      // ── Mode: capture-and-tile ──
      if (url || existingScreenshotPath) {
        return handleCaptureAndTile(server, {
          url, viewportWidth, waitUntil, delay,
          existingScreenshotPath,
          explicitModel, tileSize, maxDimension, outputDir, page, format, includeMetadata,
          deprecationWarnings,
        });
      }

      // ── Mode: tile-image ──
      if (filePath || sourceUrl || dataUrl || imageBase64) {
        // Issue #9: Warn when multiple source params conflict
        const sourceCount = [filePath, sourceUrl, dataUrl, imageBase64].filter(Boolean).length;
        const sourceWarning = sourceCount > 1
          ? `Warning: Multiple image sources provided. Using ${filePath ? "filePath" : sourceUrl ? "sourceUrl" : dataUrl ? "dataUrl" : "imageBase64"} (precedence: filePath > sourceUrl > dataUrl > imageBase64).`
          : undefined;

        return handleTileImage(server, {
          filePath, sourceUrl, dataUrl, imageBase64,
          explicitModel, tileSize, maxDimension, outputDir, page, format, includeMetadata,
          sourceWarning, deprecationWarnings,
        });
      }

      // ── Phase 2 attempt without image source ──
      if (outputDir || explicitModel) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "Error: Phase 2 requires an image source. Re-include your original image source (filePath, sourceUrl, etc.) along with preset and outputDir. For captures, use screenshotPath from Phase 1.",
          }],
        };
      }

      // ── No input ──
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: "Error: No input provided. Supply one of: filePath, sourceUrl, dataUrl, imageBase64 (to tile an image), url (to capture a web page), or tilesDir (to retrieve existing tiles).",
        }],
      };
    }
  );
}

// ─── Get Tiles Handler ─────────────────────────────────────────────────────

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

async function handleGetTiles(
  tilesDir: string,
  start: number,
  end: number | undefined,
): Promise<{ content: ContentBlock[]; isError?: boolean }> {
  try {
    if (end !== undefined && end < start) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `Error: end index (${end}) must be >= start index (${start}).`,
        }],
      };
    }

    const tilePaths = await listTilesInDirectory(tilesDir);
    const totalTiles = tilePaths.length;

    const effectiveEnd = Math.min(
      end !== undefined ? end : start + MAX_TILES_PER_BATCH - 1,
      totalTiles - 1
    );

    if (start >= totalTiles) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `Error: Start index ${start} is out of range. Total tiles: ${totalTiles} (valid range: 0-${totalTiles - 1}).`,
        }],
      };
    }

    if (effectiveEnd - start + 1 > MAX_TILES_PER_BATCH) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `Error: Requested ${effectiveEnd - start + 1} tiles but max batch size is ${MAX_TILES_PER_BATCH}. Use start=${start}, end=${start + MAX_TILES_PER_BATCH - 1} instead.`,
        }],
      };
    }

    const content: ContentBlock[] = [];
    const summary = `Tiles ${start + 1}-${effectiveEnd + 1} of ${totalTiles}`;
    content.push({ type: "text" as const, text: summary });

    // Analyze current batch for content hints
    const hintMap = new Map<number, string>();
    try {
      const batchPaths = tilePaths.slice(start, effectiveEnd + 1);
      const metadata = await analyzeTiles(batchPaths);
      const hints = buildTileHints(metadata);
      for (const [hint, indices] of Object.entries(hints)) {
        for (const localIdx of indices) {
          hintMap.set(start + localIdx, hint);
        }
      }
    } catch { /* analysis failed — skip annotations */ }

    for (let i = start; i <= effectiveEnd; i++) {
      const tilePath = tilePaths[i];
      const filename = path.basename(tilePath);
      const match = filename.match(/tile_(\d+)_(\d+)\.(png|webp)/);
      const row = match ? parseInt(match[1], 10) : -1;
      const col = match ? parseInt(match[2], 10) : -1;
      const mimeType = path.extname(tilePath) === ".webp" ? "image/webp" : "image/png";

      const hint = hintMap.get(i);
      const hintSuffix = hint ? ` (${hint})` : "";
      content.push({
        type: "text" as const,
        text: `Tile ${i + 1}/${totalTiles} [index ${i}, row ${row}, col ${col}]${hintSuffix}`,
      });

      const base64Data = await readTileAsBase64(tilePath);
      content.push({
        type: "image" as const,
        data: base64Data,
        mimeType,
      });
    }

    return { content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: `Error retrieving tiles: ${message}`,
      }],
    };
  }
}

// ─── Tile Image Handler ────────────────────────────────────────────────────

interface TileImageParams {
  filePath?: string;
  sourceUrl?: string;
  dataUrl?: string;
  imageBase64?: string;
  explicitModel?: typeof VISION_MODELS[number];
  tileSize?: number;
  maxDimension: number;
  outputDir?: string;
  page: number;
  format: "webp" | "png";
  includeMetadata: boolean;
  sourceWarning?: string;
  deprecationWarnings: string[];
}

async function handleTileImage(
  server: McpServer,
  params: TileImageParams,
): Promise<{ content: ContentBlock[]; isError?: boolean }> {
  const { filePath, sourceUrl, dataUrl, imageBase64, explicitModel, tileSize, maxDimension, outputDir, page, format, includeMetadata, sourceWarning, deprecationWarnings } = params;

  let source: ResolvedImageSource | undefined;
  let response: { content: ContentBlock[]; isError?: boolean } | undefined;

  try {
    source = await resolveImageSource({ filePath, sourceUrl, dataUrl, imageBase64 });

    const formatError = validateFormat(source.localPath);
    if (formatError) {
      response = { isError: true, content: [{ type: "text" as const, text: formatError }] };
      return response;
    }

    const resolvedOutputDir = await resolveOutputDir(source.sourceType, source.localPath, outputDir);

    // Phase 1 copies any source outside outputDir to "source.{ext}" in outputDir,
    // so the preview becomes "source-preview.html". Use that stable name for lookup.
    const previewLookupPath = source.localPath.startsWith(resolvedOutputDir)
      ? source.localPath
      : path.join(resolvedOutputDir, `source${path.extname(source.localPath) || ".png"}`);

    // Preview gate: if preview exists for THIS source, skip straight to Phase 2
    const existingPreview = await checkPreviewGate(resolvedOutputDir, previewLookupPath);
    if (existingPreview) {
      if (explicitModel) {
        const { result, warnings } = await executeTiling(source.localPath, resolvedOutputDir, {
          model: explicitModel, tileSize, maxDimension, format, includeMetadata,
        });
        warnings.push(...deprecationWarnings);
        if (sourceWarning) warnings.push(sourceWarning);
        const phase2 = await buildPhase2Response(result, { model: explicitModel, includeMetadata, warnings, maxDimension, sourcePath: previewLookupPath });
        response = await appendTilesPage(phase2, result.outputDir, page);
        return response;
      }

      // No explicit model — try elicitation, fall back to cheapest
      const elicitData = await computeElicitationData(source.localPath, maxDimension);
      const cheapest = findCheapestModel(elicitData.allModels);
      const elicitResult = await tryElicitation(server, { ...elicitData, model: cheapest });

      // User explicitly cancelled — abort
      if (elicitResult.status === "cancelled") {
        response = {
          content: [{ type: "text" as const, text: "Tiling cancelled by user." }],
        };
        return response;
      }

      const finalModel = elicitResult.status === "selected" ? elicitResult.model : cheapest;
      const autoSelected = elicitResult.status === "unsupported";

      const { result, warnings } = await executeTiling(source.localPath, resolvedOutputDir, {
        model: finalModel, tileSize, maxDimension, format, includeMetadata,
      });
      warnings.push(...deprecationWarnings);
      if (sourceWarning) warnings.push(sourceWarning);
      const phase2 = await buildPhase2Response(result, {
        model: finalModel, includeMetadata, warnings, maxDimension, autoSelected, sourcePath: previewLookupPath,
      });
      response = await appendTilesPage(phase2, result.outputDir, page);
      return response;
    }

    // One-shot: user provided model + outputDir upfront — generate preview then tile immediately
    if (explicitModel && outputDir) {
      await analyzeAndPreview(source.localPath, resolvedOutputDir, {
        model: explicitModel, maxDimension, tileSize,
      });
      const { result, warnings } = await executeTiling(source.localPath, resolvedOutputDir, {
        model: explicitModel, tileSize, maxDimension, format, includeMetadata,
      });
      warnings.push(...deprecationWarnings);
      if (sourceWarning) warnings.push(sourceWarning);
      const phase2 = await buildPhase2Response(result, {
        model: explicitModel, includeMetadata, warnings, maxDimension, sourcePath: previewLookupPath,
      });
      response = await appendTilesPage(phase2, result.outputDir, page);
      return response;
    }

    // Phase 1: analyze and generate preview
    const analysis = await analyzeAndPreview(source.localPath, resolvedOutputDir, {
      model: explicitModel, maxDimension, tileSize,
    });
    const cheapest = findCheapestModel(analysis.allModels);

    // Try elicitation fast path
    const elicitResult = await tryElicitation(server, {
      width: analysis.sourceImage.width,
      height: analysis.sourceImage.height,
      model: explicitModel ?? cheapest,
      allModels: analysis.allModels,
    });

    // User explicitly cancelled — abort
    if (elicitResult.status === "cancelled") {
      response = {
        content: [{ type: "text" as const, text: "Tiling cancelled by user." }],
      };
      return response;
    }

    if (elicitResult.status !== "selected") {
      const phase1 = buildPhase1Response(analysis);
      const prependWarnings = [...deprecationWarnings, ...(sourceWarning ? [sourceWarning] : [])];
      if (prependWarnings.length > 0) {
        phase1.content[0].text = prependWarnings.map(w => `⚠ ${w}`).join("\n") + "\n\n" + phase1.content[0].text;
      }
      response = phase1;
      return response;
    }

    // Elicitation returned a model — proceed to tile
    const { result, warnings } = await executeTiling(source.localPath, resolvedOutputDir, {
      model: elicitResult.model, tileSize, maxDimension, format, includeMetadata,
    });
    warnings.push(...deprecationWarnings);
    if (sourceWarning) warnings.push(sourceWarning);

    const phase2 = await buildPhase2Response(result, { model: elicitResult.model, includeMetadata, warnings, maxDimension, sourcePath: previewLookupPath });
    response = await appendTilesPage(phase2, result.outputDir, page);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    response = { isError: true, content: [{ type: "text" as const, text: `Error tiling image: ${message}` }] };
    return response;
  } finally {
    const cleanupWarning = await source?.cleanup?.();
    if (cleanupWarning && response && !response.isError) {
      response.content.push({ type: "text" as const, text: `\n⚠ ${cleanupWarning}` });
    }
  }
}

// ─── Capture and Tile Handler ──────────────────────────────────────────────

interface CaptureAndTileParams {
  url?: string;
  viewportWidth?: number;
  waitUntil: "load" | "networkidle" | "domcontentloaded";
  delay: number;
  existingScreenshotPath?: string;
  explicitModel?: typeof VISION_MODELS[number];
  tileSize?: number;
  maxDimension: number;
  outputDir?: string;
  page: number;
  format: "webp" | "png";
  includeMetadata: boolean;
  deprecationWarnings: string[];
}

async function handleCaptureAndTile(
  server: McpServer,
  params: CaptureAndTileParams,
): Promise<{ content: ContentBlock[]; isError?: boolean }> {
  const {
    url, viewportWidth, waitUntil, delay,
    existingScreenshotPath,
    explicitModel, tileSize, maxDimension, outputDir, page, format, includeMetadata,
    deprecationWarnings,
  } = params;

  const resolvedOutputDir = resolveOutputDirForCapture(outputDir);

  try {
    await fs.mkdir(resolvedOutputDir, { recursive: true });

    // 1. Capture or reuse screenshot
    let screenshotPath: string;
    let captureWidth: number;
    let captureHeight: number;
    let segmentsStitched: number | undefined;
    let capturedUrl = url;

    if (existingScreenshotPath) {
      // Check file existence and readability separately for distinct error messages
      let fileExists = false;
      try {
        await fs.access(existingScreenshotPath);
        fileExists = true;
      } catch {
        // File not found
      }

      if (fileExists) {
        try {
          const meta = await withTimeout(sharp(existingScreenshotPath).metadata(), SHARP_OPERATION_TIMEOUT_MS, "screenshot-metadata");
          if (!meta.width || !meta.height) {
            throw new Error(`invalid dimensions (${meta.width ?? 0}x${meta.height ?? 0})`);
          }
          screenshotPath = existingScreenshotPath;
          captureWidth = meta.width;
          captureHeight = meta.height;
        } catch (metaError) {
          // File exists but can't be read by Sharp (corrupt/truncated/wrong format)
          if (!url) {
            throw new Error(
              `Screenshot at ${existingScreenshotPath} exists but could not be read: ${metaError instanceof Error ? metaError.message : String(metaError)}`
            );
          }
          // Recapture from URL
          const resolvedViewport = viewportWidth ?? CAPTURE_DEFAULT_VIEWPORT_WIDTH;
          const captureResult = await captureUrl({ url, viewportWidth: resolvedViewport, waitUntil, delay });
          captureWidth = captureResult.pageWidth;
          captureHeight = captureResult.pageHeight;
          segmentsStitched = captureResult.segmentsStitched;
          capturedUrl = captureResult.url;

          const baseName = sanitizeHostname(url);
          screenshotPath = path.join(resolvedOutputDir, `${baseName}.png`);
          await sharp(captureResult.buffer).png({ compressionLevel: PNG_COMPRESSION_LEVEL }).toFile(screenshotPath);
        }
      } else {
        // File doesn't exist — need URL for recapture
        if (!url) {
          throw new Error(`Screenshot not found at ${existingScreenshotPath} and no url provided for recapture.`);
        }
        const resolvedViewport = viewportWidth ?? CAPTURE_DEFAULT_VIEWPORT_WIDTH;
        const captureResult = await captureUrl({ url, viewportWidth: resolvedViewport, waitUntil, delay });
        captureWidth = captureResult.pageWidth;
        captureHeight = captureResult.pageHeight;
        segmentsStitched = captureResult.segmentsStitched;
        capturedUrl = captureResult.url;

        const baseName = sanitizeHostname(url);
        screenshotPath = path.join(resolvedOutputDir, `${baseName}.png`);
        await sharp(captureResult.buffer).png({ compressionLevel: PNG_COMPRESSION_LEVEL }).toFile(screenshotPath);
      }
    } else {
      // No existingScreenshotPath — mode detection guarantees url is defined
      const resolvedViewport = viewportWidth ?? CAPTURE_DEFAULT_VIEWPORT_WIDTH;
      const captureResult = await captureUrl({ url: url!, viewportWidth: resolvedViewport, waitUntil, delay });
      captureWidth = captureResult.pageWidth;
      captureHeight = captureResult.pageHeight;
      segmentsStitched = captureResult.segmentsStitched;
      capturedUrl = captureResult.url;

      const baseName = sanitizeHostname(url!);
      screenshotPath = path.join(resolvedOutputDir, `${baseName}.png`);
      await sharp(captureResult.buffer).png({ compressionLevel: PNG_COMPRESSION_LEVEL }).toFile(screenshotPath);
    }

    // 2. Preview gate: if preview exists for THIS screenshot, skip straight to Phase 2
    const existingPreview = await checkPreviewGate(resolvedOutputDir, screenshotPath);
    if (existingPreview) {
      const captureInfo = {
        url: capturedUrl,
        pageWidth: captureWidth,
        pageHeight: captureHeight,
        segmentsStitched: segmentsStitched ?? null,
        viewportWidth: viewportWidth ?? CAPTURE_DEFAULT_VIEWPORT_WIDTH,
        waitUntil,
      };

      let finalModel = explicitModel;
      let autoSelected = false;
      if (!finalModel) {
        const elicitData = await computeElicitationData(screenshotPath, maxDimension);
        const cheapest = findCheapestModel(elicitData.allModels);
        const elicitResult = await tryElicitation(server, { ...elicitData, model: cheapest });

        if (elicitResult.status === "cancelled") {
          return {
            content: [{ type: "text" as const, text: "Tiling cancelled by user." }],
          };
        }

        finalModel = elicitResult.status === "selected" ? elicitResult.model : cheapest;
        autoSelected = elicitResult.status === "unsupported";
      }

      // finalModel is guaranteed set: either explicitModel was truthy, or we assigned in the block above (or returned on cancel)
      const tilingModel = finalModel!;
      const { result, warnings } = await executeTiling(screenshotPath, resolvedOutputDir, {
        model: tilingModel, tileSize, maxDimension, format, includeMetadata,
      });
      warnings.push(...deprecationWarnings);

      const phase2 = await buildPhase2Response(result, { model: tilingModel, includeMetadata, warnings, maxDimension, captureInfo, autoSelected, sourcePath: screenshotPath });
      const urlSuffix = capturedUrl ? ` of ${capturedUrl}` : "";
      const captureLine = `Captured ${captureWidth}x${captureHeight} screenshot${urlSuffix}${segmentsStitched ? `\n  Scroll-stitched ${segmentsStitched} segments` : ""}\n`;
      phase2.content[0].text = captureLine + phase2.content[0].text;

      return appendTilesPage(phase2, result.outputDir, page);
    }

    // One-shot: user provided model + outputDir upfront — generate preview then tile immediately
    if (explicitModel && outputDir) {
      await analyzeAndPreview(screenshotPath, resolvedOutputDir, {
        model: explicitModel, maxDimension, tileSize,
      });
      const captureInfo = {
        url: capturedUrl,
        pageWidth: captureWidth,
        pageHeight: captureHeight,
        segmentsStitched: segmentsStitched ?? null,
        viewportWidth: viewportWidth ?? CAPTURE_DEFAULT_VIEWPORT_WIDTH,
        waitUntil,
      };
      const { result, warnings } = await executeTiling(screenshotPath, resolvedOutputDir, {
        model: explicitModel, tileSize, maxDimension, format, includeMetadata,
      });
      warnings.push(...deprecationWarnings);
      const phase2 = await buildPhase2Response(result, {
        model: explicitModel, includeMetadata, warnings, maxDimension, captureInfo, sourcePath: screenshotPath,
      });
      const urlSuffix = capturedUrl ? ` of ${capturedUrl}` : "";
      const captureLine = `Captured ${captureWidth}x${captureHeight} screenshot${urlSuffix}${segmentsStitched ? `\n  Scroll-stitched ${segmentsStitched} segments` : ""}\n`;
      phase2.content[0].text = captureLine + phase2.content[0].text;
      return appendTilesPage(phase2, result.outputDir, page);
    }

    // 3. Phase 1: analyze and generate preview
    const analysis = await analyzeAndPreview(screenshotPath, resolvedOutputDir, {
      model: explicitModel, maxDimension, tileSize,
    });
    const cheapest = findCheapestModel(analysis.allModels);

    // Try elicitation fast path
    const elicitResult = await tryElicitation(server, {
      width: analysis.sourceImage.width,
      height: analysis.sourceImage.height,
      model: explicitModel ?? cheapest,
      allModels: analysis.allModels,
    });

    // User explicitly cancelled — abort
    if (elicitResult.status === "cancelled") {
      return {
        content: [{ type: "text" as const, text: "Tiling cancelled by user." }],
      };
    }

    if (elicitResult.status !== "selected") {
      // Phase 1: return comparison + screenshot path
      const phase1 = buildPhase1Response(analysis, { screenshotPath });
      if (deprecationWarnings.length > 0) {
        phase1.content[0].text = deprecationWarnings.map(w => `⚠ ${w}`).join("\n") + "\n\n" + phase1.content[0].text;
      }
      phase1.content[0].text += `\n\n(Screenshot: ${captureWidth}x${captureHeight}${url ? ` of ${url}` : ""}, saved to ${screenshotPath})`;
      return phase1;
    }

    // 4. Elicitation returned a model — proceed to tile + read tiles
    const captureInfo = {
      url: capturedUrl,
      pageWidth: captureWidth,
      pageHeight: captureHeight,
      segmentsStitched: segmentsStitched ?? null,
      viewportWidth: viewportWidth ?? CAPTURE_DEFAULT_VIEWPORT_WIDTH,
      waitUntil,
    };

    const { result, warnings } = await executeTiling(screenshotPath, resolvedOutputDir, {
      model: elicitResult.model, tileSize, maxDimension, format, includeMetadata,
    });
    warnings.push(...deprecationWarnings);

    const phase2 = await buildPhase2Response(result, { model: elicitResult.model, includeMetadata, warnings, maxDimension, captureInfo, sourcePath: screenshotPath });

    const captureLine = `Captured ${captureWidth}x${captureHeight} screenshot${url ? ` of ${url}` : ""}${segmentsStitched ? `\n  Scroll-stitched ${segmentsStitched} segments` : ""}\n`;
    phase2.content[0].text = captureLine + phase2.content[0].text;

    return appendTilesPage(phase2, result.outputDir, page);
  } catch (error) {
    // Clean up empty output directory created before capture
    try { await fs.rmdir(resolvedOutputDir); } catch { /* not empty or already gone */ }

    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text" as const, text: `Error capturing and tiling URL: ${message}` }] };
  }
}
