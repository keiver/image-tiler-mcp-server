import * as path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TileImageResult, TileMetadata } from "../types.js";

vi.mock("../services/image-processor.js", () => ({
  tileImage: vi.fn(),
  computeEstimateForModel: vi.fn(),
}));

vi.mock("../services/interactive-preview-generator.js", () => ({
  generateInteractivePreview: vi.fn(),
}));

vi.mock("../services/image-source-resolver.js", () => ({
  resolveImageSource: vi.fn(),
}));

vi.mock("../services/tile-analyzer.js", () => ({
  analyzeTiles: vi.fn(),
}));

vi.mock("../utils.js", () => ({
  getDefaultOutputBase: vi.fn().mockReturnValue("/Users/test/Desktop"),
  escapeHtml: vi.fn((s: string) => s),
  getVersionedOutputDir: vi.fn(async (baseDir: string) => `${baseDir}_v1`),
}));

vi.mock("node:fs/promises", () => ({
  copyFile: vi.fn(),
}));

import { tileImage, computeEstimateForModel } from "../services/image-processor.js";
import { generateInteractivePreview } from "../services/interactive-preview-generator.js";
import { resolveImageSource } from "../services/image-source-resolver.js";
import { analyzeTiles } from "../services/tile-analyzer.js";
import { registerTileImageTool } from "../tools/tile-image.js";
import { createMockServer } from "./helpers/mock-server.js";

const mockedTileImage = vi.mocked(tileImage);
const mockedGeneratePreview = vi.mocked(generateInteractivePreview);
const mockedComputeEstimate = vi.mocked(computeEstimateForModel);
const mockedResolveSource = vi.mocked(resolveImageSource);
const mockedAnalyzeTiles = vi.mocked(analyzeTiles);

function makeTileResult(overrides?: Partial<TileImageResult>): TileImageResult {
  return {
    sourceImage: {
      width: 2144,
      height: 2144,
      format: "png",
      fileSize: 50000,
      channels: 4,
    },
    grid: {
      cols: 2,
      rows: 2,
      totalTiles: 4,
      tileSize: 1092,
      estimatedTokens: 6360,
    },
    outputDir: "/output/tiles",
    tiles: [
      { index: 0, row: 0, col: 0, x: 0, y: 0, width: 1092, height: 1092, filename: "tile_000_000.png", filePath: "/output/tiles/tile_000_000.png" },
      { index: 1, row: 0, col: 1, x: 1092, y: 0, width: 1092, height: 1092, filename: "tile_000_001.png", filePath: "/output/tiles/tile_000_001.png" },
      { index: 2, row: 1, col: 0, x: 0, y: 1092, width: 1092, height: 1092, filename: "tile_001_000.png", filePath: "/output/tiles/tile_001_000.png" },
      { index: 3, row: 1, col: 1, x: 1092, y: 1092, width: 1092, height: 1092, filename: "tile_001_001.png", filePath: "/output/tiles/tile_001_001.png" },
    ],
    ...overrides,
  };
}

