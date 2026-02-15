import { describe, it, expect, vi } from "vitest";

const { mockStats, mockSharp } = vi.hoisted(() => {
  const mockStats = vi.fn();
  const mockSharpInstance = { stats: mockStats };
  const mockSharp = Object.assign(
    vi.fn().mockReturnValue(mockSharpInstance),
    { cache: vi.fn(), concurrency: vi.fn() }
  );
  return { mockStats, mockSharp };
});

vi.mock("sharp", () => ({ default: mockSharp }));

import { analyzeTile, analyzeTiles } from "../services/tile-analyzer.js";

describe("analyzeTile", () => {
  it("classifies low-detail (stdDev < 5) as low-detail + isBlank", async () => {
    mockStats.mockResolvedValue({
      channels: [
        { mean: 250, stdev: 2 },
        { mean: 250, stdev: 3 },
        { mean: 250, stdev: 1 },
      ],
    });

    const result = await analyzeTile("/tiles/tile_000_000.webp", 0);
    expect(result.contentHint).toBe("low-detail");
    expect(result.isBlank).toBe(true);
    expect(result.index).toBe(0);
    expect(result.meanBrightness).toBe(250);
    expect(result.stdDev).toBe(2);
  });

  it("classifies text-heavy (5 <= stdDev < 25)", async () => {
    mockStats.mockResolvedValue({
      channels: [
        { mean: 200, stdev: 15 },
        { mean: 200, stdev: 15 },
        { mean: 200, stdev: 15 },
      ],
    });

    const result = await analyzeTile("/tiles/tile_000_001.webp", 1);
    expect(result.contentHint).toBe("text-heavy");
    expect(result.isBlank).toBe(false);
    expect(result.stdDev).toBe(15);
  });

  it("classifies image-rich (stdDev > 60)", async () => {
    mockStats.mockResolvedValue({
      channels: [
        { mean: 128, stdev: 70 },
        { mean: 100, stdev: 80 },
        { mean: 90, stdev: 65 },
      ],
    });

    const result = await analyzeTile("/tiles/tile_001_000.webp", 2);
    expect(result.contentHint).toBe("image-rich");
    expect(result.isBlank).toBe(false);
  });

  it("classifies mixed (25 <= stdDev <= 60)", async () => {
    mockStats.mockResolvedValue({
      channels: [
        { mean: 150, stdev: 40 },
        { mean: 140, stdev: 35 },
        { mean: 130, stdev: 45 },
      ],
    });

    const result = await analyzeTile("/tiles/tile_001_001.webp", 3);
    expect(result.contentHint).toBe("mixed");
    expect(result.isBlank).toBe(false);
    expect(result.stdDev).toBe(40);
  });

  it("rounds meanBrightness and stdDev to 2 decimal places", async () => {
    mockStats.mockResolvedValue({
      channels: [
        { mean: 128.456, stdev: 33.789 },
        { mean: 129.123, stdev: 34.567 },
        { mean: 127.890, stdev: 33.123 },
      ],
    });

    const result = await analyzeTile("/tiles/tile.webp", 0);
    // Mean of means: (128.456 + 129.123 + 127.890) / 3 = 128.48966...
    // Mean of stdevs: (33.789 + 34.567 + 33.123) / 3 = 33.82633...
    expect(typeof result.meanBrightness).toBe("number");
    expect(typeof result.stdDev).toBe("number");
    expect(result.meanBrightness.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
    expect(result.stdDev.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("boundary: stdDev exactly 5 is text-heavy (not low-detail)", async () => {
    mockStats.mockResolvedValue({
      channels: [{ mean: 200, stdev: 5 }],
    });

    const result = await analyzeTile("/tiles/tile.webp", 0);
    expect(result.contentHint).toBe("text-heavy");
    expect(result.isBlank).toBe(false);
  });

  it("boundary: stdDev exactly 25 is mixed (not text-heavy)", async () => {
    mockStats.mockResolvedValue({
      channels: [{ mean: 128, stdev: 25 }],
    });

    const result = await analyzeTile("/tiles/tile.webp", 0);
    expect(result.contentHint).toBe("mixed");
  });

  it("boundary: stdDev exactly 60 is mixed (not image-rich)", async () => {
    mockStats.mockResolvedValue({
      channels: [{ mean: 128, stdev: 60 }],
    });

    const result = await analyzeTile("/tiles/tile.webp", 0);
    expect(result.contentHint).toBe("mixed");
  });

  it("throws on empty channels array (corrupted image)", async () => {
    mockStats.mockResolvedValue({ channels: [] });

    await expect(analyzeTile("/tiles/corrupt.webp", 5)).rejects.toThrow(
      "Unable to analyze tile at index 5: image has no color channels"
    );
  });
});

describe("analyzeTiles", () => {
  it("analyzes multiple tiles in parallel", async () => {
    mockStats.mockResolvedValue({
      channels: [
        { mean: 200, stdev: 10 },
        { mean: 200, stdev: 10 },
        { mean: 200, stdev: 10 },
      ],
    });

    const result = await analyzeTiles([
      "/tiles/tile_000_000.webp",
      "/tiles/tile_000_001.webp",
      "/tiles/tile_001_000.webp",
    ]);
    expect(result).toHaveLength(3);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(1);
    expect(result[2].index).toBe(2);
  });

  it("returns empty array for empty input", async () => {
    const result = await analyzeTiles([]);
    expect(result).toHaveLength(0);
  });
});
