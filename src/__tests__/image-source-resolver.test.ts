import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedUnlink = vi.mocked(fs.unlink);

import {
  resolveImageSource,
  guessExtensionFromContentType,
  guessExtensionFromMagicBytes,
  mimeSubtypeToExtension,
} from "../services/image-source-resolver.js";
import { MAX_DOWNLOAD_SIZE_BYTES } from "../constants.js";

describe("resolveImageSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedWriteFile.mockResolvedValue(undefined);
    mockedUnlink.mockResolvedValue(undefined);
  });

  describe("filePath source", () => {
    it("returns file source with no cleanup", async () => {
      const result = await resolveImageSource({ filePath: "/path/to/image.png" });
      expect(result.sourceType).toBe("file");
      expect(result.localPath).toBe("/path/to/image.png");
      expect(result.originalSource).toBe("/path/to/image.png");
      expect(result.cleanup).toBeUndefined();
    });

    it("filePath takes precedence over other sources", async () => {
      const result = await resolveImageSource({
        filePath: "/path/to/image.png",
        sourceUrl: "https://example.com/image.png",
        imageBase64: "AAAA",
      });
      expect(result.sourceType).toBe("file");
      expect(result.localPath).toBe("/path/to/image.png");
    });
  });

  describe("dataUrl source", () => {
    it("parses valid data URL and writes temp file", async () => {
      const base64Data = Buffer.from("fake-png-data").toString("base64");
      const dataUrl = `data:image/png;base64,${base64Data}`;
      const result = await resolveImageSource({ dataUrl });

      expect(result.sourceType).toBe("data_url");
      expect(result.localPath).toMatch(/\.png$/);
      expect(result.cleanup).toBeInstanceOf(Function);
      expect(mockedWriteFile).toHaveBeenCalledTimes(1);
      expect(mockedWriteFile).toHaveBeenCalledWith(
        result.localPath,
        expect.any(Buffer)
      );
    });

    it("rejects invalid data URL format", async () => {
      await expect(
        resolveImageSource({ dataUrl: "not-a-data-url" })
      ).rejects.toThrow("Invalid data URL format");
    });

    it("maps jpeg mime subtype to .jpg extension", async () => {
      const base64Data = Buffer.from("fake-jpeg").toString("base64");
      const dataUrl = `data:image/jpeg;base64,${base64Data}`;
      const result = await resolveImageSource({ dataUrl });
      expect(result.localPath).toMatch(/\.jpg$/);
    });
  });

  describe("base64 source", () => {
    it("decodes base64 and writes temp file", async () => {
      // PNG magic bytes
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const base64 = pngHeader.toString("base64");
      const result = await resolveImageSource({ imageBase64: base64 });

      expect(result.sourceType).toBe("base64");
      expect(result.localPath).toMatch(/\.png$/);
      expect(result.cleanup).toBeInstanceOf(Function);
      expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    });

    it("guesses .jpg extension from magic bytes", async () => {
      const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      const base64 = jpegHeader.toString("base64");
      const result = await resolveImageSource({ imageBase64: base64 });
      expect(result.localPath).toMatch(/\.jpg$/);
    });

    it("rejects empty base64 (treated as no source)", async () => {
      // Empty string is falsy, so resolveImageSource skips it → no source error
      await expect(
        resolveImageSource({ imageBase64: "" })
      ).rejects.toThrow("No image source provided");
    });

    it("rejects base64 with invalid characters", async () => {
      await expect(
        resolveImageSource({ imageBase64: "!@#$%^&*()" })
      ).rejects.toThrow("invalid characters");
    });

    it("rejects whitespace-only base64", async () => {
      await expect(
        resolveImageSource({ imageBase64: "   " })
      ).rejects.toThrow("Base64 string is empty");
    });
  });

  describe("no source", () => {
    it("throws when no source provided", async () => {
      await expect(resolveImageSource({})).rejects.toThrow(
        "No image source provided"
      );
    });
  });

  describe("cleanup", () => {
    it("cleanup is idempotent — safe to call multiple times", async () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const result = await resolveImageSource({ imageBase64: pngHeader.toString("base64") });

      await result.cleanup!();
      await result.cleanup!();

      // Only one actual unlink call despite two cleanup calls
      expect(mockedUnlink).toHaveBeenCalledTimes(1);
    });

    it("cleanup silently ignores ENOENT", async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      mockedUnlink.mockRejectedValueOnce(err);

      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const result = await resolveImageSource({ imageBase64: pngHeader.toString("base64") });

      // Should not throw
      await result.cleanup!();
    });
  });

  describe("precedence", () => {
    it("sourceUrl takes precedence over dataUrl and imageBase64", async () => {
      // We can't easily test URL fetching in unit tests without mocking fetch,
      // but we can verify filePath > sourceUrl
      const result = await resolveImageSource({
        filePath: "/path.png",
        sourceUrl: "https://example.com/image.png",
        dataUrl: "data:image/png;base64,AAAA",
        imageBase64: "AAAA",
      });
      expect(result.sourceType).toBe("file");
    });

    it("dataUrl takes precedence over imageBase64", async () => {
      const base64Data = Buffer.from("fake-png-data").toString("base64");
      const result = await resolveImageSource({
        dataUrl: `data:image/png;base64,${base64Data}`,
        imageBase64: "other-data",
      });
      expect(result.sourceType).toBe("data_url");
    });
  });

  describe("decoded buffer size validation", () => {
    it("rejects base64 that decodes to oversized buffer", async () => {
      // Create a buffer just over the limit
      const oversized = Buffer.alloc(MAX_DOWNLOAD_SIZE_BYTES + 1, 0x41); // 'A'
      const base64 = oversized.toString("base64");
      await expect(
        resolveImageSource({ imageBase64: base64 })
      ).rejects.toThrow("exceeding the");
    });

    it("rejects data URL that decodes to oversized buffer", async () => {
      const oversized = Buffer.alloc(MAX_DOWNLOAD_SIZE_BYTES + 1, 0x41);
      const base64 = oversized.toString("base64");
      const dataUrl = `data:image/png;base64,${base64}`;
      await expect(
        resolveImageSource({ dataUrl })
      ).rejects.toThrow("exceeding the");
    });
  });
});

