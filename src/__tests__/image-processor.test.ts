import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockExtract,
  mockMetadata,
  mockSharp,
} = vi.hoisted(() => {
  const mockToFile = vi.fn().mockResolvedValue({});
  const mockPng = vi.fn().mockReturnValue({ toFile: mockToFile });
  const mockExtract = vi.fn().mockReturnValue({ png: mockPng });
  const mockMetadata = vi.fn();
  const mockSharpInstance = {
    metadata: mockMetadata,
    extract: mockExtract,
    png: mockPng,
    toFile: mockToFile,
  };
  const mockSharp = Object.assign(
    vi.fn().mockReturnValue(mockSharpInstance),
    {
      cache: vi.fn(),
      concurrency: vi.fn(),
    }
  );
  return { mockToFile, mockPng, mockExtract, mockMetadata, mockSharp };
});

vi.mock("sharp", () => ({ default: mockSharp }));

vi.mock("node:fs/promises", () => ({
  stat: vi.fn(),
  access: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
}));

import * as fs from "node:fs/promises";
import {
  getImageMetadata,
  calculateGrid,
  tileImage,
  readTileAsBase64,
  listTilesInDirectory,
} from "../services/image-processor.js";

const mockedFs = vi.mocked(fs);

describe("calculateGrid", () => {
  it("calculates exact multiples correctly", () => {
    const grid = calculateGrid(2144, 2144, 1072);
    expect(grid.cols).toBe(2);
    expect(grid.rows).toBe(2);
    expect(grid.totalTiles).toBe(4);
    expect(grid.tileSize).toBe(1072);
    expect(grid.estimatedTokens).toBe(4 * 1590);
  });

  it("rounds up for remainders", () => {
    const grid = calculateGrid(2000, 1500, 1072);
    expect(grid.cols).toBe(2);
    expect(grid.rows).toBe(2);
    expect(grid.totalTiles).toBe(4);
  });

  it("handles 1px image", () => {
    const grid = calculateGrid(1, 1, 1072);
    expect(grid.cols).toBe(1);
    expect(grid.rows).toBe(1);
    expect(grid.totalTiles).toBe(1);
  });

  it("handles image smaller than tile size", () => {
    const grid = calculateGrid(500, 300, 1072);
    expect(grid.cols).toBe(1);
    expect(grid.rows).toBe(1);
    expect(grid.totalTiles).toBe(1);
  });

  it("handles landscape aspect ratio", () => {
    const grid = calculateGrid(7680, 4032, 1072);
    expect(grid.cols).toBe(8); // ceil(7680/1072) = 8
    expect(grid.rows).toBe(4); // ceil(4032/1072) = 4
    expect(grid.totalTiles).toBe(32);
  });

  it("handles portrait aspect ratio", () => {
    const grid = calculateGrid(3600, 21994, 1072);
    expect(grid.cols).toBe(4); // ceil(3600/1072) = 4
    expect(grid.rows).toBe(21); // ceil(21994/1072) = 21
    expect(grid.totalTiles).toBe(84);
  });

  it("single column (width < tileSize)", () => {
    const grid = calculateGrid(500, 5000, 1072);
    expect(grid.cols).toBe(1);
    expect(grid.rows).toBe(5);
    expect(grid.totalTiles).toBe(5);
  });

  it("single row (height < tileSize)", () => {
    const grid = calculateGrid(5000, 500, 1072);
    expect(grid.cols).toBe(5);
    expect(grid.rows).toBe(1);
    expect(grid.totalTiles).toBe(5);
  });

  it("preserves tileSize in output", () => {
    const grid = calculateGrid(1000, 1000, 800);
    expect(grid.tileSize).toBe(800);
  });

  it("calculates estimated tokens correctly (default)", () => {
    const grid = calculateGrid(3216, 3216, 1072);
    // 3 cols * 3 rows = 9 tiles
    expect(grid.totalTiles).toBe(9);
    expect(grid.estimatedTokens).toBe(9 * 1590);
  });

  it("calculates estimated tokens with custom tokensPerTile", () => {
    const grid = calculateGrid(3216, 3216, 1072, 765);
    expect(grid.totalTiles).toBe(9);
    expect(grid.estimatedTokens).toBe(9 * 765);
  });

  it("uses openai token rate (765)", () => {
    const grid = calculateGrid(1536, 1536, 768, 765);
    expect(grid.cols).toBe(2);
    expect(grid.rows).toBe(2);
    expect(grid.totalTiles).toBe(4);
    expect(grid.estimatedTokens).toBe(4 * 765);
  });

  it("uses gemini token rate (258)", () => {
    const grid = calculateGrid(1536, 1536, 768, 258);
    expect(grid.cols).toBe(2);
    expect(grid.rows).toBe(2);
    expect(grid.totalTiles).toBe(4);
    expect(grid.estimatedTokens).toBe(4 * 258);
  });

  it("handles width exactly equal to tileSize", () => {
    const grid = calculateGrid(1072, 5000, 1072);
    expect(grid.cols).toBe(1);
  });

  it("handles width one pixel more than tileSize", () => {
    const grid = calculateGrid(1073, 1072, 1072);
    expect(grid.cols).toBe(2);
  });

  it("handles minimum tile size", () => {
    const grid = calculateGrid(1000, 1000, 256);
    expect(grid.cols).toBe(4); // ceil(1000/256) = 4
    expect(grid.rows).toBe(4);
    expect(grid.totalTiles).toBe(16);
  });

  it("handles maximum tile size", () => {
    const grid = calculateGrid(3000, 3000, 1568);
    expect(grid.cols).toBe(2); // ceil(3000/1568) = 2
    expect(grid.rows).toBe(2);
    expect(grid.totalTiles).toBe(4);
  });
});

