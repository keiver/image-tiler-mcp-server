import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockHomedir, mockAccessSync, mockReaddir } = vi.hoisted(() => ({
  mockHomedir: vi.fn().mockReturnValue("/Users/test"),
  mockAccessSync: vi.fn(),
  mockReaddir: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

vi.mock("node:fs", () => ({
  accessSync: mockAccessSync,
}));

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
}));

import { escapeHtml, getDefaultOutputBase, getVersionedOutputDir, sanitizeHostname, getVersionedFilePath, stripVersionSuffix, buildTileHints, formatModelComparisonTable, simulateDownscale, withTimeout } from "../utils.js";
import type { TileMetadata, ModelEstimate } from "../types.js";

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes less-than", () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });

  it("escapes greater-than", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it("escapes double quote", () => {
    expect(escapeHtml('a"b')).toBe("a&quot;b");
  });

  it("escapes single quote", () => {
    expect(escapeHtml("a'b")).toBe("a&#39;b");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("returns string with no special chars unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("escapes all special chars in a mixed string", () => {
    expect(escapeHtml(`<script>alert("x'&'y")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&#39;&amp;&#39;y&quot;)&lt;/script&gt;"
    );
  });

  it("escapes multiple occurrences of the same char", () => {
    expect(escapeHtml("<<>>")).toBe("&lt;&lt;&gt;&gt;");
  });
});

describe("getDefaultOutputBase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHomedir.mockReturnValue("/Users/test");
  });

  it("returns Desktop when it exists", () => {
    mockAccessSync.mockImplementation(() => {});
    expect(getDefaultOutputBase()).toBe("/Users/test/Desktop");
  });

  it("returns Downloads when Desktop does not exist", () => {
    mockAccessSync.mockImplementation((p: string) => {
      if (String(p).includes("Desktop")) throw new Error("not found");
    });
    expect(getDefaultOutputBase()).toBe("/Users/test/Downloads");
  });

  it("returns homedir when neither Desktop nor Downloads exist", () => {
    mockAccessSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(getDefaultOutputBase()).toBe("/Users/test");
  });
});

describe("getVersionedOutputDir", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns _v1 when parent directory does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const result = await getVersionedOutputDir("/some/tiles/photo");
    expect(result).toBe("/some/tiles/photo_v1");
  });

  it("returns _v1 when no versioned dirs exist", async () => {
    mockReaddir.mockResolvedValue(["unrelated"]);
    const result = await getVersionedOutputDir("/some/tiles/photo");
    expect(result).toBe("/some/tiles/photo_v1");
  });

  it("returns _v2 when _v1 exists", async () => {
    mockReaddir.mockResolvedValue(["photo_v1"]);
    const result = await getVersionedOutputDir("/some/tiles/photo");
    expect(result).toBe("/some/tiles/photo_v2");
  });

  it("returns _v4 when _v1 through _v3 exist", async () => {
    mockReaddir.mockResolvedValue(["photo_v1", "photo_v2", "photo_v3"]);
    const result = await getVersionedOutputDir("/some/tiles/photo");
    expect(result).toBe("/some/tiles/photo_v4");
  });

  it("ignores non-numeric suffixes", async () => {
    mockReaddir.mockResolvedValue(["photo_vfoo", "photo_vbar"]);
    const result = await getVersionedOutputDir("/some/tiles/photo");
    expect(result).toBe("/some/tiles/photo_v1");
  });

  it("picks max+1 when versions have gaps", async () => {
    mockReaddir.mockResolvedValue(["photo_v1", "photo_v5"]);
    const result = await getVersionedOutputDir("/some/tiles/photo");
    expect(result).toBe("/some/tiles/photo_v6");
  });
});

describe("sanitizeHostname", () => {
  it("converts dots to hyphens", () => {
    expect(sanitizeHostname("https://example.com/page")).toBe("example-com");
  });

  it("handles subdomains", () => {
    expect(sanitizeHostname("https://www.example.com/page")).toBe("www-example-com");
  });

  it("handles IP addresses", () => {
    expect(sanitizeHostname("https://10.81.1.142:3000/")).toBe("10-81-1-142");
  });

  it("handles localhost", () => {
    expect(sanitizeHostname("http://localhost:3000")).toBe("localhost");
  });

  it("returns fallback for invalid URL", () => {
    expect(sanitizeHostname("not-a-url")).toBe("screenshot");
  });

  it("returns fallback for empty string", () => {
    expect(sanitizeHostname("")).toBe("screenshot");
  });

  it("truncates long hostnames to 60 chars", () => {
    const longHost = "a".repeat(80) + ".com";
    const result = sanitizeHostname(`https://${longHost}/page`);
    expect(result.length).toBeLessThanOrEqual(60);
  });
});

describe("getVersionedFilePath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns _v1 when directory does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const result = await getVersionedFilePath("/some/captures", "example-com", "webp");
    expect(result).toBe("/some/captures/example-com_v1.webp");
  });

  it("returns _v1 when no versioned files exist", async () => {
    mockReaddir.mockResolvedValue(["unrelated.txt"]);
    const result = await getVersionedFilePath("/some/captures", "example-com", "webp");
    expect(result).toBe("/some/captures/example-com_v1.webp");
  });

  it("returns _v2 when _v1 exists", async () => {
    mockReaddir.mockResolvedValue(["example-com_v1.webp"]);
    const result = await getVersionedFilePath("/some/captures", "example-com", "webp");
    expect(result).toBe("/some/captures/example-com_v2.webp");
  });

  it("returns _v4 when _v1 through _v3 exist", async () => {
    mockReaddir.mockResolvedValue([
      "example-com_v1.webp",
      "example-com_v2.webp",
      "example-com_v3.webp",
    ]);
    const result = await getVersionedFilePath("/some/captures", "example-com", "webp");
    expect(result).toBe("/some/captures/example-com_v4.webp");
  });

  it("ignores non-numeric suffixes", async () => {
    mockReaddir.mockResolvedValue(["example-com_vfoo.webp"]);
    const result = await getVersionedFilePath("/some/captures", "example-com", "webp");
    expect(result).toBe("/some/captures/example-com_v1.webp");
  });

  it("picks max+1 when versions have gaps", async () => {
    mockReaddir.mockResolvedValue(["example-com_v1.webp", "example-com_v5.webp"]);
    const result = await getVersionedFilePath("/some/captures", "example-com", "webp");
    expect(result).toBe("/some/captures/example-com_v6.webp");
  });

  it("works with png extension", async () => {
    mockReaddir.mockResolvedValue(["example-com_v1.png"]);
    const result = await getVersionedFilePath("/some/captures", "example-com", "png");
    expect(result).toBe("/some/captures/example-com_v2.png");
  });
});

