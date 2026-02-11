import * as path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TileImageResult } from "../types.js";

vi.mock("../services/image-processor.js", () => ({
  tileImage: vi.fn(),
}));

vi.mock("../services/preview-generator.js", () => ({
  generatePreview: vi.fn(),
}));

import { tileImage } from "../services/image-processor.js";
import { generatePreview } from "../services/preview-generator.js";
import { registerTileImageTool } from "../tools/tile-image.js";
import { createMockServer } from "./helpers/mock-server.js";

const mockedTileImage = vi.mocked(tileImage);
const mockedGeneratePreview = vi.mocked(generatePreview);

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
    mockedGeneratePreview.mockResolvedValue("/output/tiles/preview.html");
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

  it("defaults outputDir to tiles subfolder next to source", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    const tool = mock.getTool("tiler_tile_image")!;
    await tool.handler(
      { filePath: "/images/photo.png", model: "claude", tileSize: undefined, outputDir: undefined },
      {} as any
    );
    expect(mockedTileImage).toHaveBeenCalledWith(
      "/images/photo.png",
      1092,
      expect.stringContaining(path.join("tiles", "photo")),
      1590,
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
    expect(mockedTileImage).toHaveBeenCalledWith("image.png", 1072, "/custom/dir", 1590, undefined);
  });

  it("returns summary and structured JSON on success", async () => {
    mockedTileImage.mockResolvedValue(makeTileResult());
    const tool = mock.getTool("tiler_tile_image")!;
    const result = await tool.handler(
      { filePath: "image.png", model: "claude", tileSize: 1072, outputDir: "/out" },
      {} as any
    );
    const res = result as any;
    expect(res.content).toHaveLength(2);
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("2×2 grid");
    expect(res.content[0].text).toContain("4 tiles");

    const json = JSON.parse(res.content[1].text);
    expect(json.grid.totalTiles).toBe(4);
    expect(json.tiles).toHaveLength(4);
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

  describe("model support", () => {
    it("defaults to claude tile size (1092) when tileSize is undefined", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 1092, "/out", 1590, undefined);
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
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 768, "/out", 765, undefined);
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
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 768, "/out", 258, undefined);
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
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 1536, "/out", 1120, undefined);
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
      // Should have called tileImage with clamped value
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 1568, "/out", 1590, undefined);

      const res = result as any;
      // Summary should contain warning
      expect(res.content[0].text).toContain("2000px exceeds");
      expect(res.content[0].text).toContain("clamped to 1568px");

      // Structured output should contain warnings array
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
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 2000, "/out", 765, undefined);

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
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 2048, "/out", 765, undefined);
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
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 512, "/out", 765, undefined);
    });

    it("clamps tileSize above gemini max (768) with warning", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "gemini", tileSize: 1000, outputDir: "/out" },
        {} as any
      );
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 768, "/out", 258, undefined);

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
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 3072, "/out", 1120, undefined);

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
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 256, "/out", 1590, undefined);

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
      expect(mockedTileImage).toHaveBeenCalledWith("image.png", 384, "/out", 1120, undefined);

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
        2048
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
        10000
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
      mockedGeneratePreview.mockResolvedValue("/output/tiles/preview.html");
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      const json = JSON.parse(res.content[1].text);
      expect(json.previewPath).toBe("/output/tiles/preview.html");
    });

    it("summary mentions preview when generation succeeds", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      mockedGeneratePreview.mockResolvedValue("/output/tiles/preview.html");
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).toContain("preview.html");
      expect(res.content[0].text).toContain("open in browser");
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
      // Should NOT be an error response
      expect(res.isError).toBeUndefined();
      // Should still have summary and JSON
      expect(res.content).toHaveLength(2);
      // Should NOT have previewPath in JSON
      const json = JSON.parse(res.content[1].text);
      expect(json.previewPath).toBeUndefined();
      // Should have warning about preview failure
      expect(json.warnings).toBeDefined();
      expect(json.warnings).toContainEqual(expect.stringContaining("Preview generation failed"));
      expect(json.warnings).toContainEqual(expect.stringContaining("Write permission denied"));
    });

    it("summary does not mention preview when generation fails", async () => {
      mockedTileImage.mockResolvedValue(makeTileResult());
      mockedGeneratePreview.mockRejectedValue(new Error("fail"));
      const tool = mock.getTool("tiler_tile_image")!;
      const result = await tool.handler(
        { filePath: "image.png", model: "claude", tileSize: undefined, outputDir: "/out" },
        {} as any
      );
      const res = result as any;
      expect(res.content[0].text).not.toContain("Preview: preview.html");
    });

    it("calls generatePreview with correct arguments", async () => {
      const tileResult = makeTileResult();
      mockedTileImage.mockResolvedValue(tileResult);
      mockedGeneratePreview.mockResolvedValue("/output/tiles/preview.html");
      const tool = mock.getTool("tiler_tile_image")!;
      await tool.handler(
        { filePath: "image.png", model: "openai", tileSize: 768, outputDir: "/out" },
        {} as any
      );
      expect(mockedGeneratePreview).toHaveBeenCalledWith(tileResult, "image.png", "openai");
    });
  });
});