describe("sourceUrl resolution", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedWriteFile.mockResolvedValue(undefined);
    mockedUnlink.mockResolvedValue(undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(overrides: Partial<{
    ok: boolean;
    status: number;
    headers: Record<string, string>;
    arrayBuffer: () => Promise<ArrayBuffer>;
    abortError: boolean;
    networkError: string;
  }> = {}): void {
    globalThis.fetch = vi.fn(async (_url: string, options?: RequestInit) => {
      if (overrides.abortError) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      if (overrides.networkError) {
        throw new Error(overrides.networkError);
      }

      const headers = new Headers(overrides.headers ?? { "content-type": "image/png" });
      const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      return {
        ok: overrides.ok ?? true,
        status: overrides.status ?? 200,
        headers,
        arrayBuffer: overrides.arrayBuffer ?? (() => Promise.resolve(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))),
      } as unknown as Response;
    });
  }

  it("downloads image from valid HTTPS URL", async () => {
    mockFetch();
    const result = await resolveImageSource({ sourceUrl: "https://example.com/photo.png" });
    expect(result.sourceType).toBe("url");
    expect(result.localPath).toMatch(/\.png$/);
    expect(result.cleanup).toBeInstanceOf(Function);
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
  });

  it("rejects non-HTTPS protocol", async () => {
    await expect(
      resolveImageSource({ sourceUrl: "http://example.com/photo.png" })
    ).rejects.toThrow("Unsupported URL protocol");
  });

  it("rejects ftp protocol", async () => {
    await expect(
      resolveImageSource({ sourceUrl: "ftp://example.com/photo.png" })
    ).rejects.toThrow("Unsupported URL protocol");
  });

  it("throws on HTTP error status", async () => {
    mockFetch({ ok: false, status: 404 });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/missing.png" })
    ).rejects.toThrow("HTTP 404");
  });

  it("throws on timeout (AbortError)", async () => {
    mockFetch({ abortError: true });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/slow.png" })
    ).rejects.toThrow("timed out");
  });

  it("throws on network error", async () => {
    mockFetch({ networkError: "ECONNREFUSED" });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/down.png" })
    ).rejects.toThrow("Failed to fetch image");
  });

  it("rejects when content-length exceeds limit", async () => {
    mockFetch({
      headers: {
        "content-type": "image/png",
        "content-length": String(MAX_DOWNLOAD_SIZE_BYTES + 1),
      },
    });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/huge.png" })
    ).rejects.toThrow("exceeding the");
  });

  it("rejects when downloaded buffer exceeds limit", async () => {
    const oversized = Buffer.alloc(MAX_DOWNLOAD_SIZE_BYTES + 1, 0x00);
    mockFetch({
      arrayBuffer: () => Promise.resolve(oversized.buffer.slice(oversized.byteOffset, oversized.byteOffset + oversized.byteLength)),
    });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/sneaky-big.png" })
    ).rejects.toThrow("exceeding the");
  });

  it("rejects non-image Content-Type", async () => {
    mockFetch({ headers: { "content-type": "text/html" } });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/page.html" })
    ).rejects.toThrow("non-image Content-Type");
  });

  it("rejects application/json Content-Type", async () => {
    mockFetch({ headers: { "content-type": "application/json" } });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/api" })
    ).rejects.toThrow("non-image Content-Type");
  });

  it("accepts application/octet-stream Content-Type", async () => {
    mockFetch({ headers: { "content-type": "application/octet-stream" } });
    const result = await resolveImageSource({ sourceUrl: "https://example.com/binary" });
    expect(result.sourceType).toBe("url");
  });

  it("accepts missing Content-Type (no rejection)", async () => {
    mockFetch({ headers: {} });
    const result = await resolveImageSource({ sourceUrl: "https://example.com/noheader" });
    expect(result.sourceType).toBe("url");
    // Falls back to .png extension
    expect(result.localPath).toMatch(/\.png$/);
  });

  it("guesses .jpg extension from Content-Type", async () => {
    mockFetch({ headers: { "content-type": "image/jpeg" } });
    const result = await resolveImageSource({ sourceUrl: "https://example.com/photo.jpg" });
    expect(result.localPath).toMatch(/\.jpg$/);
  });
});