describe("stripVersionSuffix", () => {
  it("strips _v1 suffix", () => {
    expect(stripVersionSuffix("photo_v1")).toBe("photo");
  });

  it("strips _v123 suffix", () => {
    expect(stripVersionSuffix("photo_v123")).toBe("photo");
  });

  it("returns name unchanged when no version suffix", () => {
    expect(stripVersionSuffix("photo")).toBe("photo");
  });

  it("does not strip _v mid-string (e.g. my_video)", () => {
    expect(stripVersionSuffix("my_video")).toBe("my_video");
  });

  it("strips version suffix from hyphenated names", () => {
    expect(stripVersionSuffix("keiver-dev_v1")).toBe("keiver-dev");
  });

  it("returns empty string unchanged", () => {
    expect(stripVersionSuffix("")).toBe("");
  });

  it("only strips the final _vN suffix", () => {
    expect(stripVersionSuffix("file_v1_v2")).toBe("file_v1");
  });
});

describe("formatModelComparisonTable", () => {
  const allModels: ModelEstimate[] = [
    { model: "claude", label: "Claude", tileSize: 1092, cols: 2, rows: 2, tiles: 4, tokens: 6360 },
    { model: "openai", label: "OpenAI", tileSize: 768, cols: 3, rows: 3, tiles: 9, tokens: 6885 },
    { model: "gemini", label: "Gemini", tileSize: 768, cols: 3, rows: 3, tiles: 9, tokens: 2322 },
    { model: "gemini3", label: "Gemini 3", tileSize: 1536, cols: 2, rows: 2, tiles: 4, tokens: 4480 },
  ];

  it("includes image dimensions", () => {
    const result = formatModelComparisonTable(2144, 2144, allModels);
    expect(result).toContain("Image: 2144 x 2144");
  });

  it("includes table headers", () => {
    const result = formatModelComparisonTable(2144, 2144, allModels);
    expect(result).toContain("Preset");
    expect(result).toContain("Tile Size");
    expect(result).toContain("Grid");
    expect(result).toContain("Tiles");
    expect(result).toContain("Est. Tokens");
  });

  it("includes all model names", () => {
    const result = formatModelComparisonTable(2144, 2144, allModels);
    expect(result).toContain("claude");
    expect(result).toContain("openai");
    expect(result).toContain("gemini ");
    expect(result).toContain("gemini3");
  });

  it("does not include confirmation instruction (moved to pipeline)", () => {
    const result = formatModelComparisonTable(2144, 2144, allModels);
    expect(result).not.toContain("confirmed=true");
  });

  it("handles empty models array", () => {
    const result = formatModelComparisonTable(100, 100, []);
    expect(result).toContain("Image: 100 x 100");
    expect(result).toContain("Preset");
  });

  it("shows resize arrow when effectiveWidth/Height differ from original", () => {
    const result = formatModelComparisonTable(3600, 22810, allModels, 1579, 10000);
    expect(result).toContain("3600 \u00d7 22810 \u2192 1579 \u00d7 10000");
    expect(result).not.toContain("Image: 3600 x 22810\n");
  });

  it("does not show resize arrow when effective matches original", () => {
    const result = formatModelComparisonTable(2144, 2144, allModels, 2144, 2144);
    expect(result).toContain("Image: 2144 x 2144");
    expect(result).not.toContain("\u2192");
  });

  it("does not show resize arrow when effective params are omitted", () => {
    const result = formatModelComparisonTable(2144, 2144, allModels);
    expect(result).toContain("Image: 2144 x 2144");
    expect(result).not.toContain("\u2192");
  });
});

