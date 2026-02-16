import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TileImageResult } from "../types.js";

vi.mock("../services/url-capture.js", () => ({
  captureUrl: vi.fn(),
  detectDisplayWidth: vi.fn(),
}));

vi.mock("../services/image-processor.js", () => ({
  tileImage: vi.fn(),
  listTilesInDirectory: vi.fn(),
  readTileAsBase64: vi.fn(),
  computeEstimateForModel: vi.fn(),
}));

vi.mock("../services/interactive-preview-generator.js", () => ({
  generateInteractivePreview: vi.fn(),
}));

vi.mock("../services/tile-analyzer.js", () => ({
  analyzeTiles: vi.fn(),
}));

vi.mock("../services/elicitation.js", () => ({
  confirmTiling: vi.fn(),
}));

vi.mock("../utils.js", () => ({
  getDefaultOutputBase: vi.fn().mockReturnValue("/Users/test/Desktop"),
  escapeHtml: vi.fn((s: string) => s),
  sanitizeHostname: vi.fn().mockReturnValue("example-com"),
  buildTileHints: vi.fn().mockReturnValue({}),
}));

vi.mock("sharp", () => {
  const mockToFile = vi.fn().mockResolvedValue({});
  const mockPng = vi.fn().mockReturnValue({ toFile: mockToFile });
  const mockWebp = vi.fn().mockReturnValue({ toFile: mockToFile });
  const mockSharpInstance = { png: mockPng, webp: mockWebp, toFile: mockToFile };
  const mockSharp = Object.assign(
    vi.fn().mockReturnValue(mockSharpInstance),
    { cache: vi.fn(), concurrency: vi.fn() }
  );
  return { default: mockSharp };
});

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { captureUrl } from "../services/url-capture.js";
import { tileImage, listTilesInDirectory, readTileAsBase64, computeEstimateForModel } from "../services/image-processor.js";
import { generateInteractivePreview } from "../services/interactive-preview-generator.js";
import { analyzeTiles } from "../services/tile-analyzer.js";
import { confirmTiling } from "../services/elicitation.js";
import { registerCaptureAndTileTool } from "../tools/capture-and-tile.js";
import { createMockServer } from "./helpers/mock-server.js";

const mockedConfirmTiling = vi.mocked(confirmTiling);
const mockedAnalyzeTiles = vi.mocked(analyzeTiles);

const mockedCaptureUrl = vi.mocked(captureUrl);
const mockedTileImage = vi.mocked(tileImage);
const mockedListTiles = vi.mocked(listTilesInDirectory);
const mockedReadBase64 = vi.mocked(readTileAsBase64);
const mockedGeneratePreview = vi.mocked(generateInteractivePreview);
const mockedComputeEstimate = vi.mocked(computeEstimateForModel);

function makeTileResult(overrides?: Partial<TileImageResult>): TileImageResult {
  return {
    sourceImage: {
      width: 1280,
      height: 800,
      format: "webp",
      fileSize: 30000,
      channels: 4,
    },
    grid: {
      cols: 2,
      rows: 1,
      totalTiles: 2,
      tileSize: 1092,
      estimatedTokens: 3180,
    },
    outputDir: "/output/tiles",
    tiles: [
      { index: 0, row: 0, col: 0, x: 0, y: 0, width: 1092, height: 800, filename: "tile_000_000.webp", filePath: "/output/tiles/tile_000_000.webp" },
      { index: 1, row: 0, col: 1, x: 1092, y: 0, width: 188, height: 800, filename: "tile_000_001.webp", filePath: "/output/tiles/tile_000_001.webp" },
    ],
    ...overrides,
  };
}

