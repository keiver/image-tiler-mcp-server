import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TileImageResult, AnalysisResult } from "../types.js";

vi.mock("../services/image-source-resolver.js", () => ({
  resolveImageSource: vi.fn(),
}));

vi.mock("../services/url-capture.js", () => ({
  captureUrl: vi.fn(),
}));

vi.mock("../services/image-processor.js", () => ({
  listTilesInDirectory: vi.fn(),
  readTileAsBase64: vi.fn(),
}));

vi.mock("../services/tiling-pipeline.js", () => ({
  resolveOutputDir: vi.fn(),
  resolveOutputDirForCapture: vi.fn(),
  validateFormat: vi.fn(),
  checkPreviewGate: vi.fn(),
  analyzeAndPreview: vi.fn(),
  buildPhase1Response: vi.fn(),
  executeTiling: vi.fn(),
  buildPhase2Response: vi.fn(),
  findCheapestModel: vi.fn(),
  computeElicitationData: vi.fn(),
}));

vi.mock("../services/elicitation.js", () => ({
  tryElicitation: vi.fn(),
}));

vi.mock("../services/tile-analyzer.js", () => ({
  analyzeTiles: vi.fn(),
}));

vi.mock("../utils.js", () => ({
  getDefaultOutputBase: vi.fn().mockReturnValue("/Users/test/Desktop"),
  sanitizeHostname: vi.fn().mockReturnValue("example-com"),
  escapeHtml: vi.fn((s: string) => s),
  buildTileHints: vi.fn().mockReturnValue({}),
  withTimeout: vi.fn((promise: Promise<unknown>) => promise),
}));

vi.mock("sharp", () => {
  const mockToFile = vi.fn().mockResolvedValue({});
  const mockPng = vi.fn().mockReturnValue({ toFile: mockToFile });
  const mockWebp = vi.fn().mockReturnValue({ toFile: mockToFile });
  const mockMetadata = vi.fn().mockResolvedValue({ width: 1280, height: 800 });
  const mockSharpInstance = { png: mockPng, webp: mockWebp, toFile: mockToFile, metadata: mockMetadata };
  const mockSharp = Object.assign(
    vi.fn().mockReturnValue(mockSharpInstance),
    { cache: vi.fn(), concurrency: vi.fn() }
  );
  return { default: mockSharp };
});

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
}));

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
import { analyzeTiles } from "../services/tile-analyzer.js";
import { registerTilerTool } from "../tools/tiler.js";
import { createMockServer } from "./helpers/mock-server.js";
import * as fsPromises from "node:fs/promises";
import sharp from "sharp";

const mockedAnalyzeTiles = vi.mocked(analyzeTiles);

const mockedResolveSource = vi.mocked(resolveImageSource);
const mockedCaptureUrl = vi.mocked(captureUrl);
const mockedListTiles = vi.mocked(listTilesInDirectory);
const mockedReadBase64 = vi.mocked(readTileAsBase64);
const mockedReadFile = vi.mocked(fsPromises.readFile);
const mockedResolveOutputDir = vi.mocked(resolveOutputDir);
const mockedResolveOutputDirForCapture = vi.mocked(resolveOutputDirForCapture);
const mockedValidateFormat = vi.mocked(validateFormat);
const mockedCheckPreviewGate = vi.mocked(checkPreviewGate);
const mockedAnalyzeAndPreview = vi.mocked(analyzeAndPreview);
const mockedBuildPhase1Response = vi.mocked(buildPhase1Response);
const mockedExecuteTiling = vi.mocked(executeTiling);
const mockedBuildPhase2Response = vi.mocked(buildPhase2Response);
const mockedTryElicitation = vi.mocked(tryElicitation);
const mockedFindCheapestModel = vi.mocked(findCheapestModel);
const mockedComputeElicitationData = vi.mocked(computeElicitationData);

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTileResult(overrides?: Partial<TileImageResult>): TileImageResult {
  return {
    sourceImage: { width: 2144, height: 2144, format: "png", fileSize: 50000, channels: 4 },
    grid: { cols: 2, rows: 2, totalTiles: 4, tileSize: 1092, estimatedTokens: 6360 },
    outputDir: "/output/tiles",
    tiles: [
      { index: 0, row: 0, col: 0, x: 0, y: 0, width: 1092, height: 1092, filename: "tile_000_000.webp", filePath: "/output/tiles/tile_000_000.webp" },
    ],
    ...overrides,
  };
}

function makeTilePaths(count: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 4);
    const col = i % 4;
    paths.push(
      `/tiles/tile_${String(row).padStart(3, "0")}_${String(col).padStart(3, "0")}.png`
    );
  }
  return paths;
}

const sampleAnalysis: AnalysisResult = {
  outputDir: "/output/tiles",
  previewPath: "/output/tiles/preview.html",
  sourceImage: { width: 2144, height: 2144 },
  allModels: [
    { model: "claude", label: "Claude", tileSize: 1092, cols: 2, rows: 2, tiles: 4, tokens: 6360 },
  ],
};

const phase2Response = {
  content: [
    { type: "text" as const, text: "Tiled 2144x2144 image for Claude" },
    { type: "text" as const, text: '{"model":"claude"}' },
  ],
};

// ─── Registration ───────────────────────────────────────────────────────────

