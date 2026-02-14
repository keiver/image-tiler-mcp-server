import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TileImageResult } from "../types.js";

vi.mock("../services/image-processor.js", () => ({
  tileImage: vi.fn(),
  listTilesInDirectory: vi.fn(),
  readTileAsBase64: vi.fn(),
  computeEstimateForModel: vi.fn(),
}));

vi.mock("../services/interactive-preview-generator.js", () => ({
  generateInteractivePreview: vi.fn(),
}));

vi.mock("../services/image-source-resolver.js", () => ({
  resolveImageSource: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  copyFile: vi.fn(),
}));

import { tileImage, listTilesInDirectory, readTileAsBase64, computeEstimateForModel } from "../services/image-processor.js";
import { generateInteractivePreview } from "../services/interactive-preview-generator.js";
import { resolveImageSource } from "../services/image-source-resolver.js";
import { registerPrepareImageTool } from "../tools/prepare-image.js";
import { createMockServer } from "./helpers/mock-server.js";

const mockedTileImage = vi.mocked(tileImage);
const mockedListTiles = vi.mocked(listTilesInDirectory);
const mockedReadBase64 = vi.mocked(readTileAsBase64);
const mockedGeneratePreview = vi.mocked(generateInteractivePreview);
const mockedComputeEstimate = vi.mocked(computeEstimateForModel);
const mockedResolveSource = vi.mocked(resolveImageSource);

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

function makeTilePaths(count: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 4);
    const col = i % 4;
    paths.push(
      `/output/tiles/tile_${String(row).padStart(3, "0")}_${String(col).padStart(3, "0")}.png`
    );
  }
  return paths;
}

