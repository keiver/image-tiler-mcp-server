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
  it("classifies blank (stdDev < 5) as blank + isBlank", async () => {
    mockStats.mockResolvedValue({
      channels: [
        { mean: 250, stdev: 2 },
        { mean: 250, stdev: 3 },
        { mean: 250, stdev: 1 },
      ],
      entropy: 0.1,
      sharpness: 0.05,
    });

    const result = await analyzeTile("/tiles/tile_000_000.webp", 0);
    expect(result.contentHint).toBe("blank");
    expect(result.isBlank).toBe(true);
    expect(result.index).toBe(0);
    expect(result.meanBrightness).toBe(250);
    expect(result.stdDev).toBe(2);
    expect(result.entropy).toBe(0.1);
    expect(result.sharpness).toBe(0.05);
  });

  it("classifies low-detail (entropy < 4.0, stdDev >= 5)", async () => {
    mockStats.mockResolvedValue({
      channels: [
        { mean: 200, stdev: 15 },
        { mean: 200, stdev: 15 },
        { mean: 200, stdev: 15 },
      ],
      entropy: 2.5,
      sharpness: 1.2,
    });

    const result = await analyzeTile("/tiles/tile_000_001.webp", 1);
    expect(result.contentHint).toBe("low-detail");
    expect(result.isBlank).toBe(false);
    expect(result.entropy).toBe(2.5);
    expect(result.sharpness).toBe(1.2);
  });

  it("classifies high-detail (entropy > 6.5)", async () => {
    mockStats.mockResolvedValue({
      channels: [
        { mean: 128, stdev: 70 },
        { mean: 100, stdev: 80 },
        { mean: 90, stdev: 65 },
      ],
      entropy: 7.2,
      sharpness: 4.5,
    });

    const result = await analyzeTile("/tiles/tile_001_000.webp", 2);
    expect(result.contentHint).toBe("high-detail");
    expect(result.isBlank).toBe(false);
    expect(result.entropy).toBe(7.2);
    expect(result.sharpness).toBe(4.5);
  });

  it("classifies mixed (4.0 <= entropy <= 6.5)", async () => {
    mockStats.mockResolvedValue({
      channels: [
        { mean: 150, stdev: 40 },
        { mean: 140, stdev: 35 },
        { mean: 130, stdev: 45 },
      ],
      entropy: 5.5,
      sharpness: 3.1,
    });

    const result = await analyzeTile("/tiles/tile_001_001.webp", 3);
    expect(result.contentHint).toBe("mixed");
    expect(result.isBlank).toBe(false);
    expect(result.entropy).toBe(5.5);
    expect(result.sharpness).toBe(3.1);
  });

  it("rounds meanBrightness, stdDev, entropy, and sharpness to 2 decimal places", async () => {
    mockStats.mockResolvedValue({
      channels: [
        { mean: 128.456, stdev: 33.789 },
        { mean: 129.123, stdev: 34.567 },
        { mean: 127.890, stdev: 33.123 },
      ],
      entropy: 5.6789,
      sharpness: 2.3456,
    });

    const result = await analyzeTile("/tiles/tile.webp", 0);
    expect(typeof result.meanBrightness).toBe("number");
    expect(typeof result.stdDev).toBe("number");
    expect(typeof result.entropy).toBe("number");
    expect(typeof result.sharpness).toBe("number");
    expect(result.meanBrightness.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
    expect(result.stdDev.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
    expect(result.entropy.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
    expect(result.sharpness.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("boundary: stdDev exactly 5 with low entropy is low-detail (not blank)", async () => {
    mockStats.mockResolvedValue({
      channels: [{ mean: 200, stdev: 5 }],
      entropy: 2.0,
      sharpness: 0.5,
    });

    const result = await analyzeTile("/tiles/tile.webp", 0);
    expect(result.contentHint).toBe("low-detail");
    expect(result.isBlank).toBe(false);
  });

  it("boundary: entropy exactly 4.0 is mixed (not low-detail)", async () => {
    mockStats.mockResolvedValue({
      channels: [{ mean: 128, stdev: 25 }],
      entropy: 4.0,
      sharpness: 2.0,
    });

    const result = await analyzeTile("/tiles/tile.webp", 0);
    expect(result.contentHint).toBe("mixed");
  });

  it("boundary: entropy exactly 6.5 is mixed (not high-detail)", async () => {
    mockStats.mockResolvedValue({
      channels: [{ mean: 128, stdev: 60 }],
      entropy: 6.5,
      sharpness: 3.0,
    });

    const result = await analyzeTile("/tiles/tile.webp", 0);
    expect(result.contentHint).toBe("mixed");
  });

  it("defaults entropy and sharpness to 0 when stats omits them", async () => {
    mockStats.mockResolvedValue({
      channels: [{ mean: 200, stdev: 15 }],
    });

    const result = await analyzeTile("/tiles/tile.webp", 0);
    expect(result.entropy).toBe(0);
    expect(result.sharpness).toBe(0);
    // With entropy=0 and stdDev>=5, classification should be "low-detail"
    expect(result.contentHint).toBe("low-detail");
  });

  it("high stdDev with low entropy classifies as low-detail (gradient pattern)", async () => {
    // Gradients have high stdDev but low information content (entropy)
    mockStats.mockResolvedValue({
      channels: [
        { mean: 128, stdev: 90 },
        { mean: 128, stdev: 90 },
        { mean: 128, stdev: 90 },
      ],
      entropy: 2.75,
      sharpness: 1.94,
    });

    const result = await analyzeTile("/tiles/tile.webp", 0);
    expect(result.contentHint).toBe("low-detail");
    expect(result.stdDev).toBe(90);
    expect(result.entropy).toBe(2.75);
  });

  it("throws on empty channels array (corrupted image)", async () => {
    mockStats.mockResolvedValue({ channels: [], entropy: 0, sharpness: 0 });

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
      entropy: 3.0,
      sharpness: 1.0,
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
    // All should have entropy and sharpness
    for (const tile of result) {
      expect(tile.entropy).toBe(3.0);
      expect(tile.sharpness).toBe(1.0);
    }
  });

  it("returns empty array for empty input", async () => {
    const result = await analyzeTiles([]);
    expect(result).toHaveLength(0);
  });
});