describe("registerTileImageTool", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGeneratePreview.mockResolvedValue("/output/tiles/image-preview.html");
    mockedComputeEstimate.mockReturnValue({
      model: "claude", label: "Claude", tileSize: 1092, cols: 2, rows: 2, tiles: 4, tokens: 6360,
    });
    // Default: resolveImageSource passes through filePath as-is for file sources
    mockedResolveSource.mockImplementation(async (params) => ({
      localPath: params.filePath ?? "/tmp/resolved.png",
      sourceType: "file",
      originalSource: params.filePath ?? "unknown",
    }));
    mock = createMockServer();
    registerTileImageTool(mock.server as any);
  });

  it("registers the tool with correct name", () => {
    expect(mock.server.registerTool).toHaveBeenCalledWith(
      "tiler_tile_image",
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("returns error when no source provided", async () => {
    const tool = mock.getTool("tiler_tile_image")!;
    const result = await tool.handler(
      { model: "claude", tileSize: undefined, outputDir: undefined },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No image source provided");
  });

  it("rejects unsupported image format", async () => {
    const tool = mock.getTool("tiler_tile_image")!;
    const result = await tool.handler(
      { filePath: "test.bmp", model: "claude", tileSize: undefined, outputDir: undefined },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unsupported image format");
    expect(res.content[0].text).toContain(".bmp");
  });

  it("allows files with no extension", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    const tool = mock.getTool("tiler_tile_image")!;
    const result = await tool.handler(
      { filePath: "imagefile", model: "claude", tileSize: undefined, outputDir: "/out" },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBeUndefined();
  });

  it("defaults outputDir to versioned tiles subfolder next to source", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    const tool = mock.getTool("tiler_tile_image")!;
    await tool.handler(
      { filePath: "/images/photo.png", model: "claude", tileSize: undefined, outputDir: undefined },
      {} as any
    );
    expect(mockedTileImage).toHaveBeenCalledWith(
      "/images/photo.png",
      1092,
      expect.stringContaining(path.join("tiles", "photo") + "_v1"),
      1590,
      undefined,
      1568,
      undefined
    );
  });

  it("uses custom outputDir when provided", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    const tool = mock.getTool("tiler_tile_image")!;
    await tool.handler(
      { filePath: "image.png", model: "claude", tileSize: 1072, outputDir: "/custom/dir" },
      {} as any
    );
    expect(mockedTileImage).toHaveBeenCalledWith("image.png", 1072, "/custom/dir", 1590, undefined, 1568, undefined);
  });

  it("returns summary, structured JSON, and preview block on success", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    const tool = mock.getTool("tiler_tile_image")!;
    const result = await tool.handler(
      { filePath: "image.png", model: "claude", tileSize: 1072, outputDir: "/out" },
      {} as any
    );
    const res = result as any;
    // summary + JSON + preview block = 3
    expect(res.content).toHaveLength(3);
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("2×2 grid");
    expect(res.content[0].text).toContain("4 tiles");

    const json = JSON.parse(res.content[1].text);
    expect(json.grid.totalTiles).toBe(4);
    expect(json.tiles).toHaveLength(4);

    // Separate preview block
    expect(res.content[2].type).toBe("text");
    expect(res.content[2].text).toMatch(/^Preview: /);
    expect(res.content[2].text).toContain("/output/tiles/image-preview.html");
  });

  it("includes pagination hint in summary", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    const tool = mock.getTool("tiler_tile_image")!;
    const result = await tool.handler(
      { filePath: "image.png", model: "claude", tileSize: 1072, outputDir: "/out" },
      {} as any
    );
    const res = result as any;
    expect(res.content[0].text).toContain("tiler_get_tiles");
  });

  it("wraps errors from tileImage", async () => {
    mockedTileImage.mockRejectedValue(new Error("Sharp failed"));
    const tool = mock.getTool("tiler_tile_image")!;
    const result = await tool.handler(
      { filePath: "bad.png", model: "claude", tileSize: 1072, outputDir: "/out" },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Error tiling image");
    expect(res.content[0].text).toContain("Sharp failed");
  });

  it("wraps non-Error throws", async () => {
    mockedTileImage.mockRejectedValue("string error");
    const tool = mock.getTool("tiler_tile_image")!;
    const result = await tool.handler(
      { filePath: "bad.png", model: "claude", tileSize: 1072, outputDir: "/out" },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("string error");
  });

  it("structured output includes tile positions as strings", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    const tool = mock.getTool("tiler_tile_image")!;
    const result = await tool.handler(
      { filePath: "image.png", model: "claude", tileSize: 1072, outputDir: "/out" },
      {} as any
    );
    const res = result as any;
    const json = JSON.parse(res.content[1].text);
    expect(json.tiles[0].position).toBe("0,0");
    expect(json.tiles[0].dimensions).toBe("1092×1092");
  });

  it("rejects svg format", async () => {
    const tool = mock.getTool("tiler_tile_image")!;
    const result = await tool.handler(
      { filePath: "diagram.svg", model: "claude", tileSize: undefined, outputDir: undefined },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unsupported image format");
  });

  describe("image source resolution", () => {
    it("calls resolveImageSource with all source params", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", sourceUrl: "https://example.com/img.png", model: "claude", outputDir: "/out" },
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
      mockedTileImage.mockResolvedValue(makeTileResult());

      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { sourceUrl: "https://example.com/img.png", model: "claude", outputDir: "/out" },
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
      mockedTileImage.mockRejectedValue(new Error("fail"));

      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { sourceUrl: "https://example.com/img.png", model: "claude", outputDir: "/out" },
        {} as any
      );
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("uses cwd-based outputDir for non-file sources when no outputDir given", async () => {
      mockedResolveSource.mockResolvedValue({
        localPath: "/tmp/from-url.png",
        sourceType: "url",
        originalSource: "https://example.com/img.png",
      });
      mockedTileImage.mockResolvedValue(makeTileResult());

      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { sourceUrl: "https://example.com/img.png", model: "claude" },
        {} as any
      );
      const callArgs = mockedTileImage.mock.calls[0];
      // outputDir should contain "tiles/tiled_" prefix
      expect(callArgs[2]).toMatch(/tiles[\\/]tiled_\d+/);
    });
  });

  describe("model support", () => {
    it("defaults to claude tile size (1092) when tileSize is undefined", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 1092, "/out", 1590, undefined, 1568, undefined);
    });

    it("uses openai defaults (768px, 765 tokens/tile)", async () => {
      mockedTileImage.mockResolvedValue(
        makeTileResult({ grid: { cols: 3, rows: 3, totalTiles: 9, tileSize: 768, estimatedTokens: 9 * 765 } })
      );
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "openai", tileSize: undefined, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 768, "/out", 765, undefined, 2048, undefined);
    });

    it("uses gemini defaults (768px, 258 tokens/tile)", async () => {
      mockedTileImage.mockResolvedValue(
        makeTileResult({ grid: { cols: 3, rows: 3, totalTiles: 9, tileSize: 768, estimatedTokens: 9 * 258 } })
      );
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "gemini", tileSize: undefined, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 768, "/out", 258, undefined, 768, undefined);
    });

    it("includes model in structured output", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "openai", tileSize: 768, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      const json = JSON.parse(res.content[1].text);
      expect(json.model).toBe("openai");
    });

    it("summary mentions model label", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "gemini", tileSize: 768, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toContain("for Gemini");
    });

    it("summary mentions Claude label by default", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toContain("for Claude");
    });

    it("uses gemini3 defaults (1536px, 1120 tokens/tile)", async () => {
      mockedTileImage.mockResolvedValue(
        makeTileResult({ grid: { cols: 2, rows: 2, totalTiles: 4, tileSize: 1536, estimatedTokens: 4 * 1120 } })
      );
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "gemini3", tileSize: undefined, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 1536, "/out", 1120, undefined, 3072, undefined);
    });

    it("summary mentions Gemini 3 label", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "gemini3", tileSize: 1536, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toContain("for Gemini 3");
    });
  });

  describe("tile size clamping", () => {
    it("clamps tileSize above claude max (1568) with warning", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: 2000, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 1568, "/out", 1590, undefined, 1568, undefined);

      const res = result as any;
      expect(res.content[0].text).toContain("2000px exceeds");
      expect(res.content[0].text).toContain("clamped to 1568px");

      const json = JSON.parse(res.content[1].text);
      expect(json.warnings).toBeDefined();
      expect(json.warnings).toHaveLength(1);
      expect(json.warnings[0]).toContain("clamped");
    });

    it("does not clamp tileSize of 2000 for openai (max 2048)", async () => {
      mockedTileImage.mockResolvedValue(
        makeTileResult({ grid: { cols: 2, rows: 2, totalTiles: 4, tileSize: 2000, estimatedTokens: 4 * 765 } })
      );
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "openai", tileSize: 2000, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 2000, "/out", 765, undefined, 2048, undefined);

      const res = result as any;
      const json = JSON.parse(res.content[1].text);
      expect(json.warnings).toBeUndefined();
    });

    it("clamps tileSize above openai max (2048) with warning", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "openai", tileSize: 2500, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 2048, "/out", 765, undefined, 2048, undefined);
    });

    it("no warnings when tileSize is within model bounds", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: 800, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      const json = JSON.parse(res.content[1].text);
      expect(json.warnings).toBeUndefined();
      expect(res.content[0].text).not.toContain("clamped");
    });

    it("respects explicit tileSize when within model bounds", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "openai", tileSize: 512, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 512, "/out", 765, undefined, 2048, undefined);
    });

    it("clamps tileSize above gemini max (768) with warning", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "gemini", tileSize: 1000, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 768, "/out", 258, undefined, 768, undefined);

      const res = result as any;
      expect(res.content[0].text).toContain("1000px exceeds");
      expect(res.content[0].text).toContain("clamped to 768px");
    });

    it("clamps tileSize above gemini3 max (3072) with warning", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "gemini3", tileSize: 4000, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 3072, "/out", 1120, undefined, 3072, undefined);

      const res = result as any;
      expect(res.content[0].text).toContain("4000px exceeds");
      expect(res.content[0].text).toContain("clamped to 3072px");
    });

    it("clamps tileSize below claude min (256) with warning", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: 100, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 256, "/out", 1590, undefined, 1568, undefined);

      const res = result as any;
      expect(res.content[0].text).toContain("100px is below minimum");
      expect(res.content[0].text).toContain("clamped to 256px");

      const json = JSON.parse(res.content[1].text);
      expect(json.warnings).toBeDefined();
      expect(json.warnings).toHaveLength(1);
      expect(json.warnings[0]).toContain("clamped");
    });

    it("clamps tileSize below gemini3 min (384) with warning", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "gemini3", tileSize: 300, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 384, "/out", 1120, undefined, 3072, undefined);

      const res = result as any;
      expect(res.content[0].text).toContain("300px is below minimum");
      expect(res.content[0].text).toContain("clamped to 384px");

      const json = JSON.parse(res.content[1].text);
      expect(json.warnings).toBeDefined();
      expect(json.warnings).toHaveLength(1);
      expect(json.warnings[0]).toContain("clamped");
    });
  });

  describe("maxDimension", () => {
    it("passes maxDimension through to tileImage", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, maxDimension: 2048, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith(
        "image.png",
        1092,
        "/out",
        1590,
        2048,
        1568,
        undefined
      );
    });

    it("passes undefined to tileImage when maxDimension is 0 (disabled)", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, maxDimension: 0, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith(
        "image.png",
        1092,
        "/out",
        1590,
        undefined,
        1568,
        undefined
      );
    });

    it("passes default maxDimension (10000) through to tileImage", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, maxDimension: 10000, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith(
        "image.png",
        1092,
        "/out",
        1590,
        10000,
        1568,
        undefined
      );
    });

    it("includes resize info in summary when resize occurred", async () => {
      mockedTileImage.mockResolvedValue(
        makeTileResult({
          resize: {
            originalWidth: 7680,
            originalHeight: 4032,
            resizedWidth: 2048,
            resizedHeight: 1076,
            scaleFactor: 0.267,
          },
        })
      );
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, maxDimension: 2048, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toContain("Downscaled from 7680×4032");
      expect(res.content[0].text).toContain("2048×1076");
      expect(res.content[0].text).toContain("0.267x");
    });

    it("includes resize in structured JSON when resize occurred", async () => {
      const resizeInfo = {
        originalWidth: 7680,
        originalHeight: 4032,
        resizedWidth: 2048,
        resizedHeight: 1076,
        scaleFactor: 0.267,
      };
      mockedTileImage.mockResolvedValue(makeTileResult({ resize: resizeInfo }));
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, maxDimension: 2048, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      const json = JSON.parse(res.content[1].text);
      expect(json.resize).toEqual(resizeInfo);
    });

    it("does not include resize info when no resize occurred", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, maxDimension: 2048, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).not.toContain("Downscaled");
      const json = JSON.parse(res.content[1].text);
      expect(json.resize).toBeUndefined();
    });
  });

  describe("preview generation", () => {
    it("includes previewPath in structured JSON when preview succeeds", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      mockedGeneratePreview.mockResolvedValue("/output/tiles/image-preview.html");
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      const json = JSON.parse(res.content[1].text);
      expect(json.previewPath).toBe("/output/tiles/image-preview.html");
    });

    it("preview is a separate content block (not in summary)", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      mockedGeneratePreview.mockResolvedValue("/output/tiles/image-preview.html");
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      // Summary should NOT contain the preview (it's in a separate block)
      expect(res.content[0].text).not.toContain("image-preview.html");
      // Separate preview block should exist
      const previewBlock = res.content.find(
        (c: any) => c.type === "text" && c.text.startsWith("Preview: ")
      );
      expect(previewBlock).toBeDefined();
      expect(previewBlock.text).toContain("image-preview.html");
    });

    it("tiling succeeds when preview generation throws", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      mockedGeneratePreview.mockRejectedValue(new Error("Write permission denied"));
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBeUndefined();
      expect(res.content).toHaveLength(2);
      const json = JSON.parse(res.content[1].text);
      expect(json.previewPath).toBeUndefined();
      expect(json.warnings).toBeDefined();
      expect(json.warnings).toContainEqual(expect.stringContaining("Preview generation failed"));
      expect(json.warnings).toContainEqual(expect.stringContaining("Write permission denied"));
    });

    it("no preview block when generation fails", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      mockedGeneratePreview.mockRejectedValue(new Error("fail"));
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      expect(res.content).toHaveLength(2); // summary + JSON only
      const previewBlock = res.content.find(
        (c: any) => c.type === "text" && c.text.startsWith("Preview: ")
      );
      expect(previewBlock).toBeUndefined();
    });

    it("calls generateInteractivePreview with correct arguments", async () => {
      const tileResult = makeTileResult();
      mockedTileImage.mockResolvedValue(tileResult);
      mockedGeneratePreview.mockResolvedValue("/output/tiles/image-preview.html");
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "openai", tileSize: 768, outputDir: "/out" },
        {} as any
      );
      expect(mockedGeneratePreview).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceImagePath: "image.png",
          effectiveWidth: 2144,
          effectiveHeight: 2144,
          recommendedModel: "openai",
        }),
        "/output/tiles"
      );
    });
  });

  describe("includeMetadata", () => {
    it("calls analyzeTiles when includeMetadata is true", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const mockMetadata: TileMetadata[] = [
        { index: 0, contentHint: "text-heavy", meanBrightness: 200, stdDev: 15, isBlank: false },
        { index: 1, contentHint: "image-rich", meanBrightness: 128, stdDev: 65, isBlank: false },
        { index: 2, contentHint: "low-detail", meanBrightness: 250, stdDev: 3, isBlank: true },
        { index: 3, contentHint: "mixed", meanBrightness: 150, stdDev: 40, isBlank: false },
      ];
      mockedAnalyzeTiles.mockResolvedValue(mockMetadata);
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "claude", outputDir: "/out", includeMetadata: true },
        {} as any
      );
      expect(mockedAnalyzeTiles).toHaveBeenCalledWith([
        "/output/tiles/tile_000_000.png",
        "/output/tiles/tile_000_001.png",
        "/output/tiles/tile_001_000.png",
        "/output/tiles/tile_001_001.png",
      ]);
    });

    it("includes tileMetadata in structured output when includeMetadata is true", async () => {
      const metadata: TileMetadata[] = [
        { index: 0, contentHint: "text-heavy", meanBrightness: 200, stdDev: 15, isBlank: false },
      ];
      mockedTileImage.mockResolvedValue(makeTileResult());
      mockedAnalyzeTiles.mockResolvedValue(metadata);
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", outputDir: "/out", includeMetadata: true },
        {} as any
      );
      const res = result as any;
      const json = JSON.parse(res.content[1].text);
      expect(json.tileMetadata).toEqual(metadata);
    });

    it("does not call analyzeTiles when includeMetadata is false", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "claude", outputDir: "/out", includeMetadata: false },
        {} as any
      );
      expect(mockedAnalyzeTiles).not.toHaveBeenCalled();
    });

    it("does not call analyzeTiles when includeMetadata is omitted", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "claude", outputDir: "/out" },
        {} as any
      );
      expect(mockedAnalyzeTiles).not.toHaveBeenCalled();
    });

    it("omits tileMetadata from structured output when includeMetadata is omitted", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      const json = JSON.parse(res.content[1].text);
      expect(json.tileMetadata).toBeUndefined();
    });
  });
});