describe("registerPrepareImageTool", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerPrepareImageTool(mock.server as any);

    mockedResolveSource.mockResolvedValue({
      localPath: "/images/photo.png",
      sourceType: "file",
      originalSource: "/images/photo.png",
    });
    mockedTileImage.mockResolvedValue(makeTileResult());
    mockedGeneratePreview.mockResolvedValue("/output/tiles/photo-preview.html");
    mockedComputeEstimate.mockReturnValue({
      model: "claude", label: "Claude", tileSize: 1092, cols: 2, rows: 2, tiles: 4, tokens: 6360,
    });
    mockedListTiles.mockResolvedValue(makeTilePaths(4));
    mockedReadBase64.mockResolvedValue("AAAA");
  });

  it("registers the tool with correct name", () => {
    expect(mock.server.registerTool).toHaveBeenCalledWith(
      "tiler_prepare_image",
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("returns error when no source provided", async () => {
    const tool = mock.getTool("tiler_prepare_image")!;
    const result = await tool.handler({}, {} as any);
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No image source provided");
  });

  it("returns combined summary, JSON, and tile images", async () => {
    const tool = mock.getTool("tiler_prepare_image")!;
    const result = await tool.handler(
      { filePath: "/images/photo.png", model: "claude", page: 0 },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBeUndefined();

    // Should have: summary text, JSON text, then for each tile: label + image
    const textBlocks = res.content.filter((c: any) => c.type === "text");
    const imageBlocks = res.content.filter((c: any) => c.type === "image");

    // Summary + JSON + 4 tile labels = 6 text blocks (only 4 tiles total, no pagination hint)
    expect(textBlocks.length).toBeGreaterThanOrEqual(6);
    expect(imageBlocks).toHaveLength(4);
  });

  it("includes page info in structured JSON", async () => {
    const tool = mock.getTool("tiler_prepare_image")!;
    const result = await tool.handler(
      { filePath: "photo.png", model: "claude", page: 0 },
      {} as any
    );
    const res = result as any;
    // Find the JSON text block (second text block)
    const jsonBlock = res.content.find(
      (c: any) => c.type === "text" && c.text.includes('"page"')
    );
    expect(jsonBlock).toBeDefined();
    const json = JSON.parse(jsonBlock.text);
    expect(json.page.current).toBe(0);
    expect(json.page.totalTiles).toBe(4);
    expect(json.page.hasMore).toBe(false);
  });

  it("returns only first 5 tiles when more exist", async () => {
    const result12 = makeTileResult({
      grid: { cols: 4, rows: 3, totalTiles: 12, tileSize: 1092, estimatedTokens: 12 * 1590 },
    });
    mockedTileImage.mockResolvedValue(result12);
    mockedListTiles.mockResolvedValue(makeTilePaths(12));

    const tool = mock.getTool("tiler_prepare_image")!;
    const result = await tool.handler(
      { filePath: "big.png", model: "claude", page: 0 },
      {} as any
    );
    const res = result as any;
    const imageBlocks = res.content.filter((c: any) => c.type === "image");
    expect(imageBlocks).toHaveLength(5);

    // Should have pagination hint
    const paginationHint = res.content.find(
      (c: any) => c.type === "text" && c.text.includes("Next page")
    );
    expect(paginationHint).toBeDefined();
  });

  it("supports page parameter for pagination", async () => {
    const result12 = makeTileResult({
      grid: { cols: 4, rows: 3, totalTiles: 12, tileSize: 1092, estimatedTokens: 12 * 1590 },
    });
    mockedTileImage.mockResolvedValue(result12);
    mockedListTiles.mockResolvedValue(makeTilePaths(12));

    const tool = mock.getTool("tiler_prepare_image")!;
    const result = await tool.handler(
      { filePath: "big.png", model: "claude", page: 1 },
      {} as any
    );
    const res = result as any;
    const imageBlocks = res.content.filter((c: any) => c.type === "image");
    expect(imageBlocks).toHaveLength(5); // tiles 5-9

    const jsonBlock = res.content.find(
      (c: any) => c.type === "text" && c.text.includes('"page"')
    );
    const json = JSON.parse(jsonBlock.text);
    expect(json.page.current).toBe(1);
    expect(json.page.hasMore).toBe(true); // still tiles 10-11
  });

  it("last page returns remaining tiles", async () => {
    const result12 = makeTileResult({
      grid: { cols: 4, rows: 3, totalTiles: 12, tileSize: 1092, estimatedTokens: 12 * 1590 },
    });
    mockedTileImage.mockResolvedValue(result12);
    mockedListTiles.mockResolvedValue(makeTilePaths(12));

    const tool = mock.getTool("tiler_prepare_image")!;
    const result = await tool.handler(
      { filePath: "big.png", model: "claude", page: 2 },
      {} as any
    );
    const res = result as any;
    const imageBlocks = res.content.filter((c: any) => c.type === "image");
    expect(imageBlocks).toHaveLength(2); // tiles 10-11

    const jsonBlock = res.content.find(
      (c: any) => c.type === "text" && c.text.includes('"page"')
    );
    const json = JSON.parse(jsonBlock.text);
    expect(json.page.hasMore).toBe(false);
  });

  it("wraps errors from tileImage", async () => {
    mockedTileImage.mockRejectedValue(new Error("Sharp failed"));
    const tool = mock.getTool("tiler_prepare_image")!;
    const result = await tool.handler(
      { filePath: "bad.png", model: "claude", page: 0 },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Error preparing image");
    expect(res.content[0].text).toContain("Sharp failed");
  });

  it("calls cleanup on source after completion", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    mockedResolveSource.mockResolvedValue({
      localPath: "/tmp/from-url.png",
      sourceType: "url",
      originalSource: "https://example.com/img.png",
      cleanup,
    });

    const tool = mock.getTool("tiler_prepare_image")!;
    await tool.handler(
      { sourceUrl: "https://example.com/img.png", model: "claude", page: 0 },
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

    const tool = mock.getTool("tiler_prepare_image")!;
    await tool.handler(
      { sourceUrl: "https://example.com/img.png", model: "claude", page: 0 },
      {} as any
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported image format", async () => {
    mockedResolveSource.mockResolvedValue({
      localPath: "/tmp/image.bmp",
      sourceType: "file",
      originalSource: "/tmp/image.bmp",
    });
    const tool = mock.getTool("tiler_prepare_image")!;
    const result = await tool.handler(
      { filePath: "image.bmp", model: "claude", page: 0 },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unsupported image format");
  });
});
