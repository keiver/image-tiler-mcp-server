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
  findCheapestModel,
  computeElicitationData,
} from "../services/tiling-pipeline.js";
import { tryElicitation } from "../services/elicitation.js";
import { assertSafePath } from "../security.js";
import { sanitizeHostname, withTimeout } from "../utils.js";
import { analyzeTiles } from "../services/tile-analyzer.js";
import type { ResolvedImageSource, TileMetadata } from "../types.js";
import {
  PNG_COMPRESSION_LEVEL,
  VISION_MODELS,
  MODEL_CONFIGS,
  MAX_TILES_PER_BATCH,
  CAPTURE_DEFAULT_VIEWPORT_WIDTH,
  CAPTURE_MOBILE_VIEWPORT_WIDTH,
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
           Returns tile summary with metadata and content hints (no tile images).
           Use tilesDir + start/end to fetch only the tiles you need.

Stop after Phase 1 if you only need the screenshot (capture mode) or comparison data.

${VISION_MODELS.length} tiling presets available:
${modelLines}

Supports: local files (filePath), remote images (sourceUrl), data URLs, base64, and web page capture (url — Chrome required).
Tiles saved as WebP (default) or PNG. Auto-downscales images over 10000px by default.

TOKEN COST NOTE: The get-tiles mode returns image tiles as inline base64, consuming significantly
more tokens than typical text-only MCP tools. Each tile costs ~258-1590 tokens depending
on preset. Use the Phase 2 summary and tile hints to fetch only non-blank, relevant tiles.`;

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
      url, viewportWidth, waitUntil, delay, mobile, deviceScaleFactor, userAgent, screenshotPath: existingScreenshotPath,
      // Tile retrieval
      tilesDir, start, end, skipBlankTiles,
      // Tiling config
      preset: explicitPreset, model: deprecatedModel, tileSize, maxDimension, outputDir, page, format, includeMetadata,
    }) => {
      // Resolve preset vs deprecated model param
      const explicitModel = explicitPreset ?? deprecatedModel;
      const deprecationWarnings: string[] = [];
      if (deprecatedModel && !explicitPreset) {
        deprecationWarnings.push('The "model" parameter is deprecated. Use "preset" instead.');
      } else if (deprecatedModel && explicitPreset && deprecatedModel !== explicitPreset) {
        deprecationWarnings.push(`"model" param ignored in favour of "preset" (values differ: model="${deprecatedModel}", preset="${explicitPreset}").`);
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
        return handleGetTiles(tilesDir, effectiveStart, effectiveEnd, skipBlankTiles);
      }

      // ── Mode: capture-and-tile ──
      if (url || existingScreenshotPath) {
        return handleCaptureAndTile(server, {
          url, viewportWidth, waitUntil, delay,
          mobile, deviceScaleFactor, userAgent,
          existingScreenshotPath,
          explicitModel, tileSize, maxDimension, outputDir, format, includeMetadata,
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
          explicitModel, tileSize, maxDimension, outputDir, format, includeMetadata,
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
  skipBlankTiles: boolean,
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

    await assertSafePath(tilesDir, "tilesDir", true);
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

    const tiles: ContentBlock[] = [];
    const summary = `Tiles ${start + 1}-${effectiveEnd + 1} of ${totalTiles}`;

    // Read manifest for geometry-aware classification (best-effort)
    type TilesManifest = {
      tileSize: number;
      tiles: Array<{ index: number; width: number; height: number }>;
    };
    let tilesManifest: TilesManifest | null = null;
    try {
      const raw = await fs.readFile(path.join(tilesDir, "tiles-manifest.json"), "utf8");
      tilesManifest = JSON.parse(raw) as TilesManifest;
    } catch { /* no manifest */ }
    const manifestMap = tilesManifest
      ? new Map(tilesManifest.tiles.map((t) => [t.index, t]))
      : null;

    // Analyze current batch for content metadata
    const metaMap = new Map<number, TileMetadata>();
    try {
      const batchPaths = tilePaths.slice(start, effectiveEnd + 1);
      const metadata = await analyzeTiles(
        batchPaths.map((filePath, i) => {
          const tileIndex = start + i;
          const dims = manifestMap?.get(tileIndex);
          return { filePath, index: i, extractedWidth: dims?.width, extractedHeight: dims?.height };
        }),
        tilesManifest?.tileSize
      );
      for (const m of metadata) {
        metaMap.set(start + m.index, m);
      }
    } catch (err) {
      console.error("[tiler] Tile analysis failed, skipping annotations:", err instanceof Error ? err.message : err);
    }

    let skippedCount = 0;
    for (let i = start; i <= effectiveEnd; i++) {
      const tilePath = tilePaths[i];
      const filename = path.basename(tilePath);
      const match = filename.match(/tile_(\d+)_(\d+)\.(png|webp)/);
      const row = match ? parseInt(match[1], 10) : -1;
      const col = match ? parseInt(match[2], 10) : -1;

      const meta = metaMap.get(i);

      // Skip blank tiles — text annotation only, no image data
      if (skipBlankTiles && meta?.isBlank) {
        tiles.push({
          type: "text" as const,
          text: `Tile ${i + 1}/${totalTiles} [index ${i}, row ${row}, col ${col}] (blank — skipped)`,
        });
        skippedCount++;
        continue;
      }

      const mimeType = path.extname(tilePath) === ".webp" ? "image/webp" : "image/png";
      const hintSuffix = meta
        ? ` (${meta.contentHint}, entropy=${meta.entropy}, sharpness=${meta.sharpness})`
        : "";
      tiles.push({
        type: "text" as const,
        text: `Tile ${i + 1}/${totalTiles} [index ${i}, row ${row}, col ${col}]${hintSuffix}`,
      });

      const base64Data = await readTileAsBase64(tilePath);
      tiles.push({
        type: "image" as const,
        data: base64Data,
        mimeType,
      });
    }

    const summaryText = skippedCount > 0 ? `${summary} (${skippedCount} blank tile(s) skipped)` : summary;
    return { content: [{ type: "text" as const, text: summaryText }, ...tiles] };
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
  format: "webp" | "png";
  includeMetadata: boolean;
  sourceWarning?: string;
  deprecationWarnings: string[];
}

async function handleTileImage(
  server: McpServer,
  params: TileImageParams,
): Promise<{ content: ContentBlock[]; isError?: boolean }> {
  const { filePath, sourceUrl, dataUrl, imageBase64, explicitModel, tileSize, maxDimension, outputDir, format, includeMetadata, sourceWarning, deprecationWarnings } = params;

  let source: ResolvedImageSource | undefined;
  let response: { content: ContentBlock[]; isError?: boolean } | undefined;

  try {
    if (filePath) {
      await assertSafePath(filePath, "filePath", true);
    }
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
        response = phase2;
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
      response = phase2;
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
      response = phase2;
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
        phase1.content.unshift({ type: "text" as const, text: prependWarnings.map(w => `Warning: ${w}`).join("\n") });
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
    response = phase2;
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    response = { isError: true, content: [{ type: "text" as const, text: `Error tiling image: ${message}` }] };
    return response;
  } finally {
    const cleanupWarning = await source?.cleanup?.();
    if (cleanupWarning && response && !response.isError) {
      response.content.push({ type: "text" as const, text: `\nWarning: ${cleanupWarning}` });
    }
  }
}

// ─── Capture Helpers ──────────────────────────────────────────────────────

interface CaptureSnapshot {
  screenshotPath: string;
  captureWidth: number;
  captureHeight: number;
  segmentsStitched?: number;
  capturedUrl?: string;
  actualViewportWidth?: number;
  actualDeviceScaleFactor?: number;
}

/** Captures a URL and saves the screenshot as PNG. Shared by all capture branches. */
async function performCapture(
  url: string,
  outputDir: string,
  options: {
    viewportWidth?: number;
    waitUntil: "load" | "networkidle" | "domcontentloaded";
    delay: number;
    mobile?: boolean;
    deviceScaleFactor?: number;
    userAgent?: string;
  },
): Promise<CaptureSnapshot> {
  const captureResult = await captureUrl({
    url,
    viewportWidth: options.viewportWidth,
    waitUntil: options.waitUntil,
    delay: options.delay,
    mobile: options.mobile,
    deviceScaleFactor: options.deviceScaleFactor,
    userAgent: options.userAgent,
  });

  const baseName = sanitizeHostname(url);
  const screenshotPath = path.join(outputDir, `${baseName}.png`);
  await sharp(captureResult.buffer).png({ compressionLevel: PNG_COMPRESSION_LEVEL }).toFile(screenshotPath);

  return {
    screenshotPath,
    captureWidth: captureResult.pageWidth,
    captureHeight: captureResult.pageHeight,
    segmentsStitched: captureResult.segmentsStitched,
    capturedUrl: captureResult.url,
    actualViewportWidth: captureResult.viewportWidth,
    actualDeviceScaleFactor: captureResult.deviceScaleFactor,
  };
}

/** Builds the captureInfo metadata object for Phase 2 responses. */
function buildCaptureInfo(
  snapshot: CaptureSnapshot,
  params: {
    viewportWidth?: number;
    mobile?: boolean;
    deviceScaleFactor?: number;
    waitUntil: "load" | "networkidle" | "domcontentloaded";
  },
) {
  return {
    url: snapshot.capturedUrl,
    pageWidth: snapshot.captureWidth,
    pageHeight: snapshot.captureHeight,
    segmentsStitched: snapshot.segmentsStitched ?? null,
    viewportWidth: snapshot.actualViewportWidth ?? params.viewportWidth ?? (params.mobile ? CAPTURE_MOBILE_VIEWPORT_WIDTH : CAPTURE_DEFAULT_VIEWPORT_WIDTH),
    deviceScaleFactor: snapshot.actualDeviceScaleFactor ?? params.deviceScaleFactor ?? (params.mobile ? 2 : 1),
    mobile: params.mobile ?? false,
    waitUntil: params.waitUntil,
  };
}

/** Builds the capture description text block prepended to Phase 2 responses. */
function buildCaptureLine(snapshot: CaptureSnapshot): { type: "text"; text: string } {
  const urlSuffix = snapshot.capturedUrl ? ` of ${snapshot.capturedUrl}` : "";
  const stitchSuffix = snapshot.segmentsStitched ? `\n  Scroll-stitched ${snapshot.segmentsStitched} segments` : "";
  return {
    type: "text" as const,
    text: `Captured ${snapshot.captureWidth}x${snapshot.captureHeight} screenshot${urlSuffix}${stitchSuffix}`,
  };
}

// ─── Capture and Tile Handler ──────────────────────────────────────────────

interface CaptureAndTileParams {
  url?: string;
  viewportWidth?: number;
  waitUntil: "load" | "networkidle" | "domcontentloaded";
  delay: number;
  mobile?: boolean;
  deviceScaleFactor?: number;
  userAgent?: string;
  existingScreenshotPath?: string;
  explicitModel?: typeof VISION_MODELS[number];
  tileSize?: number;
  maxDimension: number;
  outputDir?: string;
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
    mobile, deviceScaleFactor, userAgent,
    existingScreenshotPath,
    explicitModel, tileSize, maxDimension, outputDir, format, includeMetadata,
    deprecationWarnings,
  } = params;

  const resolvedOutputDir = await resolveOutputDirForCapture(outputDir);
  const captureOpts = { viewportWidth, waitUntil, delay, mobile, deviceScaleFactor, userAgent };

  try {
    await fs.mkdir(resolvedOutputDir, { recursive: true });

    // 1. Capture or reuse screenshot
    let snapshot: CaptureSnapshot;

    if (existingScreenshotPath) {
      await assertSafePath(existingScreenshotPath, "screenshotPath", true);
      // Check file existence and readability separately for distinct error messages
      let fileExists = false;
      try {
        const stat = await fs.stat(existingScreenshotPath);
        if (!stat.isFile()) {
          throw new Error(`screenshotPath is a directory, not an image file: ${existingScreenshotPath}`);
        }
        fileExists = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      }

      if (fileExists) {
        try {
          const meta = await withTimeout(sharp(existingScreenshotPath).metadata(), SHARP_OPERATION_TIMEOUT_MS, "screenshot-metadata");
          if (!meta.width || !meta.height) {
            throw new Error(`invalid dimensions (${meta.width ?? 0}x${meta.height ?? 0})`);
          }
          snapshot = {
            screenshotPath: existingScreenshotPath,
            captureWidth: meta.width,
            captureHeight: meta.height,
          };
        } catch (metaError) {
          if (!url) {
            throw new Error(
              `Screenshot at ${existingScreenshotPath} exists but could not be read: ${metaError instanceof Error ? metaError.message : String(metaError)}`
            );
          }
          snapshot = await performCapture(url, resolvedOutputDir, captureOpts);
        }
      } else {
        if (!url) {
          throw new Error(`Screenshot not found at ${existingScreenshotPath} and no url provided for recapture.`);
        }
        snapshot = await performCapture(url, resolvedOutputDir, captureOpts);
      }
    } else {
      snapshot = await performCapture(url!, resolvedOutputDir, captureOpts);
    }

    const { screenshotPath } = snapshot;
    const captureInfo = buildCaptureInfo(snapshot, { viewportWidth, mobile, deviceScaleFactor, waitUntil });

    // 2. Preview gate: if preview exists for THIS screenshot, skip straight to Phase 2
    const existingPreview = await checkPreviewGate(resolvedOutputDir, screenshotPath);
    if (existingPreview) {
      let finalModel = explicitModel;
      let autoSelected = false;
      if (!finalModel) {
        const elicitData = await computeElicitationData(screenshotPath, maxDimension);
        const cheapest = findCheapestModel(elicitData.allModels);
        const elicitResult = await tryElicitation(server, { ...elicitData, model: cheapest });

        if (elicitResult.status === "cancelled") {
          return { content: [{ type: "text" as const, text: "Tiling cancelled by user." }] };
        }

        finalModel = elicitResult.status === "selected" ? elicitResult.model : cheapest;
        autoSelected = elicitResult.status === "unsupported";
      }

      const tilingModel = finalModel!;
      const { result, warnings } = await executeTiling(screenshotPath, resolvedOutputDir, {
        model: tilingModel, tileSize, maxDimension, format, includeMetadata,
      });
      warnings.push(...deprecationWarnings);

      const phase2 = await buildPhase2Response(result, { model: tilingModel, includeMetadata, warnings, maxDimension, captureInfo, autoSelected, sourcePath: screenshotPath });
      phase2.content.unshift(buildCaptureLine(snapshot));
      return phase2;
    }

    // One-shot: user provided model + outputDir upfront
    if (explicitModel && outputDir) {
      await analyzeAndPreview(screenshotPath, resolvedOutputDir, {
        model: explicitModel, maxDimension, tileSize,
      });
      const { result, warnings } = await executeTiling(screenshotPath, resolvedOutputDir, {
        model: explicitModel, tileSize, maxDimension, format, includeMetadata,
      });
      warnings.push(...deprecationWarnings);
      const phase2 = await buildPhase2Response(result, {
        model: explicitModel, includeMetadata, warnings, maxDimension, captureInfo, sourcePath: screenshotPath,
      });
      phase2.content.unshift(buildCaptureLine(snapshot));
      return phase2;
    }

    // 3. Phase 1: analyze and generate preview
    const analysis = await analyzeAndPreview(screenshotPath, resolvedOutputDir, {
      model: explicitModel, maxDimension, tileSize,
    });
    const cheapest = findCheapestModel(analysis.allModels);

    const elicitResult = await tryElicitation(server, {
      width: analysis.sourceImage.width,
      height: analysis.sourceImage.height,
      model: explicitModel ?? cheapest,
      allModels: analysis.allModels,
    });

    if (elicitResult.status === "cancelled") {
      return { content: [{ type: "text" as const, text: "Tiling cancelled by user." }] };
    }

    if (elicitResult.status !== "selected") {
      const phase1 = buildPhase1Response(analysis, { screenshotPath });
      if (deprecationWarnings.length > 0) {
        phase1.content.unshift({ type: "text" as const, text: deprecationWarnings.map(w => `Warning: ${w}`).join("\n") });
      }
      phase1.content.push({ type: "text" as const, text: `Screenshot: ${snapshot.captureWidth}x${snapshot.captureHeight}${url ? ` of ${url}` : ""}, saved to ${screenshotPath}` });
      return phase1;
    }

    // 4. Elicitation returned a model
    const { result, warnings } = await executeTiling(screenshotPath, resolvedOutputDir, {
      model: elicitResult.model, tileSize, maxDimension, format, includeMetadata,
    });
    warnings.push(...deprecationWarnings);

    const phase2 = await buildPhase2Response(result, { model: elicitResult.model, includeMetadata, warnings, maxDimension, captureInfo, sourcePath: screenshotPath });
    phase2.content.unshift(buildCaptureLine(snapshot));
    return phase2;
  } catch (error) {
    // Clean up output directory on failure (rm recursive handles non-empty dirs)
    try { await fs.rm(resolvedOutputDir, { recursive: true, force: true }); } catch { /* already gone */ }

    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text" as const, text: `Error capturing and tiling URL: ${message}` }] };
  }
}
