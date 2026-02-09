import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TileImageResult } from "../types.js";

const mockWriteFile = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
}));

import { generatePreview } from "../services/preview-generator.js";

function makeTileResult(overrides?: Partial<TileImageResult>): TileImageResult {
  return {
    sourceImage: {
      width: 2184,
      height: 2184,
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

describe("generatePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
  });

  it("writes preview.html to the output directory", async () => {
    const result = makeTileResult();
    const previewPath = await generatePreview(result, "/images/photo.png", "claude");

    expect(previewPath).toBe("/output/tiles/preview.html");
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/output/tiles/preview.html",
      expect.any(String),
      "utf-8"
    );
  });

  it("HTML contains DOCTYPE declaration", async () => {
    const result = makeTileResult();
    await generatePreview(result, "/images/photo.png", "claude");

    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("HTML contains source image dimensions", async () => {
    const result = makeTileResult();
    await generatePreview(result, "/images/photo.png", "claude");

    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("2184");
    expect(html).toContain("2184");
  });

  it("HTML contains grid info", async () => {
    const result = makeTileResult();
    await generatePreview(result, "/images/photo.png", "claude");

    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("2 × 2 = 4 tiles");
    expect(html).toContain("1092");
  });

  it("HTML contains model name", async () => {
    const result = makeTileResult();
    await generatePreview(result, "/images/photo.png", "openai");

    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("openai");
  });

  it("HTML contains estimated tokens", async () => {
    const result = makeTileResult();
    await generatePreview(result, "/images/photo.png", "claude");

    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("6,360");
  });

  it("tile img tags reference correct filenames", async () => {
    const result = makeTileResult();
    await generatePreview(result, "/images/photo.png", "claude");

    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("tile_000_000.png");
    expect(html).toContain("tile_000_001.png");
    expect(html).toContain("tile_001_000.png");
    expect(html).toContain("tile_001_001.png");
  });

  it("source image uses relative path from output dir", async () => {
    const result = makeTileResult({ outputDir: "/images/tiles" });
    await generatePreview(result, "/images/photo.png", "claude");

    const html = mockWriteFile.mock.calls[0][1] as string;
    // relative path from /images/tiles to /images/photo.png = ../photo.png
    expect(html).toContain("../photo.png");
  });

  it("JS metadata object has correct dimensions and grid values", async () => {
    const result = makeTileResult();
    await generatePreview(result, "/images/photo.png", "claude");

    const html = mockWriteFile.mock.calls[0][1] as string;
    // Check the META object in the script
    expect(html).toContain("width: 2184");
    expect(html).toContain("height: 2184");
    expect(html).toContain("cols: 2");
    expect(html).toContain("rows: 2");
    expect(html).toContain("tileSize: 1092");
    expect(html).toContain("totalTiles: 4");
  });

  it("HTML-escapes filenames to prevent XSS", async () => {
    const result = makeTileResult();
    await generatePreview(result, '/images/<script>alert("xss")</script>.png', "claude");

    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("contains both Source View and Tile View sections", async () => {
    const result = makeTileResult();
    await generatePreview(result, "/images/photo.png", "claude");

    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("view-source");
    expect(html).toContain("view-tiles");
    expect(html).toContain("Source View");
    expect(html).toContain("Tile View");
  });

  it("SVG viewBox matches source image dimensions", async () => {
    const result = makeTileResult();
    await generatePreview(result, "/images/photo.png", "claude");

    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain(`viewBox="0 0 2184 2184"`);
  });

  it("tile grid CSS has correct column count", async () => {
    const result = makeTileResult();
    await generatePreview(result, "/images/photo.png", "claude");

    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("grid-template-columns: repeat(2, 1fr)");
  });
});