describe("getImageMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns metadata for a valid image", async () => {
    mockedFs.stat.mockResolvedValue({ size: 12345 } as any);
    mockMetadata.mockResolvedValue({
      width: 1920,
      height: 1080,
      format: "png",
      channels: 4,
    });

    const result = await getImageMetadata("/test/image.png");
    expect(result).toEqual({
      width: 1920,
      height: 1080,
      format: "png",
      fileSize: 12345,
      channels: 4,
    });
  });

  it("throws when width is missing", async () => {
    mockedFs.stat.mockResolvedValue({ size: 100 } as any);
    mockMetadata.mockResolvedValue({ height: 1080, format: "png" });

    await expect(getImageMetadata("/test/image.png")).rejects.toThrow(
      "Unable to read image dimensions"
    );
  });

  it("throws when height is missing", async () => {
    mockedFs.stat.mockResolvedValue({ size: 100 } as any);
    mockMetadata.mockResolvedValue({ width: 1920, format: "png" });

    await expect(getImageMetadata("/test/image.png")).rejects.toThrow(
      "Unable to read image dimensions"
    );
  });

  it("defaults format to 'unknown' when not provided", async () => {
    mockedFs.stat.mockResolvedValue({ size: 100 } as any);
    mockMetadata.mockResolvedValue({ width: 100, height: 100 });

    const result = await getImageMetadata("/test/image.png");
    expect(result.format).toBe("unknown");
  });

  it("defaults channels to 0 when not provided", async () => {
    mockedFs.stat.mockResolvedValue({ size: 100 } as any);
    mockMetadata.mockResolvedValue({ width: 100, height: 100, format: "png" });

    const result = await getImageMetadata("/test/image.png");
    expect(result.channels).toBe(0);
  });

  it("throws when width exceeds MAX_IMAGE_DIMENSION", async () => {
    mockedFs.stat.mockResolvedValue({ size: 100 } as any);
    mockMetadata.mockResolvedValue({ width: 70000, height: 1000, format: "png", channels: 4 });

    await expect(getImageMetadata("/test/huge.png")).rejects.toThrow(
      "exceed maximum allowed 65536px"
    );
  });

  it("throws when height exceeds MAX_IMAGE_DIMENSION", async () => {
    mockedFs.stat.mockResolvedValue({ size: 100 } as any);
    mockMetadata.mockResolvedValue({ width: 1000, height: 70000, format: "png", channels: 4 });

    await expect(getImageMetadata("/test/huge.png")).rejects.toThrow(
      "exceed maximum allowed 65536px"
    );
  });

  it("accepts image at exactly MAX_IMAGE_DIMENSION", async () => {
    mockedFs.stat.mockResolvedValue({ size: 100 } as any);
    mockMetadata.mockResolvedValue({ width: 65536, height: 65536, format: "png", channels: 4 });

    const result = await getImageMetadata("/test/max.png");
    expect(result.width).toBe(65536);
    expect(result.height).toBe(65536);
  });
});

