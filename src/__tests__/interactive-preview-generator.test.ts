import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InteractivePreviewData } from "../services/interactive-preview-generator.js";

const { mockWriteFile, mockMetadata, mockToBuffer, mockWebp, mockResize, mockSharp } = vi.hoisted(() => {
  const mockWriteFile = vi.fn();
  const mockToBuffer = vi.fn().mockResolvedValue({ data: Buffer.from('fake-webp'), info: {} });
  const mockWebp = vi.fn().mockReturnValue({ toBuffer: mockToBuffer });
  const mockResize = vi.fn().mockReturnValue({ webp: mockWebp });
  const mockMetadata = vi.fn().mockResolvedValue({ width: 3000, height: 4000 }); // Under 16M pixels
  const mockSharp = vi.fn().mockReturnValue({
    metadata: mockMetadata,
    resize: mockResize,
    webp: mockWebp,
  });
  return { mockWriteFile, mockMetadata, mockToBuffer, mockWebp, mockResize, mockSharp };
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
    // Use a payload without "/" to avoid path.basename treating it as a directory separator
    const data = makePreviewData({
      sourceImagePath: '/images/<img onerror=alert(1)>.png',
    });
    await generateInteractivePreview(data, "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;img onerror");
  });

  it("tabs contain inline grid dimensions and token info (no separate stats panel)", async () => {
    await generateInteractivePreview(makePreviewData(), "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    // Stats are now inline in tab buttons, not a separate panel
    expect(html).not.toContain("stats-panel");
    expect(html).toContain("tab-stats");
    expect(html).toContain("grid");
    expect(html).toContain("tokens");
    // Disclaimer is present
    expect(html).toContain("Preview only");
    expect(html).toContain("tiles are cut from the original full-resolution image");
  });

  it("uses max-width (not width) to prevent upscale blur", async () => {
    await generateInteractivePreview(makePreviewData(), "/output");
    const html = mockWriteFile.mock.calls[0][1] as string;
    // img should use max-width to prevent stretching beyond native resolution
    expect(html).toContain("max-width: 100%");
    expect(html).toContain("preview-wrapper");
    // .source-container should be inline-block for centering
    expect(html).toContain("display: inline-block");
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

  it("img src is an embedded data URL, not a file path", async () => {
    const data = makePreviewData({ sourceImagePath: "/images/photo.png" });
    await generateInteractivePreview(data, "/images/tiles");
    const html = mockWriteFile.mock.calls[0][1] as string;
    expect(html).toContain('src="data:image/webp;base64,');
    expect(html).not.toContain("../photo.png");
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

  describe("preview image embedding", () => {
    it("does not resize when source is under 16M pixels and within dimension caps", async () => {
      mockMetadata.mockResolvedValueOnce({ width: 1000, height: 1000 }); // 1M pixels, under all caps
      await generateInteractivePreview(makePreviewData({ maxDimension: 10000 }), "/output");
      expect(mockResize).not.toHaveBeenCalled();
      // WebP + toBuffer should still be called (always produces embedded data URL)
      expect(mockWebp).toHaveBeenCalledWith({ quality: 80 });
      expect(mockToBuffer).toHaveBeenCalled();
      const html = mockWriteFile.mock.calls[0][1] as string;
      expect(html).toContain("data:image/webp;base64,");
    });

    it("resizes and embeds as data URL when source exceeds 16M pixels", async () => {
      mockMetadata.mockResolvedValueOnce({ width: 3600, height: 22810 }); // ~82M pixels
      const data = makePreviewData({ sourceImagePath: "/images/screenshot.png" });
      await generateInteractivePreview(data, "/output");

      // Called twice: once for metadata, once for resize pipeline
      expect(mockSharp).toHaveBeenCalledTimes(2);
      expect(mockResize).toHaveBeenCalledTimes(1);

      // Check resize dimensions are scaled down
      const [resizeW, resizeH] = mockResize.mock.calls[0];
      expect(resizeW * resizeH).toBeLessThanOrEqual(16_000_000);

      // WebP output as buffer (not file)
      expect(mockWebp).toHaveBeenCalledWith({ quality: 80 });
      expect(mockToBuffer).toHaveBeenCalled();

      // HTML img src is a data URL, not a file path
      const html = mockWriteFile.mock.calls[0][1] as string;
      expect(html).toContain("data:image/webp;base64,");
      expect(html).not.toContain("preview-bg");
    });

    it("resizes when longest dimension exceeds maxDimension even if under 16M pixels", async () => {
      mockMetadata.mockResolvedValueOnce({ width: 1200, height: 12000 }); // 14.4M pixels (under 16M), but height > 10k
      const data = makePreviewData({ sourceImagePath: "/images/tall-page.png" });
      await generateInteractivePreview(data, "/output");

      expect(mockSharp).toHaveBeenCalledTimes(2);
      expect(mockResize).toHaveBeenCalledTimes(1);

      const [resizeW, resizeH] = mockResize.mock.calls[0];
      // maxDimension (10000) is the only cap: scale = 10000/12000 = 0.833
      // Width 1000 >= 800, no floor adjustment needed
      expect(resizeW).toBe(Math.round(1200 * (10000 / 12000)));
      expect(resizeH).toBe(Math.round(12000 * (10000 / 12000)));

      // Embedded as data URL
      const html = mockWriteFile.mock.calls[0][1] as string;
      expect(html).toContain("data:image/webp;base64,");
    });

    it("uses the more restrictive limit when both pixel count and dimension exceed caps", async () => {
      mockMetadata.mockResolvedValueOnce({ width: 5000, height: 20000 }); // 100M pixels, height > 10k
      const data = makePreviewData({ sourceImagePath: "/images/huge.png" });
      await generateInteractivePreview(data, "/output");

      expect(mockResize).toHaveBeenCalledTimes(1);

      const [resizeW, resizeH] = mockResize.mock.calls[0];
      // Pixel cap: scale = sqrt(16M / 100M) = 0.4 → 2000×8000
      // maxDimension cap: scale = 10000/20000 = 0.5 → 2500×10000
      // Winner: 0.4 (pixel cap). Width 2000 >= 800, no floor adjustment.
      expect(Math.max(resizeW, resizeH)).toBeLessThanOrEqual(10000);
      expect(resizeW * resizeH).toBeLessThanOrEqual(16_000_000);
    });

    it("img src is a data URL, not a file path", async () => {
      const data = makePreviewData({ sourceImagePath: "/images/photo.png" });
      await generateInteractivePreview(data, "/images/tiles");
      const html = mockWriteFile.mock.calls[0][1] as string;
      // Should be a data URL, not a relative file path
      expect(html).toContain('src="data:image/webp;base64,');
      expect(html).not.toContain("../photo.png");
    });

    it("preserves SVG viewBox using effectiveWidth/Height even when preview is downsized", async () => {
      mockMetadata.mockResolvedValueOnce({ width: 5000, height: 20000 }); // 100M pixels
      await generateInteractivePreview(makePreviewData(), "/output");
      const html = mockWriteFile.mock.calls[0][1] as string;
      // viewBox should still use effective dimensions (7680 x 4032), not the downsized preview dims
      expect(html).toContain('viewBox="0 0 7680 4032"');
    });

    it("width floor prevents tall-image crush", async () => {
      // 1800×16191: maxDim cap scale = 3000/16191 = 0.185 → width 333px (too narrow)
      // Width floor: scale = 800/1800 = 0.444 → 800×7196
      mockMetadata.mockResolvedValueOnce({ width: 1800, height: 16191 });
      const data = makePreviewData({ sourceImagePath: "/images/tall.png", maxDimension: 3000 });
      await generateInteractivePreview(data, "/output");

      expect(mockResize).toHaveBeenCalledTimes(1);
      const [resizeW] = mockResize.mock.calls[0];
      expect(resizeW).toBeGreaterThanOrEqual(800);
    });

    it("width floor does not upscale narrow sources", async () => {
      // 400×5000: all under caps (5000 < 10000, 2M pixels < 16M), scale stays 1
      // Width 400 < 800 but source IS 400px — can't upscale
      mockMetadata.mockResolvedValueOnce({ width: 400, height: 5000 });
      const data = makePreviewData({ sourceImagePath: "/images/narrow.png" });
      await generateInteractivePreview(data, "/output");

      expect(mockResize).not.toHaveBeenCalled();
    });
  });
});
