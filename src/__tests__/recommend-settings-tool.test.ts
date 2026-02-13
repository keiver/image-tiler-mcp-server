import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ImageMetadata } from "../types.js";

vi.mock("../services/image-processor.js", () => ({
  getImageMetadata: vi.fn(),
  calculateGrid: vi.fn(),
}));

vi.mock("../services/image-source-resolver.js", () => ({
  resolveImageSource: vi.fn(),
}));

import { getImageMetadata, calculateGrid } from "../services/image-processor.js";
import { resolveImageSource } from "../services/image-source-resolver.js";
import { registerRecommendSettingsTool } from "../tools/recommend-settings.js";
import { createMockServer } from "./helpers/mock-server.js";

const mockedGetMetadata = vi.mocked(getImageMetadata);
const mockedCalculateGrid = vi.mocked(calculateGrid);
const mockedResolveSource = vi.mocked(resolveImageSource);

function setupDefaultMocks(width = 7680, height = 4032) {
  mockedResolveSource.mockResolvedValue({
    localPath: "/tmp/test-image.png",
    sourceType: "file",
    originalSource: "/tmp/test-image.png",
  });
  mockedGetMetadata.mockResolvedValue({
    width,
    height,
    format: "png",
    fileSize: 1000000,
    channels: 4,
  } as ImageMetadata);
  // calculateGrid is called multiple times (once for primary, once per model in allModels)
  mockedCalculateGrid.mockImplementation((w, h, tileSize, tokensPerTile) => {
    const cols = Math.ceil(w / tileSize);
    const rows = Math.ceil(h / tileSize);
    const totalTiles = cols * rows;
    return {
      cols,
      rows,
      totalTiles,
      tileSize,
      estimatedTokens: totalTiles * (tokensPerTile ?? 1590),
    };
  });
}

