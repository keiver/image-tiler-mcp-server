import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InteractivePreviewData } from "../services/interactive-preview-generator.js";

const { mockWriteFile, mockMetadata, mockToFile, mockWebp, mockResize, mockSharp } = vi.hoisted(() => {
  const mockWriteFile = vi.fn();
  const mockToFile = vi.fn().mockResolvedValue({});
  const mockWebp = vi.fn().mockReturnValue({ toFile: mockToFile });
  const mockResize = vi.fn().mockReturnValue({ webp: mockWebp });
  const mockMetadata = vi.fn().mockResolvedValue({ width: 3000, height: 4000 }); // Under 16M pixels
  const mockSharp = vi.fn().mockReturnValue({
    metadata: mockMetadata,
    resize: mockResize,
  });
  return { mockWriteFile, mockMetadata, mockToFile, mockWebp, mockResize, mockSharp };
});

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
}));

vi.mock("sharp", () => ({
  default: mockSharp,
}));

import { generateInteractivePreview } from "../services/interactive-preview-generator.js";

function makePreviewData(overrides?: Partial<InteractivePreviewData>): InteractivePreviewData {
  return {
    sourceImagePath: "/images/photo.png",
    effectiveWidth: 7680,
    effectiveHeight: 4032,
    originalWidth: 7680,
    originalHeight: 4032,
    maxDimension: 10000,
    recommendedModel: "claude",
    models: [
      { model: "claude", label: "Claude", tileSize: 1092, cols: 8, rows: 4, tiles: 32, tokens: 50880 },
      { model: "openai", label: "OpenAI", tileSize: 768, cols: 10, rows: 6, tiles: 60, tokens: 45900 },
      { model: "gemini", label: "Gemini", tileSize: 768, cols: 10, rows: 6, tiles: 60, tokens: 15480 },
      { model: "gemini3", label: "Gemini 3", tileSize: 1536, cols: 5, rows: 3, tiles: 15, tokens: 16800 },
    ],
    ...overrides,
  };
}

