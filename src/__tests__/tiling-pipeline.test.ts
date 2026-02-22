import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TileImageResult, ModelEstimate } from "../types.js";

vi.mock("../services/image-processor.js", () => ({
  getImageMetadata: vi.fn(),
  computeEstimateForModel: vi.fn(),
  tileImage: vi.fn(),
}));

vi.mock("../services/interactive-preview-generator.js", () => ({
  generateInteractivePreview: vi.fn(),
}));

vi.mock("../services/tile-analyzer.js", () => ({
  analyzeTiles: vi.fn(),
}));

vi.mock("../utils.js", () => ({
  getDefaultOutputBase: vi.fn().mockReturnValue("/Users/test/Desktop"),
  getVersionedOutputDir: vi.fn(async (baseDir: string) => `${baseDir}_v1`),
  stripVersionSuffix: vi.fn((name: string) => name.replace(/_v\d+$/, "")),
  formatModelComparisonTable: vi.fn().mockReturnValue("Image: 2000 x 1000\n\n  Preset  | ..."),
  buildTileHints: vi.fn().mockReturnValue({}),
  formatTileHintsSummary: vi.fn().mockReturnValue(""),
  escapeHtml: vi.fn((s: string) => s),
  simulateDownscale: vi.fn((w: number, h: number, maxDim: number) => {
    if (maxDim <= 0) return { width: w, height: h };
    const longest = Math.max(w, h);
    if (longest <= maxDim) return { width: w, height: h };
    const scale = maxDim / longest;
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
  }),
  sanitizeHostname: vi.fn().mockReturnValue("example-com"),
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import * as fsPromises from "node:fs/promises";
import { getImageMetadata, computeEstimateForModel, tileImage } from "../services/image-processor.js";
import { generateInteractivePreview } from "../services/interactive-preview-generator.js";
import { analyzeTiles } from "../services/tile-analyzer.js";
import { formatModelComparisonTable, buildTileHints, formatTileHintsSummary } from "../utils.js";

import {
  resolveOutputDir,
  resolveOutputDirForCapture,
  validateFormat,
  clampTileSize,
  checkPreviewGate,
  analyzeAndPreview,
  buildPhase1Response,
  executeTiling,
  buildPhase2Response,
  findCheapestModel,
  computeElicitationData,
} from "../services/tiling-pipeline.js";

const mockedGetMetadata = vi.mocked(getImageMetadata);
const mockedComputeEstimate = vi.mocked(computeEstimateForModel);
const mockedTileImage = vi.mocked(tileImage);
const mockedGeneratePreview = vi.mocked(generateInteractivePreview);
const mockedAnalyzeTiles = vi.mocked(analyzeTiles);
const mockedReaddir = vi.mocked(fsPromises.readdir);
const mockedWriteFile = vi.mocked(fsPromises.writeFile);
const mockedFormatTable = vi.mocked(formatModelComparisonTable);
const mockedBuildTileHints = vi.mocked(buildTileHints);
const mockedFormatTileHintsSummary = vi.mocked(formatTileHintsSummary);

const sampleAllModels: ModelEstimate[] = [
  { model: "claude", label: "Claude", tileSize: 1092, cols: 2, rows: 2, tiles: 4, tokens: 6360 },
  { model: "openai", label: "OpenAI", tileSize: 768, cols: 3, rows: 2, tiles: 6, tokens: 4590 },
  { model: "gemini", label: "Gemini", tileSize: 768, cols: 3, rows: 2, tiles: 6, tokens: 1548 },
  { model: "gemini3", label: "Gemini 3", tileSize: 1536, cols: 2, rows: 1, tiles: 2, tokens: 2240 },
];

function makeTileResult(overrides?: Partial<TileImageResult>): TileImageResult {
  return {
    sourceImage: { width: 2144, height: 2144, format: "png", fileSize: 50000, channels: 4 },
    grid: { cols: 2, rows: 2, totalTiles: 4, tileSize: 1092, estimatedTokens: 6360 },
    outputDir: "/output/tiles",
    tiles: [
      { index: 0, row: 0, col: 0, x: 0, y: 0, width: 1092, height: 1092, filename: "tile_000_000.webp", filePath: "/output/tiles/tile_000_000.webp" },
      { index: 1, row: 0, col: 1, x: 1092, y: 0, width: 1092, height: 1092, filename: "tile_000_001.webp", filePath: "/output/tiles/tile_000_001.webp" },
      { index: 2, row: 1, col: 0, x: 0, y: 1092, width: 1092, height: 1092, filename: "tile_001_000.webp", filePath: "/output/tiles/tile_001_000.webp" },
      { index: 3, row: 1, col: 1, x: 1092, y: 1092, width: 1092, height: 1092, filename: "tile_001_001.webp", filePath: "/output/tiles/tile_001_001.webp" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetMetadata.mockResolvedValue({ width: 2000, height: 1000, format: "png", fileSize: 50000, channels: 4 });
  mockedComputeEstimate.mockReturnValue(sampleAllModels[0]);
  mockedGeneratePreview.mockResolvedValue("/output/preview.html");
  mockedAnalyzeTiles.mockResolvedValue([]);
});

// ─── resolveOutputDir ─────────────────────────────────────────────────────

describe("resolveOutputDir", () => {
  it("returns explicit outputDir when provided", async () => {
    const dir = await resolveOutputDir("file", "/img.png", "/custom/dir");
    expect(dir).toBe("/custom/dir");
  });

  it("returns versioned tiles subfolder for file sources", async () => {
    const dir = await resolveOutputDir("file", "/images/photo.png");
    expect(dir).toContain("tiles");
    expect(dir).toContain("photo");
    expect(dir).toContain("_v1");
  });

  it("returns tiled_<timestamp> for non-file sources", async () => {
    const dir = await resolveOutputDir("url", "/tmp/from-url.png");
    expect(dir).toMatch(/tiled_\d+/);
  });
});

describe("resolveOutputDirForCapture", () => {
  it("returns explicit outputDir when provided", () => {
    const dir = resolveOutputDirForCapture("/custom/dir");
    expect(dir).toBe("/custom/dir");
  });

  it("returns capture_<timestamp> when no outputDir given", () => {
    const dir = resolveOutputDirForCapture();
    expect(dir).toMatch(/capture_\d+/);
  });
});

// ─── validateFormat ──────────────────────────────────────────────────────

describe("validateFormat", () => {
  it("returns null for supported formats", () => {
    expect(validateFormat("/img.png")).toBeNull();
    expect(validateFormat("/img.jpg")).toBeNull();
    expect(validateFormat("/img.webp")).toBeNull();
  });

  it("returns error for unsupported formats", () => {
    const err = validateFormat("/img.bmp");
    expect(err).toContain("Unsupported image format");
    expect(err).toContain(".bmp");
  });

  it("returns null for files with no extension", () => {
    expect(validateFormat("/imagefile")).toBeNull();
  });
});

// ─── clampTileSize ──────────────────────────────────────────────────────

describe("clampTileSize", () => {
  it("uses model default when no tileSize provided", () => {
    const { effectiveTileSize, warnings } = clampTileSize("claude");
    expect(effectiveTileSize).toBe(1092);
    expect(warnings).toHaveLength(0);
  });

  it("clamps above max with warning", () => {
    const { effectiveTileSize, warnings } = clampTileSize("claude", 2000);
    expect(effectiveTileSize).toBe(1568);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("clamped");
  });

  it("clamps below min with warning", () => {
    const { effectiveTileSize, warnings } = clampTileSize("claude", 100);
    expect(effectiveTileSize).toBe(256);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("clamped");
  });

  it("passes through valid tileSize without warnings", () => {
    const { effectiveTileSize, warnings } = clampTileSize("claude", 800);
    expect(effectiveTileSize).toBe(800);
    expect(warnings).toHaveLength(0);
  });
});

// ─── checkPreviewGate ────────────────────────────────────────────────────

describe("checkPreviewGate", () => {
  it("returns preview path when preview exists", async () => {
    mockedReaddir.mockResolvedValue(["tile_000_000.webp", "image-preview.html"] as any);
    const result = await checkPreviewGate("/output/tiles");
    expect(result).toBe("/output/tiles/image-preview.html");
  });

  it("returns null when no preview exists", async () => {
    mockedReaddir.mockResolvedValue(["tile_000_000.webp", "tile_000_001.webp"] as any);
    const result = await checkPreviewGate("/output/tiles");
    expect(result).toBeNull();
  });

  it("returns null when directory doesn't exist", async () => {
    mockedReaddir.mockRejectedValue(new Error("ENOENT"));
    const result = await checkPreviewGate("/nonexistent");
    expect(result).toBeNull();
  });
});

// ─── findCheapestModel ───────────────────────────────────────────────────

describe("findCheapestModel", () => {
  it("picks the model with lowest tokens", () => {
    expect(findCheapestModel(sampleAllModels)).toBe("gemini");
  });

  it("returns first model when only one model", () => {
    expect(findCheapestModel([sampleAllModels[0]])).toBe("claude");
  });

  it("returns first of tied models", () => {
    const tied = [
      { model: "openai", label: "OpenAI", tileSize: 768, cols: 3, rows: 2, tiles: 6, tokens: 1000 },
      { model: "gemini", label: "Gemini", tileSize: 768, cols: 3, rows: 2, tiles: 6, tokens: 1000 },
    ];
    expect(findCheapestModel(tied)).toBe("openai");
  });
});

// ─── computeElicitationData ──────────────────────────────────────────────

describe("computeElicitationData", () => {
  it("returns image dimensions and allModels estimates", async () => {
    const result = await computeElicitationData("/img.png", 10000);
    expect(result.width).toBe(2000);
    expect(result.height).toBe(1000);
    expect(result.allModels).toBeDefined();
    expect(mockedComputeEstimate).toHaveBeenCalledTimes(4); // 4 vision models
  });

  it("passes undefined maxDimension when set to 0", async () => {
    await computeElicitationData("/img.png", 0);
    expect(mockedComputeEstimate).toHaveBeenCalledWith(
      expect.any(String), 2000, 1000, undefined, undefined
    );
  });
});

// ─── analyzeAndPreview ───────────────────────────────────────────────────

describe("analyzeAndPreview", () => {
  it("returns analysis with allModels and previewPath", async () => {
    const result = await analyzeAndPreview("/img.png", "/output", {
      model: "claude",
      maxDimension: 10000,
    });
    expect(result.outputDir).toBe("/output");
    expect(result.previewPath).toBe("/output/preview.html");
    expect(result.sourceImage).toEqual({ width: 2000, height: 1000 });
    expect(result.allModels).toBeDefined();
  });

  it("handles preview generation failure gracefully and surfaces warning", async () => {
    mockedGeneratePreview.mockRejectedValue(new Error("write failed"));
    const result = await analyzeAndPreview("/img.png", "/output", {
      model: "claude",
      maxDimension: 10000,
    });
    expect(result.previewPath).toBeUndefined();
    expect(result.warnings).toEqual(["Preview generation failed: write failed"]);
  });

  it("does not include warnings when preview succeeds", async () => {
    const result = await analyzeAndPreview("/img.png", "/output", {
      model: "claude",
      maxDimension: 10000,
    });
    expect(result.previewPath).toBe("/output/preview.html");
    expect(result.warnings).toBeUndefined();
  });

  it("returns effectiveImage when image will be downscaled", async () => {
    mockedGetMetadata.mockResolvedValue({ width: 3600, height: 22810, format: "png", fileSize: 50000, channels: 4 });
    const result = await analyzeAndPreview("/img.png", "/output", {
      model: "claude",
      maxDimension: 10000,
    });
    expect(result.sourceImage).toEqual({ width: 3600, height: 22810 });
    expect(result.effectiveImage).toEqual({ width: 1578, height: 10000 });
  });

  it("does not return effectiveImage when image fits within maxDimension", async () => {
    const result = await analyzeAndPreview("/img.png", "/output", {
      model: "claude",
      maxDimension: 10000,
    });
    expect(result.sourceImage).toEqual({ width: 2000, height: 1000 });
    expect(result.effectiveImage).toBeUndefined();
  });

  it("passes post-downscale dimensions to generateInteractivePreview", async () => {
    mockedGetMetadata.mockResolvedValue({ width: 3600, height: 22810, format: "png", fileSize: 50000, channels: 4 });
    await analyzeAndPreview("/img.png", "/output", {
      model: "claude",
      maxDimension: 10000,
    });
    expect(mockedGeneratePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveWidth: 1578,
        effectiveHeight: 10000,
        originalWidth: 3600,
        originalHeight: 22810,
      }),
      "/output"
    );
  });
});

// ─── buildPhase1Response ─────────────────────────────────────────────────

describe("buildPhase1Response", () => {
  it("returns 2 content blocks with table and structured JSON", () => {
    const analysis = {
      outputDir: "/output",
      previewPath: "/output/preview.html",
      sourceImage: { width: 2000, height: 1000 },
      allModels: sampleAllModels,
    };
    const response = buildPhase1Response(analysis);
    expect(response.content).toHaveLength(2);
    expect(response.content[0].text).toContain("ACTION REQUIRED");
    expect(response.content[0].text).toContain("Preview: /output/preview.html");
    expect(response.content[0].text).not.toContain("outputDir=");

    const json = JSON.parse(response.content[1].text);
    expect(json.status).toBe("awaiting_user_choice");
    expect(json.outputDir).toBe("/output");
    expect(json.allModels).toBeDefined();
  });

  it("includes token cost note", () => {
    const analysis = {
      outputDir: "/output",
      sourceImage: { width: 2000, height: 1000 },
      allModels: sampleAllModels,
    };
    const response = buildPhase1Response(analysis);
    expect(response.content[0].text).toContain("Token note");
    expect(response.content[0].text).toContain("~258-1590 tokens each");
  });

  it("includes extra fields in structured JSON", () => {
    const analysis = {
      outputDir: "/output",
      sourceImage: { width: 2000, height: 1000 },
      allModels: sampleAllModels,
    };
    const response = buildPhase1Response(analysis, { screenshotPath: "/output/screenshot.png" });
    const json = JSON.parse(response.content[1].text);
    expect(json.screenshotPath).toBe("/output/screenshot.png");
  });

  it("includes warnings in text and structured output when present", () => {
    const analysis = {
      outputDir: "/output",
      sourceImage: { width: 2000, height: 1000 },
      allModels: sampleAllModels,
      warnings: ["Preview generation failed: write failed"],
    };
    const response = buildPhase1Response(analysis);
    expect(response.content[0].text).toContain("Preview generation failed: write failed");
    const json = JSON.parse(response.content[1].text);
    expect(json.warnings).toEqual(["Preview generation failed: write failed"]);
  });

  it("omits warnings from output when none present", () => {
    const analysis = {
      outputDir: "/output",
      previewPath: "/output/preview.html",
      sourceImage: { width: 2000, height: 1000 },
      allModels: sampleAllModels,
    };
    const response = buildPhase1Response(analysis);
    expect(response.content[0].text).not.toContain("⚠");
    const json = JSON.parse(response.content[1].text);
    expect(json.warnings).toBeUndefined();
  });

  it("passes effective dimensions to formatModelComparisonTable when effectiveImage is present", () => {
    const analysis = {
      outputDir: "/output",
      sourceImage: { width: 3600, height: 22810 },
      effectiveImage: { width: 1579, height: 10000 },
      allModels: sampleAllModels,
    };
    buildPhase1Response(analysis);
    expect(mockedFormatTable).toHaveBeenCalledWith(3600, 22810, sampleAllModels, 1579, 10000);
  });

  it("passes original dimensions as effective when effectiveImage is absent", () => {
    const analysis = {
      outputDir: "/output",
      sourceImage: { width: 2000, height: 1000 },
      allModels: sampleAllModels,
    };
    buildPhase1Response(analysis);
    expect(mockedFormatTable).toHaveBeenCalledWith(2000, 1000, sampleAllModels, 2000, 1000);
  });
});

// ─── executeTiling ───────────────────────────────────────────────────────

describe("executeTiling", () => {
  it("calls tileImage with correct parameters", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    await executeTiling("/img.png", "/output", {
      model: "claude",
      tileSize: undefined,
      maxDimension: 10000,
      format: "webp",
      includeMetadata: true,
    });
    expect(mockedTileImage).toHaveBeenCalledWith(
      "/img.png", 1092, "/output", 1590, 10000, 1568, "webp"
    );
  });

  it("clamps tile size and returns warnings", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    const { warnings } = await executeTiling("/img.png", "/output", {
      model: "claude",
      tileSize: 5000,
      maxDimension: 10000,
      format: "webp",
      includeMetadata: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("clamped");
    expect(mockedTileImage).toHaveBeenCalledWith(
      "/img.png", 1568, "/output", 1590, 10000, 1568, "webp"
    );
  });

  it("passes undefined maxDimension when set to 0", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    await executeTiling("/img.png", "/output", {
      model: "claude",
      maxDimension: 0,
      format: "webp",
      includeMetadata: true,
    });
    expect(mockedTileImage).toHaveBeenCalledWith(
      "/img.png", 1092, "/output", 1590, undefined, 1568, "webp"
    );
  });

  it("merges tileImage warnings with clampTileSize warnings", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult({
      warnings: ["Failed to clean up temp file /tmp/x.png: EPERM"],
    }));
    const { warnings } = await executeTiling("/img.png", "/output", {
      model: "claude",
      tileSize: 5000,
      maxDimension: 10000,
      format: "webp",
      includeMetadata: true,
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("clamped");
    expect(warnings[1]).toContain("Failed to clean up temp file");
  });

  it("returns only clampTileSize warnings when tileImage has none", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    const { warnings } = await executeTiling("/img.png", "/output", {
      model: "claude",
      tileSize: 5000,
      maxDimension: 10000,
      format: "webp",
      includeMetadata: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("clamped");
  });

  it("returns only tileImage warnings when clampTileSize has none", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult({
      warnings: ["Failed to clean up temp file /tmp/x.png: EPERM"],
    }));
    const { warnings } = await executeTiling("/img.png", "/output", {
      model: "claude",
      maxDimension: 10000,
      format: "webp",
      includeMetadata: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Failed to clean up temp file");
  });

  it("writes tiles-manifest.json with tileSize and per-tile dimensions", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    await executeTiling("/img.png", "/output", {
      model: "claude",
      maxDimension: 10000,
      format: "webp",
      includeMetadata: false,
    });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/output/tiles-manifest.json",
      expect.any(String),
      "utf8"
    );
    const written = JSON.parse((mockedWriteFile.mock.calls[0] as any)[1]);
    expect(written.tileSize).toBe(1092);
    expect(written.cols).toBe(2);
    expect(written.rows).toBe(2);
    expect(written.tiles).toHaveLength(4);
    expect(written.tiles[0]).toEqual({ index: 0, width: 1092, height: 1092 });
    expect(written.tiles[3]).toEqual({ index: 3, width: 1092, height: 1092 });
  });

  it("does not throw when tiles-manifest.json write fails", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    mockedWriteFile.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      executeTiling("/img.png", "/output", {
        model: "claude",
        maxDimension: 10000,
        format: "webp",
        includeMetadata: false,
      })
    ).resolves.not.toThrow();
  });
});

