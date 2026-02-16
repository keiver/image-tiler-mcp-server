import { describe, it, expect } from "vitest";
import { z } from "zod";
import { TilerInputSchema } from "../schemas/index.js";
import { MAX_DATA_URL_LENGTH } from "../constants.js";

const tilerSchema = z.object(TilerInputSchema);

describe("TilerInputSchema", () => {
  describe("filePath", () => {
    it("accepts a valid file path", () => {
      const result = tilerSchema.parse({ filePath: "/path/to/image.png" });
      expect(result.filePath).toBe("/path/to/image.png");
    });

    it("rejects an empty string", () => {
      expect(() => tilerSchema.parse({ filePath: "" })).toThrow(
        "File path cannot be empty"
      );
    });

    it("is optional (no filePath does not throw)", () => {
      const result = tilerSchema.parse({});
      expect(result.filePath).toBeUndefined();
    });

    it("rejects non-string filePath", () => {
      expect(() => tilerSchema.parse({ filePath: 123 })).toThrow();
    });
  });

  describe("image source fields", () => {
    it("accepts sourceUrl", () => {
      const result = tilerSchema.parse({ sourceUrl: "https://example.com/image.png" });
      expect(result.sourceUrl).toBe("https://example.com/image.png");
    });

    it("rejects invalid URL for sourceUrl", () => {
      expect(() => tilerSchema.parse({ sourceUrl: "not-a-url" })).toThrow("url");
    });

    it("accepts dataUrl", () => {
      const result = tilerSchema.parse({ dataUrl: "data:image/png;base64,AAAA" });
      expect(result.dataUrl).toBe("data:image/png;base64,AAAA");
    });

    it("accepts imageBase64", () => {
      const result = tilerSchema.parse({ imageBase64: "AAAA" });
      expect(result.imageBase64).toBe("AAAA");
    });

    it("rejects dataUrl exceeding max length", () => {
      const oversized = "data:image/png;base64," + "A".repeat(MAX_DATA_URL_LENGTH);
      expect(() => tilerSchema.parse({ dataUrl: oversized })).toThrow(
        "Data URL must not exceed"
      );
    });

    it("accepts dataUrl within max length", () => {
      const valid = "data:image/png;base64,AAAA";
      const result = tilerSchema.parse({ dataUrl: valid });
      expect(result.dataUrl).toBe(valid);
    });

    it("all source fields are optional", () => {
      const result = tilerSchema.parse({});
      expect(result.filePath).toBeUndefined();
      expect(result.sourceUrl).toBeUndefined();
      expect(result.dataUrl).toBeUndefined();
      expect(result.imageBase64).toBeUndefined();
    });
  });

  describe("url (capture mode)", () => {
    it("is optional and undefined by default", () => {
      const result = tilerSchema.parse({});
      expect(result.url).toBeUndefined();
    });

    it("accepts a valid URL", () => {
      const result = tilerSchema.parse({ url: "https://example.com" });
      expect(result.url).toBe("https://example.com");
    });

    it("rejects invalid URL", () => {
      expect(() => tilerSchema.parse({ url: "not-a-url" })).toThrow("url");
    });
  });

  describe("capture fields", () => {
    it("viewportWidth accepts valid range", () => {
      const result = tilerSchema.parse({ url: "https://example.com", viewportWidth: 1280 });
      expect(result.viewportWidth).toBe(1280);
    });

    it("viewportWidth rejects below minimum", () => {
      expect(() => tilerSchema.parse({ url: "https://example.com", viewportWidth: 100 })).toThrow("320");
    });

    it("viewportWidth rejects above maximum", () => {
      expect(() => tilerSchema.parse({ url: "https://example.com", viewportWidth: 5000 })).toThrow("3840");
    });

    it("waitUntil defaults to load", () => {
      const result = tilerSchema.parse({});
      expect(result.waitUntil).toBe("load");
    });

    it("delay defaults to 0", () => {
      const result = tilerSchema.parse({});
      expect(result.delay).toBe(0);
    });

    it("screenshotPath is optional and undefined by default", () => {
      const result = tilerSchema.parse({});
      expect(result.screenshotPath).toBeUndefined();
    });

    it("screenshotPath accepts a string", () => {
      const result = tilerSchema.parse({ screenshotPath: "/path/to/screenshot.png" });
      expect(result.screenshotPath).toBe("/path/to/screenshot.png");
    });
  });

  describe("tilesDir (get-tiles mode)", () => {
    it("is optional and undefined by default", () => {
      const result = tilerSchema.parse({});
      expect(result.tilesDir).toBeUndefined();
    });

    it("accepts a valid directory path", () => {
      const result = tilerSchema.parse({ tilesDir: "/path/to/tiles" });
      expect(result.tilesDir).toBe("/path/to/tiles");
    });

    it("rejects an empty string", () => {
      expect(() => tilerSchema.parse({ tilesDir: "" })).toThrow(
        "Tiles directory path cannot be empty"
      );
    });
  });

  describe("start/end (pagination)", () => {
    it("start defaults to 0 when omitted", () => {
      const result = tilerSchema.parse({});
      expect(result.start).toBe(0);
    });

    it("start accepts 0", () => {
      const result = tilerSchema.parse({ tilesDir: "/tiles", start: 0 });
      expect(result.start).toBe(0);
    });

    it("start rejects negative values", () => {
      expect(() =>
        tilerSchema.parse({ tilesDir: "/tiles", start: -1 })
      ).toThrow("Start index must be >= 0");
    });

    it("end is optional and undefined by default", () => {
      const result = tilerSchema.parse({});
      expect(result.end).toBeUndefined();
    });

    it("end accepts 0", () => {
      const result = tilerSchema.parse({ tilesDir: "/tiles", end: 0 });
      expect(result.end).toBe(0);
    });

    it("end rejects negative values", () => {
      expect(() =>
        tilerSchema.parse({ tilesDir: "/tiles", end: -1 })
      ).toThrow("End index must be >= 0");
    });
  });

  describe("model", () => {
    it("is undefined when omitted", () => {
      const result = tilerSchema.parse({ filePath: "test.png" });
      expect(result.model).toBeUndefined();
    });

    it("accepts claude", () => {
      const result = tilerSchema.parse({ filePath: "test.png", model: "claude" });
      expect(result.model).toBe("claude");
    });

    it("accepts openai", () => {
      const result = tilerSchema.parse({ filePath: "test.png", model: "openai" });
      expect(result.model).toBe("openai");
    });

    it("accepts gemini", () => {
      const result = tilerSchema.parse({ filePath: "test.png", model: "gemini" });
      expect(result.model).toBe("gemini");
    });

    it("accepts gemini3", () => {
      const result = tilerSchema.parse({ filePath: "test.png", model: "gemini3" });
      expect(result.model).toBe("gemini3");
    });

    it("rejects invalid model name", () => {
      expect(() =>
        tilerSchema.parse({ filePath: "test.png", model: "gpt4" })
      ).toThrow();
    });

    it("rejects non-string model", () => {
      expect(() =>
        tilerSchema.parse({ filePath: "test.png", model: 42 })
      ).toThrow();
    });
  });

  describe("tileSize", () => {
    it("is undefined when omitted", () => {
      const result = tilerSchema.parse({ filePath: "test.png" });
      expect(result.tileSize).toBeUndefined();
    });

    it("accepts minimum value (1)", () => {
      const result = tilerSchema.parse({ filePath: "test.png", tileSize: 1 });
      expect(result.tileSize).toBe(1);
    });

    it("accepts maximum value (65536)", () => {
      const result = tilerSchema.parse({ filePath: "test.png", tileSize: 65536 });
      expect(result.tileSize).toBe(65536);
    });

    it("accepts mid-range value (1072)", () => {
      const result = tilerSchema.parse({ filePath: "test.png", tileSize: 1072 });
      expect(result.tileSize).toBe(1072);
    });

    it("rejects below minimum (0)", () => {
      expect(() =>
        tilerSchema.parse({ filePath: "test.png", tileSize: 0 })
      ).toThrow("positive integer");
    });

    it("rejects above maximum (65537)", () => {
      expect(() =>
        tilerSchema.parse({ filePath: "test.png", tileSize: 65537 })
      ).toThrow("must not exceed 65536");
    });

    it("rejects non-integer", () => {
      expect(() =>
        tilerSchema.parse({ filePath: "test.png", tileSize: 500.5 })
      ).toThrow();
    });
  });

  describe("maxDimension", () => {
    it("defaults to 10000 when omitted", () => {
      const result = tilerSchema.parse({ filePath: "test.png" });
      expect(result.maxDimension).toBe(10000);
    });

    it("accepts 0 (disables auto-downscaling)", () => {
      const result = tilerSchema.parse({ filePath: "test.png", maxDimension: 0 });
      expect(result.maxDimension).toBe(0);
    });

    it("accepts minimum positive value (1)", () => {
      const result = tilerSchema.parse({ filePath: "test.png", maxDimension: 1 });
      expect(result.maxDimension).toBe(1);
    });

    it("accepts value (256)", () => {
      const result = tilerSchema.parse({ filePath: "test.png", maxDimension: 256 });
      expect(result.maxDimension).toBe(256);
    });

    it("accepts maximum value (65536)", () => {
      const result = tilerSchema.parse({ filePath: "test.png", maxDimension: 65536 });
      expect(result.maxDimension).toBe(65536);
    });

    it("accepts mid-range value (2048)", () => {
      const result = tilerSchema.parse({ filePath: "test.png", maxDimension: 2048 });
      expect(result.maxDimension).toBe(2048);
    });

    it("rejects negative values (-1)", () => {
      expect(() =>
        tilerSchema.parse({ filePath: "test.png", maxDimension: -1 })
      ).toThrow("maxDimension must be >= 0");
    });

    it("rejects above maximum (65537)", () => {
      expect(() =>
        tilerSchema.parse({ filePath: "test.png", maxDimension: 65537 })
      ).toThrow("must not exceed 65536");
    });

    it("rejects non-integer", () => {
      expect(() =>
        tilerSchema.parse({ filePath: "test.png", maxDimension: 1024.5 })
      ).toThrow();
    });

    it("rejects non-number", () => {
      expect(() =>
        tilerSchema.parse({ filePath: "test.png", maxDimension: "2048" })
      ).toThrow();
    });
  });

  describe("outputDir", () => {
    it("is optional and undefined by default", () => {
      const result = tilerSchema.parse({ filePath: "test.png" });
      expect(result.outputDir).toBeUndefined();
    });

    it("accepts a string value", () => {
      const result = tilerSchema.parse({
        filePath: "test.png",
        outputDir: "/tmp/tiles",
      });
      expect(result.outputDir).toBe("/tmp/tiles");
    });
  });

  describe("page", () => {
    it("defaults to 0 when omitted", () => {
      const result = tilerSchema.parse({ filePath: "test.png" });
      expect(result.page).toBe(0);
    });

    it("accepts custom page", () => {
      const result = tilerSchema.parse({ filePath: "test.png", page: 3 });
      expect(result.page).toBe(3);
    });

    it("rejects negative page", () => {
      expect(() =>
        tilerSchema.parse({ filePath: "test.png", page: -1 })
      ).toThrow("Page must be >= 0");
    });
  });

  describe("format", () => {
    it("defaults to webp when omitted", () => {
      const result = tilerSchema.parse({ filePath: "test.png" });
      expect(result.format).toBe("webp");
    });

    it("accepts png", () => {
      const result = tilerSchema.parse({ filePath: "test.png", format: "png" });
      expect(result.format).toBe("png");
    });

    it("accepts webp", () => {
      const result = tilerSchema.parse({ filePath: "test.png", format: "webp" });
      expect(result.format).toBe("webp");
    });

    it("rejects invalid format", () => {
      expect(() => tilerSchema.parse({ filePath: "test.png", format: "jpg" })).toThrow();
    });
  });

  describe("includeMetadata", () => {
    it("defaults to true when omitted", () => {
      const result = tilerSchema.parse({ filePath: "test.png" });
      expect(result.includeMetadata).toBe(true);
    });

    it("accepts true", () => {
      const result = tilerSchema.parse({ filePath: "test.png", includeMetadata: true });
      expect(result.includeMetadata).toBe(true);
    });
  });
});
