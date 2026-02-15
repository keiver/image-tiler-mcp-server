import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/url-capture.js", () => ({
  captureUrl: vi.fn(),
  detectDisplayWidth: vi.fn(),
}));

vi.mock("../utils.js", () => ({
  getDefaultOutputBase: vi.fn().mockReturnValue("/Users/test/Desktop"),
  escapeHtml: vi.fn((s: string) => s),
}));

vi.mock("sharp", () => {
  const mockToFile = vi.fn().mockResolvedValue({});
  const mockPng = vi.fn().mockReturnValue({ toFile: mockToFile });
  const mockWebp = vi.fn().mockReturnValue({ toFile: mockToFile });
  const mockSharpInstance = { png: mockPng, webp: mockWebp, toFile: mockToFile };
  const mockSharp = Object.assign(
    vi.fn().mockReturnValue(mockSharpInstance),
    { cache: vi.fn(), concurrency: vi.fn() }
  );
  return { default: mockSharp };
});

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 12345 }),
}));

import { captureUrl } from "../services/url-capture.js";
import { registerCaptureUrlTool } from "../tools/capture-url.js";
import { createMockServer } from "./helpers/mock-server.js";

const mockedCaptureUrl = vi.mocked(captureUrl);

describe("registerCaptureUrlTool", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerCaptureUrlTool(mock.server as any);

    mockedCaptureUrl.mockResolvedValue({
      buffer: Buffer.from("screenshot-data"),
      pageWidth: 1280,
      pageHeight: 800,
      url: "https://example.com",
    });
  });

  it("registers the tool with correct name", () => {
    expect(mock.server.registerTool).toHaveBeenCalledWith(
      "tiler_capture_url",
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("returns summary and structured JSON on success", async () => {
    const tool = mock.getTool("tiler_capture_url")!;
    const result = await tool.handler(
      { url: "https://example.com", viewportWidth: 1280, waitUntil: "load", delay: 0, format: "webp" },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(2);
    expect(res.content[0].text).toContain("1280×800");
    expect(res.content[0].text).toContain("example.com");

    const json = JSON.parse(res.content[1].text);
    expect(json.url).toBe("https://example.com");
    expect(json.width).toBe(1280);
    expect(json.height).toBe(800);
    expect(json.format).toBe("webp");
  });

  it("includes segments info when scroll-stitched", async () => {
    mockedCaptureUrl.mockResolvedValue({
      buffer: Buffer.from("screenshot-data"),
      pageWidth: 1280,
      pageHeight: 20000,
      url: "https://example.com",
      segmentsStitched: 2,
    });

    const tool = mock.getTool("tiler_capture_url")!;
    const result = await tool.handler(
      { url: "https://example.com", viewportWidth: 1280, waitUntil: "load", delay: 0, format: "webp" },
      {} as any
    );
    const res = result as any;
    expect(res.content[0].text).toContain("Scroll-stitched 2 segments");

    const json = JSON.parse(res.content[1].text);
    expect(json.segmentsStitched).toBe(2);
  });

  it("wraps errors from captureUrl", async () => {
    mockedCaptureUrl.mockRejectedValue(new Error("Chrome not found"));
    const tool = mock.getTool("tiler_capture_url")!;
    const result = await tool.handler(
      { url: "https://example.com", viewportWidth: 1280, waitUntil: "load", delay: 0, format: "webp" },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Error capturing URL");
    expect(res.content[0].text).toContain("Chrome not found");
  });

  it("passes capture options through", async () => {
    const tool = mock.getTool("tiler_capture_url")!;
    await tool.handler(
      { url: "https://test.com", viewportWidth: 1920, waitUntil: "networkidle", delay: 2000, format: "png" },
      {} as any
    );
    expect(mockedCaptureUrl).toHaveBeenCalledWith({
      url: "https://test.com",
      viewportWidth: 1920,
      waitUntil: "networkidle",
      delay: 2000,
    });
  });

  it("falls back to PNG when WebP fails due to image too large", async () => {
    const sharpModule = await import("sharp");
    const mockSharp = vi.mocked(sharpModule.default);

    // First sharp() call: webp pipeline whose toFile rejects
    const firstInstance: Record<string, any> = {
      toFile: vi.fn().mockRejectedValue(
        new Error("Processed image is too large for the WebP format")
      ),
    };
    firstInstance.webp = vi.fn().mockReturnValue(firstInstance);
    firstInstance.png = vi.fn().mockReturnValue(firstInstance);
    mockSharp.mockReturnValueOnce(firstInstance as any);

    // Second sharp() call: png fallback that succeeds
    const pngToFile = vi.fn().mockResolvedValue({});
    const secondInstance: Record<string, any> = {
      toFile: pngToFile,
    };
    secondInstance.png = vi.fn().mockReturnValue({ toFile: pngToFile });
    mockSharp.mockReturnValueOnce(secondInstance as any);

    const tool = mock.getTool("tiler_capture_url")!;
    const result = await tool.handler(
      { url: "https://example.com", viewportWidth: 1280, waitUntil: "load", delay: 0, format: "webp" },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBeUndefined();

    // Summary should mention the fallback
    expect(res.content[0].text).toContain("too large for WebP");
    expect(res.content[0].text).toContain("PNG");

    // Structured output should report png format
    const json = JSON.parse(res.content[1].text);
    expect(json.format).toBe("png");
    expect(json.filePath).toMatch(/screenshot\.png$/);
  });

  it("re-throws non-WebP-size errors during save", async () => {
    const sharpModule = await import("sharp");
    const mockSharp = vi.mocked(sharpModule.default);

    // Sharp instance whose toFile rejects with a non-WebP error
    const instance: Record<string, any> = {
      toFile: vi.fn().mockRejectedValue(new Error("Disk full")),
    };
    instance.webp = vi.fn().mockReturnValue(instance);
    instance.png = vi.fn().mockReturnValue(instance);
    mockSharp.mockReturnValueOnce(instance as any);

    const tool = mock.getTool("tiler_capture_url")!;
    const result = await tool.handler(
      { url: "https://example.com", viewportWidth: 1280, waitUntil: "load", delay: 0, format: "webp" },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Disk full");
  });
});