describe("guessExtensionFromContentType", () => {
  it("returns undefined for null", () => {
    expect(guessExtensionFromContentType(null)).toBeUndefined();
  });

  it("returns .png for image/png", () => {
    expect(guessExtensionFromContentType("image/png")).toBe(".png");
  });

  it("returns .jpg for image/jpeg", () => {
    expect(guessExtensionFromContentType("image/jpeg")).toBe(".jpg");
  });

  it("returns .jpg for image/jpg", () => {
    expect(guessExtensionFromContentType("image/jpg")).toBe(".jpg");
  });

  it("returns .webp for image/webp", () => {
    expect(guessExtensionFromContentType("image/webp")).toBe(".webp");
  });

  it("returns .tiff for image/tiff", () => {
    expect(guessExtensionFromContentType("image/tiff")).toBe(".tiff");
  });

  it("returns .gif for image/gif", () => {
    expect(guessExtensionFromContentType("image/gif")).toBe(".gif");
  });

  it("handles Content-Type with charset parameter", () => {
    expect(guessExtensionFromContentType("image/png; charset=utf-8")).toBe(".png");
  });

  it("is case-insensitive", () => {
    expect(guessExtensionFromContentType("IMAGE/PNG")).toBe(".png");
  });

  it("returns undefined for unknown type", () => {
    expect(guessExtensionFromContentType("image/bmp")).toBeUndefined();
  });

  it("returns undefined for non-image type", () => {
    expect(guessExtensionFromContentType("text/html")).toBeUndefined();
  });
});

describe("guessExtensionFromMagicBytes", () => {
  it("detects PNG", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(guessExtensionFromMagicBytes(buf)).toBe(".png");
  });

  it("detects JPEG", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(guessExtensionFromMagicBytes(buf)).toBe(".jpg");
  });

  it("detects WebP (RIFF header)", () => {
    const buf = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    expect(guessExtensionFromMagicBytes(buf)).toBe(".webp");
  });

  it("detects GIF", () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38]);
    expect(guessExtensionFromMagicBytes(buf)).toBe(".gif");
  });

  it("detects TIFF (little-endian II)", () => {
    const buf = Buffer.from([0x49, 0x49, 0x2a, 0x00]);
    expect(guessExtensionFromMagicBytes(buf)).toBe(".tiff");
  });

  it("detects TIFF (big-endian MM)", () => {
    const buf = Buffer.from([0x4d, 0x4d, 0x00, 0x2a]);
    expect(guessExtensionFromMagicBytes(buf)).toBe(".tiff");
  });

  it("returns undefined for buffer < 4 bytes", () => {
    expect(guessExtensionFromMagicBytes(Buffer.from([0x89, 0x50]))).toBeUndefined();
  });

  it("returns undefined for empty buffer", () => {
    expect(guessExtensionFromMagicBytes(Buffer.alloc(0))).toBeUndefined();
  });

  it("returns undefined for unknown magic bytes", () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    expect(guessExtensionFromMagicBytes(buf)).toBeUndefined();
  });
});

describe("mimeSubtypeToExtension", () => {
  it("maps jpeg to .jpg", () => {
    expect(mimeSubtypeToExtension("jpeg")).toBe(".jpg");
  });

  it("maps jpg to .jpg", () => {
    expect(mimeSubtypeToExtension("jpg")).toBe(".jpg");
  });

  it("maps png to .png", () => {
    expect(mimeSubtypeToExtension("png")).toBe(".png");
  });

  it("maps webp to .webp", () => {
    expect(mimeSubtypeToExtension("webp")).toBe(".webp");
  });

  it("maps tiff to .tiff", () => {
    expect(mimeSubtypeToExtension("tiff")).toBe(".tiff");
  });

  it("maps gif to .gif", () => {
    expect(mimeSubtypeToExtension("gif")).toBe(".gif");
  });

  it("is case-insensitive", () => {
    expect(mimeSubtypeToExtension("JPEG")).toBe(".jpg");
    expect(mimeSubtypeToExtension("PNG")).toBe(".png");
  });

  it("falls back to .{subtype} for unknown types", () => {
    expect(mimeSubtypeToExtension("bmp")).toBe(".bmp");
    expect(mimeSubtypeToExtension("svg+xml")).toBe(".svg+xml");
  });
});