describe("registerRecommendSettingsTool", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerRecommendSettingsTool(mock.server as any);
    setupDefaultMocks();
  });

  it("registers the tool with correct name", () => {
    expect(mock.server.registerTool).toHaveBeenCalledWith(
      "tiler_recommend_settings",
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("returns recommendation JSON for a basic filePath request", async () => {
    const tool = mock.getTool("tiler_recommend_settings")!;
    const result = await tool.handler(
      { filePath: "test.png" },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBeUndefined();
    const json = JSON.parse(res.content[0].text);
    expect(json.recommended).toBeDefined();
    expect(json.recommended.model).toBe("claude");
    expect(json.imageInfo.width).toBe(7680);
    expect(json.imageInfo.height).toBe(4032);
    expect(json.allModels).toHaveLength(4);
  });

  it("returns estimates for all 4 models", async () => {
    const tool = mock.getTool("tiler_recommend_settings")!;
    const result = await tool.handler(
      { filePath: "test.png" },
      {} as any
    );
    const json = JSON.parse((result as any).content[0].text);
    const modelNames = json.allModels.map((m: any) => m.model);
    expect(modelNames).toContain("claude");
    expect(modelNames).toContain("openai");
    expect(modelNames).toContain("gemini");
    expect(modelNames).toContain("gemini3");
  });

  it("uses specified model instead of default", async () => {
    const tool = mock.getTool("tiler_recommend_settings")!;
    const result = await tool.handler(
      { filePath: "test.png", model: "openai" },
      {} as any
    );
    const json = JSON.parse((result as any).content[0].text);
    expect(json.recommended.model).toBe("openai");
  });

  it("respects explicit tileSize (skips heuristics)", async () => {
    const tool = mock.getTool("tiler_recommend_settings")!;
    const result = await tool.handler(
      { filePath: "test.png", tileSize: 800 },
      {} as any
    );
    const json = JSON.parse((result as any).content[0].text);
    expect(json.recommended.tileSize).toBe(800);
  });

  it("respects explicit maxDimension", async () => {
    const tool = mock.getTool("tiler_recommend_settings")!;
    const result = await tool.handler(
      { filePath: "test.png", maxDimension: 5000 },
      {} as any
    );
    const json = JSON.parse((result as any).content[0].text);
    expect(json.recommended.maxDimension).toBe(5000);
  });

  describe("heuristics", () => {
    it("text_heavy + tall aspect ratio → reduces maxDimension", async () => {
      setupDefaultMocks(3600, 22810); // aspect ratio ~6.3
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler(
        { filePath: "long-scroll.png", intent: "text_heavy" },
        {} as any
      );
      const json = JSON.parse((result as any).content[0].text);
      expect(json.recommended.maxDimension).toBe(6000);
      expect(json.rationale.some((r: string) => r.includes("text-heavy"))).toBe(true);
    });

    it("text_heavy with normal aspect ratio → no change", async () => {
      setupDefaultMocks(1920, 1080); // aspect ratio ~1.78
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler(
        { filePath: "screenshot.png", intent: "text_heavy" },
        {} as any
      );
      const json = JSON.parse((result as any).content[0].text);
      expect(json.recommended.maxDimension).toBe(10000);
    });

    it("diagram → increases tile size", async () => {
      setupDefaultMocks(2000, 2000);
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler(
        { filePath: "diagram.png", intent: "diagram" },
        {} as any
      );
      const json = JSON.parse((result as any).content[0].text);
      // Claude default 1092 * 1.3 = 1420, within max 1568
      expect(json.recommended.tileSize).toBe(1420);
      expect(json.rationale.some((r: string) => r.includes("Diagram"))).toBe(true);
    });

    it("low budget → reduces maxDimension by 40%", async () => {
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler(
        { filePath: "test.png", budget: "low" },
        {} as any
      );
      const json = JSON.parse((result as any).content[0].text);
      expect(json.recommended.maxDimension).toBe(6000); // 10000 * 0.6
    });

    it("max_detail → increases maxDimension to 15000", async () => {
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler(
        { filePath: "test.png", budget: "max_detail" },
        {} as any
      );
      const json = JSON.parse((result as any).content[0].text);
      expect(json.recommended.maxDimension).toBe(15000);
    });

    it("intent + budget stack: text_heavy + low on tall image", async () => {
      setupDefaultMocks(3600, 22810);
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler(
        { filePath: "doc.png", intent: "text_heavy", budget: "low" },
        {} as any
      );
      const json = JSON.parse((result as any).content[0].text);
      // text_heavy caps to 6000, then low reduces by 40% → 3600
      expect(json.recommended.maxDimension).toBe(3600);
    });

    it("explicit maxDimension skips all heuristics for that param", async () => {
      setupDefaultMocks(3600, 22810);
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler(
        { filePath: "doc.png", intent: "text_heavy", budget: "low", maxDimension: 8000 },
        {} as any
      );
      const json = JSON.parse((result as any).content[0].text);
      expect(json.recommended.maxDimension).toBe(8000);
    });
  });

  it("calls resolveImageSource and cleans up on success", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    mockedResolveSource.mockResolvedValue({
      localPath: "/tmp/test.png",
      sourceType: "url",
      originalSource: "https://example.com/img.png",
      cleanup,
    });

    const tool = mock.getTool("tiler_recommend_settings")!;
    await tool.handler({ sourceUrl: "https://example.com/img.png" }, {} as any);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans up even on error", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    mockedResolveSource.mockResolvedValue({
      localPath: "/tmp/test.png",
      sourceType: "file",
      originalSource: "/tmp/test.png",
      cleanup,
    });
    mockedGetMetadata.mockRejectedValue(new Error("bad image"));

    const tool = mock.getTool("tiler_recommend_settings")!;
    const result = await tool.handler({ filePath: "bad.png" }, {} as any);
    expect((result as any).isError).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("wraps errors from getImageMetadata", async () => {
    mockedGetMetadata.mockRejectedValue(new Error("corrupt file"));
    const tool = mock.getTool("tiler_recommend_settings")!;
    const result = await tool.handler({ filePath: "bad.png" }, {} as any);
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Error analyzing image");
    expect(res.content[0].text).toContain("corrupt file");
  });

  it("calculates megapixels correctly", async () => {
    setupDefaultMocks(7680, 4032);
    const tool = mock.getTool("tiler_recommend_settings")!;
    const result = await tool.handler({ filePath: "test.png" }, {} as any);
    const json = JSON.parse((result as any).content[0].text);
    // 7680 * 4032 = 30,965,760 → 30.97 megapixels
    expect(json.imageInfo.megapixels).toBe(30.97);
  });
});
