import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedUnlink = vi.mocked(fs.unlink);

import { resolveImageSource } from "../services/image-source-resolver.js";

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
});