describe("generateInteractivePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
  });

  it("writes preview.html to the output directory", async () => {
    const previewPath = await generateInteractivePreview(makePreviewData(), "/output");

    expect(previewPath).toBe("/output/photo-preview.html");
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/output/photo-preview.html",
      expect.any(String),
      "utf-8"
    );
  });

  it("HTML contains DOCTYPE declaration", async () => {
    await generateInteractivePreview(makePreviewData(), "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("HTML contains all 4 model tabs", async () => {
    await generateInteractivePreview(makePreviewData(), "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    // Models are embedded in JSON data
    expect(html).toContain('"claude"');
    expect(html).toContain('"openai"');
    expect(html).toContain('"gemini"');
    expect(html).toContain('"gemini3"');
  });

  it("HTML contains source image dimensions", async () => {
    await generateInteractivePreview(makePreviewData(), "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("7680");
    expect(html).toContain("4032");
  });

  it("SVG viewBox matches effective dimensions", async () => {
    await generateInteractivePreview(makePreviewData(), "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain('viewBox="0 0 7680 4032"');
  });

  it("embedded JSON has all model grid data including label", async () => {
    await generateInteractivePreview(makePreviewData(), "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    // Extract the MODELS JSON from the script
    const modelsMatch = html.match(/var MODELS = (\[.*?\]);/s);
    expect(modelsMatch).not.toBeNull();
    const models = JSON.parse(modelsMatch![1]);
    expect(models).toHaveLength(4);
    expect(models[0]).toEqual({
      model: "claude",
      label: "Claude",
      tileSize: 1092,
      cols: 8,
      rows: 4,
      tiles: 32,
      tokens: 50880,
    });
  });

  it("HTML-escapes filenames to prevent XSS", async () => {
    const data = makePreviewData({
      sourceImagePath: '/images/<script>alert("xss")</script>.png',
    });
    await generateInteractivePreview(data, "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("tabs contain inline tile count and token info (no separate stats panel)", async () => {
    await generateInteractivePreview(makePreviewData(), "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    // Stats are now inline in tab buttons, not a separate panel
    expect(html).not.toContain("stats-panel");
    expect(html).toContain("tab-stats");
    expect(html).toContain("tiles");
    expect(html).toContain("tokens");
  });

  it("contains footer credit line", async () => {
    await generateInteractivePreview(makePreviewData(), "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("Generated by image-tiler-mcp-server");
    expect(html).toContain("safe to delete");
  });

  it("shows original and effective dimensions in h1 when resized", async () => {
    const data = makePreviewData({
      effectiveWidth: 5000,
      effectiveHeight: 2625,
      originalWidth: 7680,
      originalHeight: 4032,
    });
    await generateInteractivePreview(data, "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    // h1 should contain both original and effective dimensions with arrow
    expect(html).toMatch(/<h1>.*7680.*4032.*5000.*2625.*<\/h1>/);
    expect(html).toContain("\u2192"); // arrow between original → effective
  });

  it("does not show effective dimensions when not resized", async () => {
    await generateInteractivePreview(makePreviewData(), "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).not.toContain("\u2192");
  });

  it("source image uses relative path from output dir", async () => {
    const data = makePreviewData({ sourceImagePath: "/images/photo.png" });
    await generateInteractivePreview(data, "/images/tiles");
    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("../photo.png");
  });

  it("header contains filename and dimensions in h1", async () => {
    await generateInteractivePreview(makePreviewData(), "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("photo.png");
    expect(html).toMatch(/<h1>.*7680.*4032.*<\/h1>/);
  });

  it("contains subtitle explaining tiling presets", async () => {
    await generateInteractivePreview(makePreviewData(), "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("Pick the tiling preset that matches your LLM");
  });

  it("first model in list is selected by default", async () => {
    await generateInteractivePreview(makePreviewData(), "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain("var activeModel = MODELS[0].model");
  });

  describe("preview image downsizing", () => {
    it("does not downsize when source is under 16M pixels", async () => {
      mockMetadata.mockResolvedValueOnce({ width: 3000, height: 4000 }); // 12M pixels
      await generateInteractivePreview(makePreviewData(), "/output");
      // resize should not be called
      expect(mockResize).not.toHaveBeenCalled();
      const html = mockWriteFile.mock.calls[0][1] as string;
      expect(html).not.toContain("preview-bg");
    });

    it("downsizes when source exceeds 16M pixels", async () => {
      mockMetadata.mockResolvedValueOnce({ width: 3600, height: 22810 }); // ~82M pixels
      const data = makePreviewData({ sourceImagePath: "/images/screenshot.png" });
      await generateInteractivePreview(data, "/output");

      // Should have called sharp twice: once for metadata, once for resize
      expect(mockSharp).toHaveBeenCalledTimes(2);
      expect(mockResize).toHaveBeenCalledTimes(1);

      // Check resize dimensions are scaled to fit under 16M pixels
      const [resizeW, resizeH] = mockResize.mock.calls[0];
      expect(resizeW * resizeH).toBeLessThanOrEqual(16_000_000);
      expect(resizeW * resizeH).toBeGreaterThan(15_000_000); // Close to limit

      // WebP output for preview background
      expect(mockWebp).toHaveBeenCalledWith({ quality: 80 });
      expect(mockToFile).toHaveBeenCalledWith("/output/screenshot-preview-bg.webp");

      // HTML img src references the preview-bg file
      const html = mockWriteFile.mock.calls[0][1] as string;
      expect(html).toContain("screenshot-preview-bg.webp");
    });

    it("downsizes when longest dimension exceeds 10,000px even if under 16M pixels", async () => {
      mockMetadata.mockResolvedValueOnce({ width: 1200, height: 12000 }); // 14.4M pixels (under 16M), but height > 10k
      const data = makePreviewData({ sourceImagePath: "/images/tall-page.png" });
      await generateInteractivePreview(data, "/output");

      expect(mockSharp).toHaveBeenCalledTimes(2);
      expect(mockResize).toHaveBeenCalledTimes(1);

      const [resizeW, resizeH] = mockResize.mock.calls[0];
      // Height should be clamped to 10,000 (scale = 10000/12000 ≈ 0.8333)
      expect(resizeH).toBe(10000);
      expect(resizeW).toBe(Math.round(1200 * (10000 / 12000)));

      expect(mockToFile).toHaveBeenCalledWith("/output/tall-page-preview-bg.webp");
    });

    it("uses the more restrictive limit when both pixel count and dimension exceed caps", async () => {
      mockMetadata.mockResolvedValueOnce({ width: 5000, height: 20000 }); // 100M pixels, height > 10k
      const data = makePreviewData({ sourceImagePath: "/images/huge.png" });
      await generateInteractivePreview(data, "/output");

      expect(mockResize).toHaveBeenCalledTimes(1);

      const [resizeW, resizeH] = mockResize.mock.calls[0];
      // Both constraints apply — the more restrictive one wins
      expect(Math.max(resizeW, resizeH)).toBeLessThanOrEqual(10000);
      expect(resizeW * resizeH).toBeLessThanOrEqual(16_000_000);
    });

    it("preserves SVG viewBox using effectiveWidth/Height even when preview is downsized", async () => {
      mockMetadata.mockResolvedValueOnce({ width: 5000, height: 20000 }); // 100M pixels
      await generateInteractivePreview(makePreviewData(), "/output");
      const html = mockWriteFile.mock.calls[0][1] as string;
      // viewBox should still use effective dimensions (7680 x 4032), not the downsized preview dims
      expect(html).toContain('viewBox="0 0 7680 4032"');
    });
  });
});