describe("buildTileHints", () => {
  it("groups tiles by content hint", () => {
    const metadata: TileMetadata[] = [
      { index: 0, contentHint: "text-heavy", meanBrightness: 200, stdDev: 15, isBlank: false },
      { index: 1, contentHint: "image-rich", meanBrightness: 128, stdDev: 65, isBlank: false },
      { index: 2, contentHint: "mixed", meanBrightness: 150, stdDev: 40, isBlank: false },
      { index: 3, contentHint: "text-heavy", meanBrightness: 210, stdDev: 12, isBlank: false },
    ];
    const hints = buildTileHints(metadata);
    expect(hints["text-heavy"]).toEqual([0, 3]);
    expect(hints["image-rich"]).toEqual([1]);
    expect(hints["mixed"]).toEqual([2]);
  });

  it("uses 'blank' key for blank tiles regardless of contentHint", () => {
    const metadata: TileMetadata[] = [
      { index: 0, contentHint: "low-detail", meanBrightness: 250, stdDev: 2, isBlank: true },
      { index: 1, contentHint: "low-detail", meanBrightness: 248, stdDev: 3, isBlank: true },
      { index: 2, contentHint: "text-heavy", meanBrightness: 200, stdDev: 15, isBlank: false },
    ];
    const hints = buildTileHints(metadata);
    expect(hints["blank"]).toEqual([0, 1]);
    expect(hints["text-heavy"]).toEqual([2]);
    expect(hints["low-detail"]).toBeUndefined();
  });

  it("returns empty object for empty input", () => {
    expect(buildTileHints([])).toEqual({});
  });

  it("handles single tile", () => {
    const metadata: TileMetadata[] = [
      { index: 0, contentHint: "mixed", meanBrightness: 150, stdDev: 40, isBlank: false },
    ];
    expect(buildTileHints(metadata)).toEqual({ mixed: [0] });
  });
});

describe("simulateDownscale", () => {
  it("returns original dimensions when within limit", () => {
    expect(simulateDownscale(800, 600, 1000)).toEqual({ width: 800, height: 600 });
  });

  it("downscales landscape image by longest side", () => {
    const result = simulateDownscale(2000, 1000, 1000);
    expect(result).toEqual({ width: 1000, height: 500 });
  });

  it("downscales portrait image by longest side", () => {
    const result = simulateDownscale(1000, 2000, 1000);
    expect(result).toEqual({ width: 500, height: 1000 });
  });

  it("returns original dimensions at exact boundary", () => {
    expect(simulateDownscale(1000, 1000, 1000)).toEqual({ width: 1000, height: 1000 });
  });

  it("returns original dimensions when maxDimension is 0 (passthrough)", () => {
    expect(simulateDownscale(5000, 3000, 0)).toEqual({ width: 5000, height: 3000 });
  });

  it("returns original dimensions when maxDimension is negative", () => {
    expect(simulateDownscale(5000, 3000, -1)).toEqual({ width: 5000, height: 3000 });
  });

  it("downscales square image", () => {
    const result = simulateDownscale(2000, 2000, 1000);
    expect(result).toEqual({ width: 1000, height: 1000 });
  });

  it("rounds dimensions to nearest integer", () => {
    const result = simulateDownscale(3000, 1999, 1000);
    expect(result.width).toBe(Math.round(3000 * (1000 / 3000)));
    expect(result.height).toBe(Math.round(1999 * (1000 / 3000)));
    expect(Number.isInteger(result.width)).toBe(true);
    expect(Number.isInteger(result.height)).toBe(true);
  });
});

describe("withTimeout", () => {
  it("resolves when promise resolves before timeout", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, "test");
    expect(result).toBe(42);
  });

  it("rejects when promise rejects before timeout", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 1000, "test")
    ).rejects.toThrow("boom");
  });

  it("rejects with timeout error when promise takes too long", async () => {
    const slow = new Promise(() => {}); // never resolves
    await expect(
      withTimeout(slow, 50, "test-op")
    ).rejects.toThrow("Sharp operation timed out after 50ms (test-op)");
  });

  it("clears timer when promise resolves first (no leaked timers)", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await withTimeout(Promise.resolve("ok"), 30000, "test");
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
