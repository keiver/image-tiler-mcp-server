import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ImageMetadata } from "../types.js";
import { MODEL_CONFIGS } from "../constants.js";

vi.mock("../services/image-processor.js", () => ({
  getImageMetadata: vi.fn(),
  calculateGrid: vi.fn(),
  computeEstimateForModel: vi.fn(),
}));

vi.mock("../services/image-source-resolver.js", () => ({
  resolveImageSource: vi.fn(),
}));

vi.mock("../services/interactive-preview-generator.js", () => ({
  generateInteractivePreview: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(),
  copyFile: vi.fn(),
}));

vi.mock("node:os", () => ({
  tmpdir: vi.fn(() => "/tmp"),
}));

import { getImageMetadata, calculateGrid, computeEstimateForModel } from "../services/image-processor.js";
import { resolveImageSource } from "../services/image-source-resolver.js";
import { generateInteractivePreview } from "../services/interactive-preview-generator.js";
import { registerRecommendSettingsTool } from "../tools/recommend-settings.js";
import { createMockServer } from "./helpers/mock-server.js";

const mockedGetMetadata = vi.mocked(getImageMetadata);
const mockedCalculateGrid = vi.mocked(calculateGrid);
const mockedComputeEstimate = vi.mocked(computeEstimateForModel);
const mockedResolveSource = vi.mocked(resolveImageSource);
const mockedGeneratePreview = vi.mocked(generateInteractivePreview);

function gridImpl(w: number, h: number, tileSize: number, tokensPerTile?: number, maxTileSize?: number) {
  let cols = Math.ceil(w / tileSize);
  let rows = Math.ceil(h / tileSize);

  // Replicate absorption logic from the real implementation
  if (maxTileSize !== undefined) {
    const colRemainder = w % tileSize;
    if (colRemainder > 0 && colRemainder < 0.15 * tileSize && cols > 1) {
      if (tileSize + colRemainder <= maxTileSize) cols--;
    }
    const rowRemainder = h % tileSize;
    if (rowRemainder > 0 && rowRemainder < 0.15 * tileSize && rows > 1) {
      if (tileSize + rowRemainder <= maxTileSize) rows--;
    }
  }

  const totalTiles = cols * rows;
  return {
    cols,
    rows,
    totalTiles,
    tileSize,
    estimatedTokens: totalTiles * (tokensPerTile ?? 1590),
  };
}

function setupDefaultMocks(width = 7680, height = 4032) {
  mockedGeneratePreview.mockResolvedValue("/tmp/test-image-preview.html");
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
  // calculateGrid is called for the primary model estimate
  mockedCalculateGrid.mockImplementation(gridImpl);
  // computeEstimateForModel is called per model for allModels comparison
  mockedComputeEstimate.mockImplementation((modelKey, imageWidth, imageHeight, overrideTileSize, effectiveMaxDimension) => {
    const config = MODEL_CONFIGS[modelKey as keyof typeof MODEL_CONFIGS];
    let tileSize = overrideTileSize ?? config.defaultTileSize;
    tileSize = Math.max(config.minTileSize, Math.min(tileSize, config.maxTileSize));

    let w = imageWidth;
    let h = imageHeight;
    if (effectiveMaxDimension && effectiveMaxDimension > 0) {
      const longestSide = Math.max(w, h);
      if (longestSide > effectiveMaxDimension) {
        const scale = effectiveMaxDimension / longestSide;
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
    }

    const grid = gridImpl(w, h, tileSize, config.tokensPerTile, config.maxTileSize);
    return {
      model: modelKey,
      label: config.label,
      tileSize,
      cols: grid.cols,
      rows: grid.rows,
      tiles: grid.totalTiles,
      tokens: grid.estimatedTokens,
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

    it("text_heavy at exact 2.5 aspect ratio → no maxDimension change (threshold is >2.5)", async () => {
      // 2500 / 1000 = 2.5 exactly — should NOT trigger the reduction
      setupDefaultMocks(1000, 2500);
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler(
        { filePath: "exact-threshold.png", intent: "text_heavy" },
        {} as any
      );
      const json = JSON.parse((result as any).content[0].text);
      expect(json.recommended.maxDimension).toBe(10000);
    });

    it("text_heavy just above 2.5 aspect ratio → reduces maxDimension", async () => {
      // 2510 / 1000 = 2.51 — should trigger the reduction
      setupDefaultMocks(1000, 2510);
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler(
        { filePath: "just-above.png", intent: "text_heavy" },
        {} as any
      );
      const json = JSON.parse((result as any).content[0].text);
      expect(json.recommended.maxDimension).toBe(6000);
    });

    it("budget 'default' is a no-op", async () => {
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler(
        { filePath: "test.png", budget: "default" },
        {} as any
      );
      const json = JSON.parse((result as any).content[0].text);
      expect(json.recommended.maxDimension).toBe(10000);
      expect(json.rationale).toContain("Using default settings — no heuristic adjustments applied");
    });

    it("diagram with explicit tileSize → tileSize not overridden by heuristic", async () => {
      setupDefaultMocks(2000, 2000);
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler(
        { filePath: "diagram.png", intent: "diagram", tileSize: 900 },
        {} as any
      );
      const json = JSON.parse((result as any).content[0].text);
      // Explicit tileSize=900 should be used as-is; diagram heuristic skipped
      expect(json.recommended.tileSize).toBe(900);
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

  describe("interactive preview", () => {
    it("includes previewPath in response", async () => {
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler({ filePath: "test.png" }, {} as any);
      const json = JSON.parse((result as any).content[0].text);
      expect(json.previewPath).toBe("/tmp/test-image-preview.html");
    });

    it("calls generateInteractivePreview with correct data", async () => {
      const tool = mock.getTool("tiler_recommend_settings")!;
      await tool.handler({ filePath: "test.png" }, {} as any);
      expect(mockedGeneratePreview).toHaveBeenCalledTimes(1);
      const [data, outputDir] = mockedGeneratePreview.mock.calls[0];
      expect(data.recommendedModel).toBe("claude");
      expect(data.originalWidth).toBe(7680);
      expect(data.originalHeight).toBe(4032);
      expect(data.models).toHaveLength(4);
      expect(typeof outputDir).toBe("string");
    });

    it("allModels entries include cols and rows", async () => {
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler({ filePath: "test.png" }, {} as any);
      const json = JSON.parse((result as any).content[0].text);
      for (const m of json.allModels) {
        expect(m).toHaveProperty("cols");
        expect(m).toHaveProperty("rows");
        expect(typeof m.cols).toBe("number");
        expect(typeof m.rows).toBe("number");
      }
    });

    it("allModels entries include label from MODEL_CONFIGS", async () => {
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler({ filePath: "test.png" }, {} as any);
      const json = JSON.parse((result as any).content[0].text);
      const labels = json.allModels.map((m: any) => m.label);
      expect(labels).toContain("Claude");
      expect(labels).toContain("OpenAI");
      expect(labels).toContain("Gemini");
      expect(labels).toContain("Gemini 3");
    });

    it("preview failure adds warning but does not error", async () => {
      mockedGeneratePreview.mockRejectedValue(new Error("disk full"));
      const tool = mock.getTool("tiler_recommend_settings")!;
      const result = await tool.handler({ filePath: "test.png" }, {} as any);
      const res = result as any;
      expect(res.isError).toBeUndefined();
      const json = JSON.parse(res.content[0].text);
      expect(json.previewPath).toBeUndefined();
      expect(json.warnings).toContain("Preview generation failed: disk full");
    });
  });
});