// ─── buildPhase2Response ─────────────────────────────────────────────────

describe("buildPhase2Response", () => {
  beforeEach(() => {
    mockedReaddir.mockResolvedValue([] as any);
  });

  it("returns summary and structured JSON", async () => {
    const result = makeTileResult();
    const response = await buildPhase2Response(result, {
      model: "claude",
      includeMetadata: false,
      warnings: [],
      maxDimension: 10000,
    });
    expect(response.content).toHaveLength(2);
    expect(response.content[0].text).toContain("2x2 grid");
    expect(response.content[0].text).toContain("4 tiles");
    expect(response.content[0].text).toContain("for Claude");

    const json = JSON.parse(response.content[1].text);
    expect(json.model).toBe("claude");
    expect(json.grid.totalTiles).toBe(4);
  });

  it("includes fetch-tiles instruction with outputDir", async () => {
    const result = makeTileResult();
    const response = await buildPhase2Response(result, {
      model: "claude",
      includeMetadata: false,
      warnings: [],
      maxDimension: 10000,
    });
    expect(response.content[0].text).toContain("Fetch tiles");
    expect(response.content[0].text).toContain('tilesDir="/output/tiles"');
  });

  it("includes resize info in summary and JSON when present", async () => {
    const result = makeTileResult({
      resize: { originalWidth: 7680, originalHeight: 4032, resizedWidth: 2048, resizedHeight: 1076, scaleFactor: 0.267 },
    });
    const response = await buildPhase2Response(result, {
      model: "claude",
      includeMetadata: false,
      warnings: [],
      maxDimension: 10000,
    });
    expect(response.content[0].text).toContain("Downscaled from 7680×4032");
    const json = JSON.parse(response.content[1].text);
    expect(json.resize).toBeDefined();
  });

  it("includes warnings in summary and JSON", async () => {
    const result = makeTileResult();
    const response = await buildPhase2Response(result, {
      model: "claude",
      includeMetadata: false,
      warnings: ["Tile size clamped"],
      maxDimension: 10000,
    });
    expect(response.content[0].text).toContain("⚠ Tile size clamped");
    const json = JSON.parse(response.content[1].text);
    expect(json.warnings).toContain("Tile size clamped");
  });

  it("calls analyzeTiles when includeMetadata is true", async () => {
    const result = makeTileResult();
    await buildPhase2Response(result, {
      model: "claude",
      includeMetadata: true,
      warnings: [],
      maxDimension: 10000,
    });
    expect(mockedAnalyzeTiles).toHaveBeenCalledWith(
      [
        { filePath: "/output/tiles/tile_000_000.webp", index: 0, extractedWidth: 1092, extractedHeight: 1092 },
        { filePath: "/output/tiles/tile_000_001.webp", index: 1, extractedWidth: 1092, extractedHeight: 1092 },
        { filePath: "/output/tiles/tile_001_000.webp", index: 2, extractedWidth: 1092, extractedHeight: 1092 },
        { filePath: "/output/tiles/tile_001_001.webp", index: 3, extractedWidth: 1092, extractedHeight: 1092 },
      ],
      1092
    );
  });

  it("does not call analyzeTiles when includeMetadata is false", async () => {
    const result = makeTileResult();
    await buildPhase2Response(result, {
      model: "claude",
      includeMetadata: false,
      warnings: [],
      maxDimension: 10000,
    });
    expect(mockedAnalyzeTiles).not.toHaveBeenCalled();
  });

  it("adds warning when Phase 2 preview generation fails", async () => {
    // Source file exists but no preview — triggers preview generation
    mockedReaddir.mockResolvedValue(["source.png"] as any);
    mockedGeneratePreview.mockRejectedValue(new Error("disk full"));

    const result = makeTileResult();
    const response = await buildPhase2Response(result, {
      model: "claude",
      includeMetadata: false,
      warnings: [],
      maxDimension: 10000,
    });

    expect(response.content[0].text).toContain("Preview generation failed: disk full");
    const json = JSON.parse(response.content[1].text);
    expect(json.warnings).toContain("Preview generation failed: disk full");
  });

  it("includes captureInfo when provided", async () => {
    const result = makeTileResult();
    const response = await buildPhase2Response(result, {
      model: "claude",
      includeMetadata: false,
      warnings: [],
      maxDimension: 10000,
      captureInfo: { url: "https://example.com", pageWidth: 1280, pageHeight: 800 },
    });
    const json = JSON.parse(response.content[1].text);
    expect(json.capture).toBeDefined();
    expect(json.capture.url).toBe("https://example.com");
  });

  it("includes auto-selection notice and comparison table when autoSelected is true", async () => {
    const result = makeTileResult();
    const response = await buildPhase2Response(result, {
      model: "gemini",
      includeMetadata: false,
      warnings: [],
      maxDimension: 10000,
      autoSelected: true,
    });
    expect(response.content[0].text).toContain("Auto-selected Gemini preset");
    expect(response.content[0].text).toContain("lowest token cost");
    expect(response.content[0].text).toContain('specify preset=');

    const json = JSON.parse(response.content[1].text);
    expect(json.autoSelected).toBe(true);
    expect(json.allModels).toBeDefined();
  });

  it("does not include auto-selection notice when autoSelected is false/undefined", async () => {
    const result = makeTileResult();
    const response = await buildPhase2Response(result, {
      model: "claude",
      includeMetadata: false,
      warnings: [],
      maxDimension: 10000,
    });
    expect(response.content[0].text).not.toContain("Auto-selected");
    expect(response.content[0].text).not.toContain("specify preset=");

    const json = JSON.parse(response.content[1].text);
    expect(json.autoSelected).toBeUndefined();
    expect(json.allModels).toBeUndefined();
  });

  it("includes tile content summary and tileMetadata in structured output when includeMetadata is true", async () => {
    const mockTileMetadata = [
      { index: 0, contentHint: "low-detail", meanBrightness: 200, stdDev: 15, entropy: 2.5, sharpness: 1.2, isBlank: false },
      { index: 1, contentHint: "high-detail", meanBrightness: 128, stdDev: 65, entropy: 7.2, sharpness: 4.5, isBlank: false },
      { index: 2, contentHint: "blank", meanBrightness: 255, stdDev: 2, entropy: 0.1, sharpness: 0.05, isBlank: true },
      { index: 3, contentHint: "low-detail", meanBrightness: 210, stdDev: 12, entropy: 3.0, sharpness: 0.8, isBlank: false },
    ];
    mockedAnalyzeTiles.mockResolvedValue(mockTileMetadata as any);
    mockedBuildTileHints.mockReturnValue({ "low-detail": [0, 3], "high-detail": [1], "blank": [2] });
    mockedFormatTileHintsSummary.mockReturnValue("Tile content: 2 low-detail, 1 high-detail, 1 blank");

    const result = makeTileResult();
    const response = await buildPhase2Response(result, {
      model: "claude",
      includeMetadata: true,
      warnings: [],
      maxDimension: 10000,
    });
    expect(response.content[0].text).toContain("Tile content: 2 low-detail, 1 high-detail, 1 blank");

    const json = JSON.parse(response.content[1].text);
    expect(json.tileHints).toEqual({ "low-detail": [0, 3], "high-detail": [1], "blank": [2] });
    expect(json.tileMetadata).toEqual(mockTileMetadata);
  });

  it("does not include tile content summary when includeMetadata is false", async () => {
    const result = makeTileResult();
    const response = await buildPhase2Response(result, {
      model: "claude",
      includeMetadata: false,
      warnings: [],
      maxDimension: 10000,
    });
    expect(response.content[0].text).not.toContain("Tile content:");
    expect(mockedFormatTileHintsSummary).not.toHaveBeenCalled();

    const json = JSON.parse(response.content[1].text);
    expect(json.tileHints).toBeUndefined();
  });
});