describe("registerCaptureAndTileTool", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerCaptureAndTileTool(mock.server as any);

    mockedCaptureUrl.mockResolvedValue({
      buffer: Buffer.from("screenshot-data"),
      pageWidth: 1280,
      pageHeight: 800,
      url: "https://example.com",
    });
    mockedTileImage.mockResolvedValue(makeTileResult());
    mockedListTiles.mockResolvedValue([
      "/output/tiles/tile_000_000.webp",
      "/output/tiles/tile_000_001.webp",
    ]);
    mockedReadBase64.mockResolvedValue("AAAA");
    mockedAnalyzeTiles.mockResolvedValue([]);
    mockedGeneratePreview.mockResolvedValue("/output/tiles/preview.html");
    mockedComputeEstimate.mockReturnValue({
      model: "claude", label: "Claude", tileSize: 1092, cols: 2, rows: 1, tiles: 2, tokens: 3180,
    });
    // Default: elicitation confirmed (user accepted or skipped)
    mockedConfirmTiling.mockResolvedValue({ confirmed: true });
  });

  it("registers the tool with correct name", () => {
    expect(mock.server.registerTool).toHaveBeenCalledWith(
      "tiler_capture_and_tile",
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("description mentions recommend-settings and elicitation", () => {
    const registerCall = (mock.server.registerTool as any).mock.calls[0];
    const description = registerCall[1].description as string;
    expect(description).toContain("tiler_recommend_settings");
    expect(description).toContain("confirm before tiling");
    // Multi-step flow should still be present
    expect(description).toContain("tiler_capture_url");
  });

  it("returns combined capture + tiling result", async () => {
    const tool = mock.getTool("tiler_capture_and_tile")!;
    const result = await tool.handler(
      { url: "https://example.com", model: "claude", page: 0, format: "webp" },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBeUndefined();

    // Should have: summary text, JSON text, tile labels + images
    const textBlocks = res.content.filter((c: any) => c.type === "text");
    const imageBlocks = res.content.filter((c: any) => c.type === "image");

    expect(textBlocks.length).toBeGreaterThanOrEqual(2);
    expect(imageBlocks).toHaveLength(2);
  });

  it("includes capture metadata in structured JSON", async () => {
    const tool = mock.getTool("tiler_capture_and_tile")!;
    const result = await tool.handler(
      { url: "https://example.com", model: "claude", page: 0, format: "webp", viewportWidth: 1280, waitUntil: "load" },
      {} as any
    );
    const res = result as any;
    const jsonBlock = res.content.find(
      (c: any) => c.type === "text" && c.text.includes('"capture"')
    );
    expect(jsonBlock).toBeDefined();
    const json = JSON.parse(jsonBlock.text);
    expect(json.capture.url).toBe("https://example.com");
    expect(json.capture.pageWidth).toBe(1280);
    expect(json.capture.pageHeight).toBe(800);
  });

  it("includes scroll-stitch segments in output", async () => {
    mockedCaptureUrl.mockResolvedValue({
      buffer: Buffer.from("screenshot-data"),
      pageWidth: 1280,
      pageHeight: 20000,
      url: "https://example.com",
      segmentsStitched: 2,
    });

    const tool = mock.getTool("tiler_capture_and_tile")!;
    const result = await tool.handler(
      { url: "https://example.com", model: "claude", page: 0, format: "webp" },
      {} as any
    );
    const res = result as any;
    expect(res.content[0].text).toContain("Scroll-stitched 2 segments");
  });

  it("always saves intermediate screenshot as PNG regardless of format param", async () => {
    const tool = mock.getTool("tiler_capture_and_tile")!;
    await tool.handler(
      { url: "https://example.com", model: "claude", page: 0, format: "webp" },
      {} as any
    );

    // Sharp should be called with the buffer, then .png() — never .webp() for the screenshot
    const sharpModule = await import("sharp");
    const mockSharp = vi.mocked(sharpModule.default);
    const instance = mockSharp.mock.results[0].value;
    expect(instance.png).toHaveBeenCalled();
    expect(instance.webp).not.toHaveBeenCalled();

    // tileImage should receive a hostname-based .png screenshot path
    const tileCallArgs = mockedTileImage.mock.calls[0];
    expect(tileCallArgs[0]).toMatch(/example-com\.png$/);
    // format param still flows to tileImage for tile output
    expect(tileCallArgs[6]).toBe("webp");
  });

  it("wraps errors from captureUrl", async () => {
    mockedCaptureUrl.mockRejectedValue(new Error("Chrome crashed"));
    const tool = mock.getTool("tiler_capture_and_tile")!;
    const result = await tool.handler(
      { url: "https://example.com", model: "claude", page: 0, format: "webp" },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Error capturing and tiling URL");
    expect(res.content[0].text).toContain("Chrome crashed");
  });

  it("returns webp MIME type for tile images", async () => {
    const tool = mock.getTool("tiler_capture_and_tile")!;
    const result = await tool.handler(
      { url: "https://example.com", model: "claude", page: 0, format: "webp" },
      {} as any
    );
    const res = result as any;
    const imageBlocks = res.content.filter((c: any) => c.type === "image");
    for (const img of imageBlocks) {
      expect(img.mimeType).toBe("image/webp");
    }
  });

  it("includes allModels in structured JSON", async () => {
    const tool = mock.getTool("tiler_capture_and_tile")!;
    const result = await tool.handler(
      { url: "https://example.com", model: "claude", page: 0, format: "webp" },
      {} as any
    );
    const res = result as any;
    const jsonBlock = res.content.find(
      (c: any) => c.type === "text" && c.text.includes('"allModels"')
    );
    expect(jsonBlock).toBeDefined();
    const json = JSON.parse(jsonBlock.text);
    expect(json.allModels).toBeDefined();
    expect(json.allModels).toHaveLength(4);
  });

  it("includes preview in summary", async () => {
    const tool = mock.getTool("tiler_capture_and_tile")!;
    const result = await tool.handler(
      { url: "https://example.com", model: "claude", page: 0, format: "webp" },
      {} as any
    );
    const res = result as any;
    expect(res.content[0].text).toContain("Preview: /output/tiles/preview.html");
  });

  it("supports pagination", async () => {
    mockedListTiles.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => {
        const row = Math.floor(i / 4);
        const col = i % 4;
        return `/output/tiles/tile_${String(row).padStart(3, "0")}_${String(col).padStart(3, "0")}.webp`;
      })
    );

    const tool = mock.getTool("tiler_capture_and_tile")!;
    const result = await tool.handler(
      { url: "https://example.com", model: "claude", page: 0, format: "webp" },
      {} as any
    );
    const res = result as any;
    const imageBlocks = res.content.filter((c: any) => c.type === "image");
    expect(imageBlocks).toHaveLength(5); // first page

    // JSON should indicate hasMore
    const jsonBlock = res.content.find(
      (c: any) => c.type === "text" && c.text.includes('"page"')
    );
    const json = JSON.parse(jsonBlock.text);
    expect(json.page.hasMore).toBe(true);
  });

  describe("elicitation confirmation", () => {
    it("proceeds when user confirms", async () => {
      mockedConfirmTiling.mockResolvedValue({ confirmed: true });
      const tool = mock.getTool("tiler_capture_and_tile")!;
      const result = await tool.handler(
        { url: "https://example.com", model: "claude", page: 0, format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBeUndefined();
      expect(mockedTileImage).toHaveBeenCalled();
    });

    it("returns cancel message with screenshot path when user declines", async () => {
      mockedConfirmTiling.mockResolvedValue({ confirmed: false });
      const tool = mock.getTool("tiler_capture_and_tile")!;
      const result = await tool.handler(
        { url: "https://example.com", model: "claude", page: 0, format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBeUndefined();
      expect(res.content).toHaveLength(1);
      expect(res.content[0].text).toContain("Tiling cancelled by user");
      expect(res.content[0].text).toContain("Captured: 1280 x 800");
      expect(res.content[0].text).toContain("Screenshot saved to:");
      expect(res.content[0].text).toMatch(/example-com\.png/);
      expect(res.content[0].text).toContain("Preset: Claude");
      expect(mockedTileImage).not.toHaveBeenCalled();
    });

    it("still captures screenshot before elicitation", async () => {
      mockedConfirmTiling.mockResolvedValue({ confirmed: false });
      const tool = mock.getTool("tiler_capture_and_tile")!;
      await tool.handler(
        { url: "https://example.com", model: "claude", page: 0, format: "webp" },
        {} as any
      );
      expect(mockedCaptureUrl).toHaveBeenCalled();
    });

    it("proceeds when client does not support elicitation", async () => {
      mockedConfirmTiling.mockResolvedValue({ confirmed: true });
      const tool = mock.getTool("tiler_capture_and_tile")!;
      const result = await tool.handler(
        { url: "https://example.com", model: "claude", page: 0, format: "webp" },
        {} as any
      );
      const res = result as any;
      expect(res.isError).toBeUndefined();
      expect(mockedTileImage).toHaveBeenCalled();
    });

    it("passes capture dimensions to confirmTiling", async () => {
      mockedCaptureUrl.mockResolvedValue({
        buffer: Buffer.from("screenshot-data"),
        pageWidth: 1920,
        pageHeight: 5000,
        url: "https://example.com",
      });
      mockedComputeEstimate.mockReturnValue({
        model: "claude", label: "Claude", tileSize: 1092, cols: 2, rows: 5, tiles: 10, tokens: 15900,
      });
      const tool = mock.getTool("tiler_capture_and_tile")!;
      await tool.handler(
        { url: "https://example.com", model: "claude", page: 0, format: "webp" },
        {} as any
      );
      expect(mockedConfirmTiling).toHaveBeenCalledWith(
        expect.anything(), // server
        1920, 5000, "claude",
        expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)
      );
    });
  });
});