describe("tileImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.stat.mockResolvedValue({ size: 5000 } as any);
    mockMetadata.mockResolvedValue({
      width: 2144,
      height: 2144,
      format: "png",
      channels: 4,
    });
  });

  it("creates output directory recursively", async () => {
    await tileImage("/test/image.png", 1072, "/output/tiles");
    expect(mockedFs.mkdir).toHaveBeenCalledWith(
      expect.stringContaining("output"),
      { recursive: true }
    );
  });

  it("throws on file not found", async () => {
    mockedFs.access.mockRejectedValue(new Error("ENOENT"));

    await expect(tileImage("/missing.png", 1072, "/output")).rejects.toThrow(
      "File not found"
    );
  });

  it("generates correct number of tiles for 2x2 grid", async () => {
    const result = await tileImage("/test/image.png", 1072, "/output");
    expect(result.tiles).toHaveLength(4);
    expect(result.grid.totalTiles).toBe(4);
  });

  it("uses zero-padded filenames", async () => {
    const result = await tileImage("/test/image.png", 1072, "/output");
    expect(result.tiles[0].filename).toBe("tile_000_000.png");
    expect(result.tiles[1].filename).toBe("tile_000_001.png");
    expect(result.tiles[2].filename).toBe("tile_001_000.png");
    expect(result.tiles[3].filename).toBe("tile_001_001.png");
  });

  it("assigns sequential indices", async () => {
    const result = await tileImage("/test/image.png", 1072, "/output");
    const indices = result.tiles.map((t) => t.index);
    expect(indices).toEqual([0, 1, 2, 3]);
  });

  it("calculates correct tile positions", async () => {
    const result = await tileImage("/test/image.png", 1072, "/output");
    expect(result.tiles[0]).toMatchObject({ x: 0, y: 0 });
    expect(result.tiles[1]).toMatchObject({ x: 1072, y: 0 });
    expect(result.tiles[2]).toMatchObject({ x: 0, y: 1072 });
    expect(result.tiles[3]).toMatchObject({ x: 1072, y: 1072 });
  });

  it("returns full tile dimensions for interior tiles", async () => {
    const result = await tileImage("/test/image.png", 1072, "/output");
    // 2144/1072 = 2 exactly, so all tiles are full-sized
    result.tiles.forEach((tile) => {
      expect(tile.width).toBe(1072);
      expect(tile.height).toBe(1072);
    });
  });

  it("handles edge tile dimensions (remainder)", async () => {
    mockMetadata.mockResolvedValue({
      width: 2000,
      height: 1500,
      format: "png",
      channels: 4,
    });

    const result = await tileImage("/test/image.png", 1072, "/output");
    // Right column: 2000 - 1072 = 928px wide
    // Bottom row: 1500 - 1072 = 428px tall
    const topRight = result.tiles.find((t) => t.row === 0 && t.col === 1);
    expect(topRight?.width).toBe(928);
    expect(topRight?.height).toBe(1072);

    const bottomLeft = result.tiles.find((t) => t.row === 1 && t.col === 0);
    expect(bottomLeft?.width).toBe(1072);
    expect(bottomLeft?.height).toBe(428);

    const bottomRight = result.tiles.find((t) => t.row === 1 && t.col === 1);
    expect(bottomRight?.width).toBe(928);
    expect(bottomRight?.height).toBe(428);
  });

  it("calls sharp extract with correct parameters", async () => {
    await tileImage("/test/image.png", 1072, "/output");

    // First tile: top-left
    expect(mockExtract).toHaveBeenCalledWith({
      left: 0,
      top: 0,
      width: 1072,
      height: 1072,
    });

    // Second tile: top-right
    expect(mockExtract).toHaveBeenCalledWith({
      left: 1072,
      top: 0,
      width: 1072,
      height: 1072,
    });
  });

  it("returns source image metadata", async () => {
    const result = await tileImage("/test/image.png", 1072, "/output");
    expect(result.sourceImage.width).toBe(2144);
    expect(result.sourceImage.height).toBe(2144);
    expect(result.sourceImage.format).toBe("png");
  });

  it("returns resolved output directory", async () => {
    const result = await tileImage("/test/image.png", 1072, "/output");
    expect(result.outputDir).toContain("output");
  });

  it("passes tokensPerTile through to calculateGrid", async () => {
    const result = await tileImage("/test/image.png", 1072, "/output", 258);
    // 2x2 grid = 4 tiles, 258 tokens each
    expect(result.grid.estimatedTokens).toBe(4 * 258);
  });

  it("uses default tokensPerTile (1590) when not specified", async () => {
    const result = await tileImage("/test/image.png", 1072, "/output");
    expect(result.grid.estimatedTokens).toBe(4 * 1590);
  });

  it("handles single tile image", async () => {
    mockMetadata.mockResolvedValue({
      width: 500,
      height: 300,
      format: "png",
      channels: 4,
    });

    const result = await tileImage("/test/small.png", 1072, "/output");
    expect(result.tiles).toHaveLength(1);
    expect(result.tiles[0]).toMatchObject({
      index: 0,
      row: 0,
      col: 0,
      x: 0,
      y: 0,
      width: 500,
      height: 300,
    });
  });

  it("throws when total tiles exceeds MAX_TOTAL_TILES", async () => {
    mockMetadata.mockResolvedValue({
      width: 60000,
      height: 60000,
      format: "png",
      channels: 4,
    });

    // 60000/256 = 235 cols × 235 rows = 55,225 tiles > 10,000
    await expect(tileImage("/test/huge.png", 256, "/output")).rejects.toThrow(
      "exceeding the maximum of 10000"
    );
  });

  it("allows tile count at exactly MAX_TOTAL_TILES", async () => {
    // 100×100 grid at tileSize 1 = 10,000 tiles exactly
    mockMetadata.mockResolvedValue({
      width: 100,
      height: 100,
      format: "png",
      channels: 4,
    });

    const result = await tileImage("/test/img.png", 1, "/output");
    expect(result.grid.totalTiles).toBe(10000);
  });

  it("cleans up partial tiles on Sharp failure", async () => {
    mockMetadata.mockResolvedValue({
      width: 2144,
      height: 2144,
      format: "png",
      channels: 4,
    });

    // Succeed on first 2 tiles, fail on 3rd
    let callCount = 0;
    mockExtract.mockImplementation(() => ({
      png: () => ({
        toFile: () => {
          callCount++;
          if (callCount === 3) {
            return Promise.reject(new Error("Sharp extract failed"));
          }
          return Promise.resolve({});
        },
      }),
    }));

    mockedFs.unlink.mockResolvedValue(undefined);

    await expect(tileImage("/test/image.png", 1072, "/output")).rejects.toThrow(
      "Sharp extract failed"
    );

    // Should have cleaned up the 2 successfully created tiles
    expect(mockedFs.unlink).toHaveBeenCalledTimes(2);
  });
});