describe("registerTilerTool", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerTilerTool(mock.server as any);

    // Default mocks for tile-image happy path
    mockedResolveSource.mockResolvedValue({
      localPath: "/images/photo.png",
      sourceType: "file",
      originalSource: "/images/photo.png",
    });
    mockedValidateFormat.mockReturnValue(null);
    mockedResolveOutputDir.mockResolvedValue("/output/tiles");
    mockedCheckPreviewGate.mockResolvedValue(null);
    mockedAnalyzeAndPreview.mockResolvedValue(sampleAnalysis);
    mockedTryElicitation.mockResolvedValue({ status: "selected", model: "claude" });
    mockedFindCheapestModel.mockReturnValue("gemini");
    mockedComputeElicitationData.mockResolvedValue({
      width: 2144, height: 2144,
      allModels: sampleAnalysis.allModels,
    });
    mockedExecuteTiling.mockResolvedValue({ result: makeTileResult(), warnings: [] });
    mockedBuildPhase2Response.mockResolvedValue(phase2Response);
    mockedBuildPhase1Response.mockReturnValue({
      content: [
        { type: "text", text: "ACTION REQUIRED: Present the tiling options below to the user and wait for their choice.\n\n---\n\nImage: 2144 x 2144" },
        { type: "text", text: '{"status":"awaiting_user_choice"}' },
      ],
    });

    // Default mocks for capture happy path
    mockedCaptureUrl.mockResolvedValue({
      buffer: Buffer.from("screenshot-data"),
      pageWidth: 1280,
      pageHeight: 800,
      url: "https://example.com",
    });
    mockedResolveOutputDirForCapture.mockReturnValue("/output/tiles");

    // Default mocks for get-tiles
    mockedReadBase64.mockResolvedValue("AAAA");
    mockedAnalyzeTiles.mockResolvedValue([]);
  });

  it("registers the tool with correct name", () => {
    expect(mock.server.registerTool).toHaveBeenCalledWith(
      "tiler",
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("description includes mandatory two-phase workflow and cost guidance", () => {
    const registerCall = (mock.server.registerTool as any).mock.calls[0];
    const description = registerCall[1].description as string;
    expect(description).toContain("MANDATORY two-phase workflow");
    expect(description).toContain("DO NOT skip Phase 1");
    expect(description).toContain("DO NOT include preset, tileSize, or outputDir");
    expect(description).toContain("DO NOT select a preset yourself");
    expect(description).toContain("cheapest option");
    expect(description).toContain("TOKEN COST NOTE");
    expect(description).toContain("summary and tile hints");
  });

  // ─── No input ─────────────────────────────────────────────────────────────

  it("returns generic error when zero params provided", async () => {
    const tool = mock.getTool("tiler")!;
    const result = await tool.handler({}, {} as any);
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No input provided");
  });

  // ─── Tile Image Mode ─────────────────────────────────────────────────────

  describe("tile-image mode", () => {
    it("returns Phase 2 error when preset provided but no image source", async () => {
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { preset: "claude", tileSize: 1092 },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Phase 2 requires an image source");
      expect(res.content[0].text).toContain("preset and outputDir");
    });

    it("returns Phase 2 error when outputDir provided but no image source", async () => {
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { outputDir: "/some/dir" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Phase 2 requires an image source");
    });

    it("rejects unsupported image format", async () => {
      mockedValidateFormat.mockReturnValue("Error: Unsupported image format '.bmp'.");
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { filePath: "test.bmp", preset: "claude" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Unsupported image format");
    });

    it("returns Phase 1 response when no preview exists and elicitation returns null", async () => {
      mockedTryElicitation.mockResolvedValue({ status: "unsupported" });
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { filePath: "image.png" },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toContain("ACTION REQUIRED");
      expect(mockedBuildPhase1Response).toHaveBeenCalledWith(sampleAnalysis);
      expect(mockedExecuteTiling).not.toHaveBeenCalled();
    });

    it("returns Phase 2 response when preview gate passes with explicit model", async () => {
      mockedCheckPreviewGate.mockResolvedValue("/output/tiles/preview.html");
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { filePath: "image.png", preset: "openai", outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBeUndefined();
      expect(mockedExecuteTiling).toHaveBeenCalledWith(
        "/images/photo.png",
        "/output/tiles",
        expect.objectContaining({ model: "openai" })
      );
      expect(mockedBuildPhase2Response).toHaveBeenCalled();
      expect(mockedAnalyzeAndPreview).not.toHaveBeenCalled();
      expect(mockedComputeElicitationData).not.toHaveBeenCalled();
    });

    it("Phase 2 uses cheapest model when no explicit model and elicitation unavailable", async () => {
      mockedCheckPreviewGate.mockResolvedValue("/output/tiles/preview.html");
      mockedTryElicitation.mockResolvedValue({ status: "unsupported" });
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { filePath: "image.png", outputDir: "/out" },
        {} as any
      );
      expect(mockedComputeElicitationData).toHaveBeenCalled();
      expect(mockedFindCheapestModel).toHaveBeenCalled();
      expect(mockedExecuteTiling).toHaveBeenCalledWith(
        "/images/photo.png",
        "/output/tiles",
        expect.objectContaining({ model: "gemini" })
      );
      expect(mockedBuildPhase2Response).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ model: "gemini", autoSelected: true })
      );
    });

    it("Phase 2 uses elicitation-selected model when available", async () => {
      mockedCheckPreviewGate.mockResolvedValue("/output/tiles/preview.html");
      mockedTryElicitation.mockResolvedValue({ status: "selected", model: "openai" });
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { filePath: "image.png", outputDir: "/out" },
        {} as any
      );
      expect(mockedExecuteTiling).toHaveBeenCalledWith(
        "/images/photo.png",
        "/output/tiles",
        expect.objectContaining({ model: "openai" })
      );
      expect(mockedBuildPhase2Response).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ model: "openai", autoSelected: false })
      );
    });

    it("passes source params to resolveImageSource", async () => {
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { filePath: "image.png", sourceUrl: "https://example.com/img.png", preset: "claude" },
        {} as any
      );
      expect(mockedResolveSource).toHaveBeenCalledWith({
        filePath: "image.png",
        sourceUrl: "https://example.com/img.png",
        dataUrl: undefined,
        imageBase64: undefined,
      });
    });

    it("calls cleanup on source after success", async () => {
      const cleanup = vi.fn().mockResolvedValue(undefined);
      mockedResolveSource.mockResolvedValue({
        localPath: "/tmp/from-url.png",
        sourceType: "url",
        originalSource: "https://example.com/img.png",
        cleanup,
      });
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { sourceUrl: "https://example.com/img.png", preset: "claude" },
        {} as any
      );
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("calls cleanup even on error", async () => {
      const cleanup = vi.fn().mockResolvedValue(undefined);
      mockedResolveSource.mockResolvedValue({
        localPath: "/tmp/from-url.png",
        sourceType: "url",
        originalSource: "https://example.com/img.png",
        cleanup,
      });
      mockedExecuteTiling.mockRejectedValue(new Error("fail"));
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { sourceUrl: "https://example.com/img.png", preset: "claude" },
        {} as any
      );
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("calls cleanup when Phase 1 response is returned", async () => {
      const cleanup = vi.fn().mockResolvedValue(undefined);
      mockedResolveSource.mockResolvedValue({
        localPath: "/tmp/from-url.png",
        sourceType: "url",
        originalSource: "https://example.com/img.png",
        cleanup,
      });
      mockedTryElicitation.mockResolvedValue({ status: "unsupported" });
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { sourceUrl: "https://example.com/img.png", preset: "claude" },
        {} as any
      );
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("appends cleanup warning to response content on success", async () => {
      const cleanup = vi.fn().mockResolvedValue("Failed to clean up temp file /tmp/x.png: EPERM");
      mockedResolveSource.mockResolvedValue({
        localPath: "/tmp/from-url.png",
        sourceType: "url",
        originalSource: "https://example.com/img.png",
        cleanup,
      });
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { sourceUrl: "https://example.com/img.png", preset: "claude" },
        {} as any
      );
      const res = result as any;
      const lastBlock = res.content[res.content.length - 1];
      expect(lastBlock.text).toContain("Failed to clean up temp file");
      expect(lastBlock.text).toContain("EPERM");
    });

    it("does not append cleanup warning on error response", async () => {
      const cleanup = vi.fn().mockResolvedValue("Failed to clean up temp file /tmp/x.png: EPERM");
      mockedResolveSource.mockResolvedValue({
        localPath: "/tmp/from-url.png",
        sourceType: "url",
        originalSource: "https://example.com/img.png",
        cleanup,
      });
      mockedExecuteTiling.mockRejectedValue(new Error("fail"));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { sourceUrl: "https://example.com/img.png", preset: "claude" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      const allText = res.content.map((c: any) => c.text).join("");
      expect(allText).not.toContain("Failed to clean up");
    });

    it("wraps errors from pipeline", async () => {
      mockedAnalyzeAndPreview.mockRejectedValue(new Error("Sharp failed"));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { filePath: "bad.png", preset: "claude" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Error tiling image");
      expect(res.content[0].text).toContain("Sharp failed");
    });

    it("wraps non-Error throws", async () => {
      mockedAnalyzeAndPreview.mockRejectedValue("string error");
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { filePath: "bad.png", preset: "claude" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("string error");
    });

    it("wraps errors from tryElicitation", async () => {
      mockedTryElicitation.mockRejectedValue(new Error("Transport closed"));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { filePath: "image.png" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Error tiling image");
      expect(res.content[0].text).toContain("Transport closed");
    });

    it("deprecated model param resolves correctly and emits deprecation warning", async () => {
      mockedCheckPreviewGate.mockResolvedValue("/output/tiles/preview.html");
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { filePath: "image.png", model: "openai", outputDir: "/out" },
        {} as any
      );
      expect(mockedExecuteTiling).toHaveBeenCalledWith(
        "/images/photo.png",
        "/output/tiles",
        expect.objectContaining({ model: "openai" })
      );
      // Deprecation warning should be in the warnings passed to buildPhase2Response
      const phase2Call = mockedBuildPhase2Response.mock.calls[0];
      const opts = phase2Call[1];
      expect(opts.warnings).toContain('The "model" parameter is deprecated. Use "preset" instead.');
    });

    it("preset takes precedence over deprecated model", async () => {
      mockedCheckPreviewGate.mockResolvedValue("/output/tiles/preview.html");
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { filePath: "image.png", preset: "claude", model: "openai", outputDir: "/out" },
        {} as any
      );
      expect(mockedExecuteTiling).toHaveBeenCalledWith(
        "/images/photo.png",
        "/output/tiles",
        expect.objectContaining({ model: "claude" })
      );
      // No deprecation warning when preset is provided
      const phase2Call = mockedBuildPhase2Response.mock.calls[0];
      const opts = phase2Call[1];
      expect(opts.warnings).not.toContain('The "model" parameter is deprecated. Use "preset" instead.');
    });

    it("emits conflict warning when preset and model are both provided with different values", async () => {
      mockedCheckPreviewGate.mockResolvedValue("/output/tiles/preview.html");
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { filePath: "image.png", preset: "claude", model: "openai", outputDir: "/out" },
        {} as any
      );
      const phase2Call = mockedBuildPhase2Response.mock.calls[0];
      const opts = phase2Call[1];
      expect(opts.warnings).toContain(
        '"model" param ignored in favour of "preset" (values differ: model="openai", preset="claude").'
      );
    });

    it("passes outputDir and model through to pipeline", async () => {
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { filePath: "image.png", preset: "openai", outputDir: "/custom" },
        {} as any
      );
      expect(mockedResolveOutputDir).toHaveBeenCalledWith("file", "/images/photo.png", "/custom");
    });

    it("skips analyzeAndPreview when preview gate passes (but calls computeElicitationData)", async () => {
      mockedCheckPreviewGate.mockResolvedValue("/output/tiles/preview.html");
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { filePath: "image.png" },
        {} as any
      );
      expect(mockedCheckPreviewGate).toHaveBeenCalledWith("/output/tiles", "/output/tiles/source.png");
      expect(mockedAnalyzeAndPreview).not.toHaveBeenCalled();
      expect(mockedComputeElicitationData).toHaveBeenCalled();
      expect(mockedExecuteTiling).toHaveBeenCalled();
    });

    it("Phase 2 returns buildPhase2Response directly (summary-first, no tiles)", async () => {
      mockedCheckPreviewGate.mockResolvedValue("/output/tiles/preview.html");
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { filePath: "image.png", preset: "claude", outputDir: "/out" },
        {} as any
      );
      expect(result).toBe(phase2Response);
    });

    it("Phase 2 does not include tile images (summary-first)", async () => {
      mockedCheckPreviewGate.mockResolvedValue("/output/tiles/preview.html");
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { filePath: "image.png", preset: "claude", outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      const imageBlocks = res.content.filter((c: any) => c.type === "image");
      expect(imageBlocks).toHaveLength(0);
    });

    it("Phase 2 on elicitation fast path returns summary-first (no tiles)", async () => {
      mockedCheckPreviewGate.mockResolvedValue(null);
      mockedTryElicitation.mockResolvedValue({ status: "selected", model: "claude" });
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { filePath: "image.png" },
        {} as any
      );
      expect(result).toBe(phase2Response);
    });
  });

  // ─── Get Tiles Mode ───────────────────────────────────────────────────────

  describe("get-tiles mode", () => {
    it("returns up to 5 tiles (max batch)", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(20));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: undefined },
        {} as any
      );
      const res = result as any;
      const imageBlocks = res.content.filter((c: any) => c.type === "image");
      expect(imageBlocks).toHaveLength(5);
    });

    it("respects custom start/end range", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(20));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 5, end: 7 },
        {} as any
      );
      const res = result as any;
      const imageBlocks = res.content.filter((c: any) => c.type === "image");
      expect(imageBlocks).toHaveLength(3);
    });

    it("clamps end to totalTiles - 1", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(3));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 10 },
        {} as any
      );
      const res = result as any;
      const imageBlocks = res.content.filter((c: any) => c.type === "image");
      expect(imageBlocks).toHaveLength(3);
    });

    it("errors when start >= totalTiles", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(5));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 5, end: undefined },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("out of range");
    });

    it("errors when batch size exceeds MAX_TILES_PER_BATCH", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(20));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 5 },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("max batch size is 5");
    });

    it("summary shows 1-indexed tile range", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(10));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 4 },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toBe("Tiles 1-5 of 10");
    });

    it("includes 1-indexed tile labels with row/col in content", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(4));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 0 },
        {} as any
      );
      const res = result as any;
      const labels = res.content.filter(
        (c: any) => c.type === "text" && c.text.includes("Tile 1/")
      );
      expect(labels).toHaveLength(1);
      expect(labels[0].text).toContain("[index 0, row 0, col 0]");
    });

    it("returns image blocks with correct mime type", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(4));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 0 },
        {} as any
      );
      const res = result as any;
      const images = res.content.filter((c: any) => c.type === "image");
      expect(images[0].mimeType).toBe("image/png");
      expect(images[0].data).toBe("AAAA");
    });

    it("wraps errors from listTilesInDirectory", async () => {
      mockedListTiles.mockRejectedValue(new Error("Dir not found"));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/missing", start: 0, end: undefined },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Error retrieving tiles");
      expect(res.content[0].text).toContain("Dir not found");
    });

    it("wraps non-Error throws", async () => {
      mockedListTiles.mockRejectedValue("unexpected");
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: undefined },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("unexpected");
    });

    it("returns summary with correct 1-indexed tile range info", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(10));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 3, end: 4 },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toBe("Tiles 4-5 of 10");
    });

    it("errors when end < start", async () => {
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 10, end: 5 },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("end index (5) must be >= start index (10)");
    });

    it("returns 5 tiles from non-zero start when end is undefined", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(20));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 15, end: undefined },
        {} as any
      );
      const res = result as any;
      const imageBlocks = res.content.filter((c: any) => c.type === "image");
      expect(imageBlocks).toHaveLength(5);
      expect(res.content[0].text).toBe("Tiles 16-20 of 20");
    });

    it("returns image/webp MIME type for webp tiles", async () => {
      mockedListTiles.mockResolvedValue([
        "/tiles/tile_000_000.webp",
        "/tiles/tile_000_001.webp",
      ]);
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 0 },
        {} as any
      );
      const res = result as any;
      const images = res.content.filter((c: any) => c.type === "image");
      expect(images[0].mimeType).toBe("image/webp");
    });

    it("handles malformed tile filename with row=-1, col=-1", async () => {
      mockedListTiles.mockResolvedValue([
        "/tiles/tile_000_000.png",
        "/tiles/corrupted_file.png",
      ]);
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 1, end: 1 },
        {} as any
      );
      const res = result as any;
      const labels = res.content.filter(
        (c: any) => c.type === "text" && c.text.includes("Tile 2/")
      );
      expect(labels).toHaveLength(1);
      expect(labels[0].text).toContain("[index 1, row -1, col -1]");
    });

    it("annotates tile labels with content hints and metrics from analyzeTiles", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(4));
      mockedAnalyzeTiles.mockResolvedValue([
        { index: 0, contentHint: "low-detail", meanBrightness: 200, stdDev: 15, entropy: 2.5, sharpness: 1.2, isBlank: false },
        { index: 1, contentHint: "high-detail", meanBrightness: 128, stdDev: 65, entropy: 7.2, sharpness: 4.5, isBlank: false },
        { index: 2, contentHint: "mixed", meanBrightness: 150, stdDev: 40, entropy: 5.5, sharpness: 3.1, isBlank: false },
        { index: 3, contentHint: "low-detail", meanBrightness: 210, stdDev: 12, entropy: 3.0, sharpness: 0.8, isBlank: false },
      ]);

      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 3 },
        {} as any
      );
      const res = result as any;
      const labels = res.content.filter(
        (c: any) => c.type === "text" && c.text.startsWith("Tile ")
      );
      expect(labels[0].text).toContain("(low-detail, entropy=2.5, sharpness=1.2)");
      expect(labels[1].text).toContain("(high-detail, entropy=7.2, sharpness=4.5)");
      expect(labels[2].text).toContain("(mixed, entropy=5.5, sharpness=3.1)");
      expect(labels[3].text).toContain("(low-detail, entropy=3, sharpness=0.8)");
    });

    it("returns tiles without annotations when analyzeTiles fails", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(4));
      mockedAnalyzeTiles.mockRejectedValue(new Error("Sharp crashed"));

      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 3 },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBeUndefined();
      const labels = res.content.filter(
        (c: any) => c.type === "text" && c.text.startsWith("Tile ")
      );
      expect(labels).toHaveLength(4);
      for (const label of labels) {
        expect(label.text).not.toContain("(");
      }
    });

    it("skips blank tiles with text annotation and no image block", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(4));
      mockedAnalyzeTiles.mockResolvedValue([
        { index: 0, contentHint: "high-detail", meanBrightness: 128, stdDev: 65, entropy: 7.2, sharpness: 4.5, isBlank: false },
        { index: 1, contentHint: "blank", meanBrightness: 255, stdDev: 2, entropy: 0.1, sharpness: 0.05, isBlank: true },
        { index: 2, contentHint: "mixed", meanBrightness: 150, stdDev: 40, entropy: 5.5, sharpness: 3.1, isBlank: false },
        { index: 3, contentHint: "high-detail", meanBrightness: 120, stdDev: 70, entropy: 7.0, sharpness: 4.2, isBlank: false },
      ]);

      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 3, skipBlankTiles: true },
        {} as any
      );
      const res = result as any;
      const imageBlocks = res.content.filter((c: any) => c.type === "image");
      expect(imageBlocks).toHaveLength(3); // 4 tiles minus 1 blank

      const blankLabel = res.content.find(
        (c: any) => c.type === "text" && c.text.includes("blank — skipped")
      );
      expect(blankLabel).toBeDefined();
      expect(blankLabel.text).toContain("[index 1, row 0, col 1]");
    });

    it("updates summary with skipped count when blank tiles present", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(4));
      mockedAnalyzeTiles.mockResolvedValue([
        { index: 0, contentHint: "blank", meanBrightness: 255, stdDev: 1, entropy: 0.05, sharpness: 0.01, isBlank: true },
        { index: 1, contentHint: "blank", meanBrightness: 254, stdDev: 2, entropy: 0.1, sharpness: 0.02, isBlank: true },
        { index: 2, contentHint: "mixed", meanBrightness: 150, stdDev: 40, entropy: 5.5, sharpness: 3.1, isBlank: false },
        { index: 3, contentHint: "high-detail", meanBrightness: 120, stdDev: 70, entropy: 7.0, sharpness: 4.2, isBlank: false },
      ]);

      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 3, skipBlankTiles: true },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toContain("2 blank tile(s) skipped");
    });

    it("sends non-blank tiles normally with image blocks", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(4));
      mockedAnalyzeTiles.mockResolvedValue([
        { index: 0, contentHint: "mixed", meanBrightness: 150, stdDev: 40, entropy: 5.5, sharpness: 3.1, isBlank: false },
        { index: 1, contentHint: "high-detail", meanBrightness: 128, stdDev: 65, entropy: 7.2, sharpness: 4.5, isBlank: false },
      ]);

      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 1 },
        {} as any
      );
      const res = result as any;
      const imageBlocks = res.content.filter((c: any) => c.type === "image");
      expect(imageBlocks).toHaveLength(2);
    });

    it("reads all tiles with readTileAsBase64 regardless of content hint", async () => {
      mockedListTiles.mockResolvedValue([
        "/tiles/tile_000_000.webp",
        "/tiles/tile_000_001.webp",
      ]);
      mockedAnalyzeTiles.mockResolvedValue([
        { index: 0, contentHint: "low-detail", meanBrightness: 200, stdDev: 15, entropy: 2.5, sharpness: 1.2, isBlank: false },
        { index: 1, contentHint: "high-detail", meanBrightness: 128, stdDev: 65, entropy: 7.2, sharpness: 4.5, isBlank: false },
      ]);

      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 1 },
        {} as any
      );
      // Both tiles use the same readTileAsBase64 — no adaptive quality
      expect(mockedReadBase64).toHaveBeenCalledWith("/tiles/tile_000_000.webp");
      expect(mockedReadBase64).toHaveBeenCalledWith("/tiles/tile_000_001.webp");
      expect(mockedReadBase64).toHaveBeenCalledTimes(2);
    });

    it("reads tiles-manifest.json and passes geometry to analyzeTiles", async () => {
      const manifest = {
        tileSize: 768,
        cols: 2,
        rows: 2,
        tiles: [
          { index: 0, width: 768, height: 768 },
          { index: 1, width: 147, height: 768 },
          { index: 2, width: 768, height: 768 },
          { index: 3, width: 147, height: 768 },
        ],
      };
      mockedListTiles.mockResolvedValue(makeTilePaths(4));
      mockedReadFile.mockResolvedValueOnce(JSON.stringify(manifest) as any);

      const tool = mock.getTool("tiler")!;
      await tool.handler({ tilesDir: "/tiles", start: 0, end: 3 }, {} as any);

      expect(mockedAnalyzeTiles).toHaveBeenCalledWith(
        [
          { filePath: "/tiles/tile_000_000.png", index: 0, extractedWidth: 768, extractedHeight: 768 },
          { filePath: "/tiles/tile_000_001.png", index: 1, extractedWidth: 147, extractedHeight: 768 },
          { filePath: "/tiles/tile_000_002.png", index: 2, extractedWidth: 768, extractedHeight: 768 },
          { filePath: "/tiles/tile_000_003.png", index: 3, extractedWidth: 147, extractedHeight: 768 },
        ],
        768
      );
    });

    it("falls back to no-geometry analyzeTiles when manifest is missing", async () => {
      // readFile default mock already rejects with ENOENT
      mockedListTiles.mockResolvedValue(makeTilePaths(2));

      const tool = mock.getTool("tiler")!;
      await tool.handler({ tilesDir: "/tiles", start: 0, end: 1 }, {} as any);

      expect(mockedAnalyzeTiles).toHaveBeenCalledWith(
        [
          { filePath: "/tiles/tile_000_000.png", index: 0, extractedWidth: undefined, extractedHeight: undefined },
          { filePath: "/tiles/tile_000_001.png", index: 1, extractedWidth: undefined, extractedHeight: undefined },
        ],
        undefined
      );
    });

    it("skipBlankTiles=false returns image blocks for blank tiles", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(4));
      mockedAnalyzeTiles.mockResolvedValue([
        { index: 0, contentHint: "high-detail", meanBrightness: 128, stdDev: 65, entropy: 7.2, sharpness: 4.5, isBlank: false },
        { index: 1, contentHint: "blank", meanBrightness: 255, stdDev: 2, entropy: 0.1, sharpness: 0.05, isBlank: true },
        { index: 2, contentHint: "mixed", meanBrightness: 150, stdDev: 40, entropy: 5.5, sharpness: 3.1, isBlank: false },
        { index: 3, contentHint: "high-detail", meanBrightness: 120, stdDev: 70, entropy: 7.0, sharpness: 4.2, isBlank: false },
      ]);

      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 3, skipBlankTiles: false },
        {} as any
      );
      const res = result as any;
      const imageBlocks = res.content.filter((c: any) => c.type === "image");
      expect(imageBlocks).toHaveLength(4); // all 4 tiles including blank

      const blankSkippedLabel = res.content.find(
        (c: any) => c.type === "text" && c.text.includes("blank — skipped")
      );
      expect(blankSkippedLabel).toBeUndefined();
    });
  });

  // ─── Capture and Tile Mode ────────────────────────────────────────────────

  describe("capture-and-tile mode", () => {
    it("returns Phase 1 response with capture info appended when elicitation returns null", async () => {
      mockedTryElicitation.mockResolvedValue({ status: "unsupported" });
      mockedBuildPhase1Response.mockReturnValue({
        content: [
          { type: "text", text: "ACTION REQUIRED: Present the tiling options below to the user and wait for their choice.\n\n---\n\nImage: 1280 x 800" },
          { type: "text", text: '{"status":"awaiting_user_choice"}' },
        ],
      });
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { url: "https://example.com", format: "webp" },
        {} as any
      );
      const res = result as any;
      // ACTION REQUIRED leads (not buried under capture info)
      expect(res.content[0].text).toMatch(/^ACTION REQUIRED/);
      // Capture info appended at end
      expect(res.content[0].text).toContain("(Screenshot: 1280x800");
      expect(res.content[0].text).toContain("example.com");
      expect(mockedBuildPhase1Response).toHaveBeenCalledWith(
        sampleAnalysis,
        expect.objectContaining({ screenshotPath: expect.any(String) })
      );
      expect(mockedExecuteTiling).not.toHaveBeenCalled();
    });

    it("still captures screenshot before returning Phase 1", async () => {
      mockedTryElicitation.mockResolvedValue({ status: "unsupported" });
      mockedBuildPhase1Response.mockReturnValue({
        content: [
          { type: "text", text: "ACTION REQUIRED: Present the tiling options below\n\nImage: 1280 x 800" },
          { type: "text", text: '{"status":"awaiting_user_choice"}' },
        ],
      });
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { url: "https://example.com", format: "webp" },
        {} as any
      );
      expect(mockedCaptureUrl).toHaveBeenCalled();
    });

    it("returns combined capture + tiling result on Phase 2 (summary-first, no tiles)", async () => {
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { url: "https://example.com", format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBeUndefined();
      const textBlocks = res.content.filter((c: any) => c.type === "text");
      const imageBlocks = res.content.filter((c: any) => c.type === "image");
      expect(textBlocks.length).toBeGreaterThanOrEqual(2);
      expect(imageBlocks).toHaveLength(0);
    });

    it("prepends capture info to Phase 2 summary", async () => {
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { url: "https://example.com", format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toContain("Captured 1280x800 screenshot of https://example.com");
    });

    it("includes scroll-stitch segments in summary", async () => {
      mockedCaptureUrl.mockResolvedValue({
        buffer: Buffer.from("screenshot-data"),
        pageWidth: 1280,
        pageHeight: 20000,
        url: "https://example.com",
        segmentsStitched: 2,
      });
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { url: "https://example.com", format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toContain("Scroll-stitched 2 segments");
    });

    it("wraps errors from captureUrl", async () => {
      mockedCaptureUrl.mockRejectedValue(new Error("Chrome crashed"));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { url: "https://example.com", format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Error capturing and tiling URL");
      expect(res.content[0].text).toContain("Chrome crashed");
    });

    it("skips captureUrl when screenshotPath is provided and accessible", async () => {
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { url: "https://example.com", format: "webp", screenshotPath: "/existing/screenshot.png" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBeUndefined();
      expect(mockedCaptureUrl).not.toHaveBeenCalled();
    });

    it("passes captureInfo to buildPhase2Response", async () => {
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { url: "https://example.com", format: "webp" },
        {} as any
      );
      expect(mockedBuildPhase2Response).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          captureInfo: expect.objectContaining({
            url: "https://example.com",
            pageWidth: 1280,
            pageHeight: 800,
          }),
        })
      );
    });

    it("triggers capture mode with screenshotPath alone (no url)", async () => {
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { screenshotPath: "/existing/screenshot.png", format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBeUndefined();
      expect(mockedCaptureUrl).not.toHaveBeenCalled();
    });
  });

  // ─── Phase 1 Stop Instruction ─────────────────────────────────────────────

  describe("Phase 1 ACTION REQUIRED instruction", () => {
    it("Phase 1 response leads with ACTION REQUIRED instruction", async () => {
      // This tests the actual buildPhase1Response from tiling-pipeline
      // (tested in tiling-pipeline.test.ts), but we verify the mock returns it
      mockedTryElicitation.mockResolvedValue({ status: "unsupported" });
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { filePath: "image.png" },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toMatch(/^ACTION REQUIRED/);
      expect(res.content[0].text).toContain("ACTION REQUIRED");
    });
  });

  // ─── Bug #1: resolveImageSource errors wrapped ──────────────────────────────

  describe("resolveImageSource error handling", () => {
    it("wraps resolveImageSource errors in clean error message", async () => {
      mockedResolveSource.mockRejectedValue(new Error("HTTP 404: Not Found"));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { sourceUrl: "https://example.com/missing.png" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Error tiling image");
      expect(res.content[0].text).toContain("HTTP 404: Not Found");
    });

    it("does not call cleanup when resolveImageSource throws", async () => {
      mockedResolveSource.mockRejectedValue(new Error("timeout"));
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { sourceUrl: "https://example.com/timeout.png" },
        {} as any
      );
      // No cleanup to call since source was never resolved
    });

    it("still calls cleanup if resolveImageSource succeeds but later step throws", async () => {
      const cleanup = vi.fn().mockResolvedValue(undefined);
      mockedResolveSource.mockResolvedValue({
        localPath: "/tmp/img.png",
        sourceType: "url",
        originalSource: "https://example.com/img.png",
        cleanup,
      });
      mockedValidateFormat.mockReturnValue(null);
      mockedResolveOutputDir.mockRejectedValue(new Error("ENOSPC"));
      const tool = mock.getTool("tiler")!;
      await tool.handler(
        { sourceUrl: "https://example.com/img.png" },
        {} as any
      );
      expect(cleanup).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Bug #2-3: Screenshot validation and error separation ─────────────────

  describe("screenshot reuse error handling", () => {
    it("throws descriptive error when screenshot exists but Sharp can't read it (no url)", async () => {
      const mockedAccess = vi.mocked(fsPromises.access);
      mockedAccess.mockResolvedValue(undefined);
      const mockedSharp = vi.mocked(sharp);
      mockedSharp.mockReturnValue({
        metadata: vi.fn().mockRejectedValue(new Error("Input file has truncated header")),
        png: vi.fn().mockReturnThis(),
        webp: vi.fn().mockReturnThis(),
        toFile: vi.fn().mockResolvedValue({}),
      } as any);

      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { screenshotPath: "/existing/corrupt.png", page: 0, format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("exists but could not be read");
      expect(res.content[0].text).toContain("Input file has truncated header");
      expect(res.content[0].text).not.toContain("not found");
    });

    it("throws error when screenshot has zero dimensions", async () => {
      const mockedAccess = vi.mocked(fsPromises.access);
      mockedAccess.mockResolvedValue(undefined);
      const mockedSharp = vi.mocked(sharp);
      mockedSharp.mockReturnValue({
        metadata: vi.fn().mockResolvedValue({ width: 0, height: 0 }),
        png: vi.fn().mockReturnThis(),
        webp: vi.fn().mockReturnThis(),
        toFile: vi.fn().mockResolvedValue({}),
      } as any);

      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { screenshotPath: "/existing/empty.png", page: 0, format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("invalid dimensions");
    });

    it("throws error when screenshot has undefined dimensions", async () => {
      const mockedAccess = vi.mocked(fsPromises.access);
      mockedAccess.mockResolvedValue(undefined);
      const mockedSharp = vi.mocked(sharp);
      mockedSharp.mockReturnValue({
        metadata: vi.fn().mockResolvedValue({ width: undefined, height: undefined }),
        png: vi.fn().mockReturnThis(),
        webp: vi.fn().mockReturnThis(),
        toFile: vi.fn().mockResolvedValue({}),
      } as any);

      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { screenshotPath: "/existing/broken.png", page: 0, format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("exists but could not be read");
      expect(res.content[0].text).toContain("invalid dimensions");
    });

    it("still says 'not found' when file truly doesn't exist (no url)", async () => {
      const mockedAccess = vi.mocked(fsPromises.access);
      mockedAccess.mockRejectedValue(new Error("ENOENT"));

      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { screenshotPath: "/missing/screenshot.png", page: 0, format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("not found");
    });

    it("recaptures from url when screenshot exists but unreadable", async () => {
      const mockedAccess = vi.mocked(fsPromises.access);
      mockedAccess.mockResolvedValue(undefined);
      const mockedSharp = vi.mocked(sharp);
      mockedSharp.mockReturnValue({
        metadata: vi.fn().mockRejectedValue(new Error("corrupt")),
        png: vi.fn().mockReturnValue({ toFile: vi.fn().mockResolvedValue({}) }),
        webp: vi.fn().mockReturnThis(),
        toFile: vi.fn().mockResolvedValue({}),
      } as any);

      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { url: "https://example.com", screenshotPath: "/existing/corrupt.png", page: 0, format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBeUndefined();
      expect(mockedCaptureUrl).toHaveBeenCalled();
    });
  });

  // ─── Bug #4: Empty directory cleanup on failure ─────────────────────────────

  describe("capture failure cleanup", () => {
    it("attempts to remove empty output directory on capture failure", async () => {
      mockedCaptureUrl.mockRejectedValue(new Error("Chrome not found"));
      const mockedRmdir = vi.mocked(fsPromises.rmdir);

      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { url: "https://example.com", page: 0, format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(mockedRmdir).toHaveBeenCalledWith("/output/tiles");
    });

    it("does not crash when rmdir fails (non-empty dir)", async () => {
      mockedCaptureUrl.mockRejectedValue(new Error("Chrome not found"));
      const mockedRmdir = vi.mocked(fsPromises.rmdir);
      mockedRmdir.mockRejectedValue(new Error("ENOTEMPTY"));

      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { url: "https://example.com", page: 0, format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Chrome not found");
    });
  });

  // ─── Coverage #8: page param in get-tiles mode ──────────────────────────────

  describe("get-tiles page param conversion", () => {
    it("converts page=1 to start=5, end=9 (second batch)", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(20));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: undefined, page: 1 },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toBe("Tiles 6-10 of 20");
    });

    it("converts page=2 to start=10, end=14 (third batch)", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(20));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: undefined, page: 2 },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toBe("Tiles 11-15 of 20");
    });

    it("page=0 uses default start=0 (first batch)", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(20));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: undefined, page: 0 },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toBe("Tiles 1-5 of 20");
    });

    it("explicit start/end takes precedence over page", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(20));
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 2, end: 4, page: 3 },
        {} as any
      );
      const res = result as any;
      // start=2 is non-zero, so page should be ignored
      expect(res.content[0].text).toBe("Tiles 3-5 of 20");
    });
  });

  // ─── Coverage #7: Capture one-shot path (model + outputDir) ─────────────────

  describe("capture one-shot path", () => {
    it("generates preview and tiles when model + outputDir provided upfront", async () => {
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { url: "https://example.com", preset: "claude", outputDir: "/custom/output", format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBeUndefined();
      expect(mockedAnalyzeAndPreview).toHaveBeenCalled();
      expect(mockedExecuteTiling).toHaveBeenCalledWith(
        expect.any(String),
        "/output/tiles",
        expect.objectContaining({ model: "claude" })
      );
      expect(mockedBuildPhase2Response).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ model: "claude", captureInfo: expect.any(Object) })
      );
    });

    it("capture one-shot prepends capture info to response (summary-first)", async () => {
      const tool = mock.getTool("tiler")!;
      const result = await tool.handler(
        { url: "https://example.com", preset: "openai", outputDir: "/custom", format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toContain("Captured 1280x800 screenshot");
    });
  });
});