describe("readTileAsBase64", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads file and returns base64 string", async () => {
    const buffer = Buffer.from("fake-png-data");
    mockedFs.readFile.mockResolvedValue(buffer);

    const result = await readTileAsBase64("/tiles/tile_000_000.png");
    expect(result).toBe(buffer.toString("base64"));
    expect(mockedFs.readFile).toHaveBeenCalledWith("/tiles/tile_000_000.png");
  });

  it("propagates read errors", async () => {
    mockedFs.readFile.mockRejectedValue(new Error("ENOENT"));
    await expect(readTileAsBase64("/missing.png")).rejects.toThrow("ENOENT");
  });
});

describe("listTilesInDirectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns sorted tile paths", async () => {
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readdir.mockResolvedValue([
      "tile_001_000.png",
      "tile_000_001.png",
      "tile_000_000.png",
      "other.txt",
    ] as any);

    const result = await listTilesInDirectory("/tiles");
    expect(result).toHaveLength(3);
    // Sorted: 000_000, 000_001, 001_000
    expect(result[0]).toContain("tile_000_000.png");
    expect(result[1]).toContain("tile_000_001.png");
    expect(result[2]).toContain("tile_001_000.png");
  });

  it("filters non-tile files", async () => {
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readdir.mockResolvedValue([
      "tile_000_000.png",
      "readme.txt",
      "image.png",
      ".DS_Store",
    ] as any);

    const result = await listTilesInDirectory("/tiles");
    expect(result).toHaveLength(1);
  });

  it("throws on missing directory", async () => {
    mockedFs.access.mockRejectedValue(new Error("ENOENT"));

    await expect(listTilesInDirectory("/missing")).rejects.toThrow(
      "Tiles directory not found"
    );
  });

  it("throws when directory is empty of tiles", async () => {
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readdir.mockResolvedValue(["readme.txt"] as any);

    await expect(listTilesInDirectory("/empty")).rejects.toThrow(
      "No tile files found"
    );
  });

  it("returns full paths", async () => {
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readdir.mockResolvedValue(["tile_000_000.png"] as any);

    const result = await listTilesInDirectory("/tiles");
    expect(result[0]).toMatch(/\/tiles\/tile_000_000\.png$/);
  });
});
