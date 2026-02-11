import { describe, it, expect } from "vitest";
import { z } from "zod";
import { TileImageInputSchema, GetTilesInputSchema } from "../schemas/index.js";

const tileImageSchema = z.object(TileImageInputSchema);
const getTilesSchema = z.object(GetTilesInputSchema);

describe("TileImageInputSchema", () => {
  describe("filePath", () => {
    it("accepts a valid file path", () => {
      const result = tileImageSchema.parse({ filePath: "/path/to/image.png" });
      expect(result.filePath).toBe("/path/to/image.png");
    });

    it("rejects an empty string", () => {
      expect(() => tileImageSchema.parse({ filePath: "" })).toThrow(
        "File path cannot be empty"
      );
    });

    it("rejects missing filePath", () => {
      expect(() => tileImageSchema.parse({})).toThrow();
    });

    it("rejects non-string filePath", () => {
      expect(() => tileImageSchema.parse({ filePath: 123 })).toThrow();
    });
  });

  describe("model", () => {
    it("defaults to claude when omitted", () => {
      const result = tileImageSchema.parse({ filePath: "test.png" });
      expect(result.model).toBe("claude");
    });

    it("accepts claude", () => {
      const result = tileImageSchema.parse({ filePath: "test.png", model: "claude" });
      expect(result.model).toBe("claude");
    });

    it("accepts openai", () => {
      const result = tileImageSchema.parse({ filePath: "test.png", model: "openai" });
      expect(result.model).toBe("openai");
    });

    it("accepts gemini", () => {
      const result = tileImageSchema.parse({ filePath: "test.png", model: "gemini" });
      expect(result.model).toBe("gemini");
    });

    it("accepts gemini3", () => {
      const result = tileImageSchema.parse({ filePath: "test.png", model: "gemini3" });
      expect(result.model).toBe("gemini3");
    });

    it("rejects invalid model name", () => {
      expect(() =>
        tileImageSchema.parse({ filePath: "test.png", model: "gpt4" })
      ).toThrow();
    });

    it("rejects non-string model", () => {
      expect(() =>
        tileImageSchema.parse({ filePath: "test.png", model: 42 })
      ).toThrow();
    });
  });

  describe("tileSize", () => {
    it("is undefined when omitted", () => {
      const result = tileImageSchema.parse({ filePath: "test.png" });
      expect(result.tileSize).toBeUndefined();
    });

    it("accepts minimum value (1)", () => {
      const result = tileImageSchema.parse({ filePath: "test.png", tileSize: 1 });
      expect(result.tileSize).toBe(1);
    });

    it("accepts maximum value (65536)", () => {
      const result = tileImageSchema.parse({ filePath: "test.png", tileSize: 65536 });
      expect(result.tileSize).toBe(65536);
    });

    it("accepts mid-range value (1072)", () => {
      const result = tileImageSchema.parse({ filePath: "test.png", tileSize: 1072 });
      expect(result.tileSize).toBe(1072);
    });

    it("rejects below minimum (0)", () => {
      expect(() =>
        tileImageSchema.parse({ filePath: "test.png", tileSize: 0 })
      ).toThrow("positive integer");
    });

    it("rejects above maximum (65537)", () => {
      expect(() =>
        tileImageSchema.parse({ filePath: "test.png", tileSize: 65537 })
      ).toThrow("must not exceed 65536");
    });

    it("rejects non-integer", () => {
      expect(() =>
        tileImageSchema.parse({ filePath: "test.png", tileSize: 500.5 })
      ).toThrow();
    });
  });

  describe("maxDimension", () => {
    it("defaults to 10000 when omitted", () => {
      const result = tileImageSchema.parse({ filePath: "test.png" });
      expect(result.maxDimension).toBe(10000);
    });

    it("accepts 0 (disables auto-downscaling)", () => {
      const result = tileImageSchema.parse({ filePath: "test.png", maxDimension: 0 });
      expect(result.maxDimension).toBe(0);
    });

    it("accepts minimum positive value (1)", () => {
      const result = tileImageSchema.parse({ filePath: "test.png", maxDimension: 1 });
      expect(result.maxDimension).toBe(1);
    });

    it("accepts value (256)", () => {
      const result = tileImageSchema.parse({ filePath: "test.png", maxDimension: 256 });
      expect(result.maxDimension).toBe(256);
    });

    it("accepts maximum value (65536)", () => {
      const result = tileImageSchema.parse({ filePath: "test.png", maxDimension: 65536 });
      expect(result.maxDimension).toBe(65536);
    });

    it("accepts mid-range value (2048)", () => {
      const result = tileImageSchema.parse({ filePath: "test.png", maxDimension: 2048 });
      expect(result.maxDimension).toBe(2048);
    });

    it("rejects negative values (-1)", () => {
      expect(() =>
        tileImageSchema.parse({ filePath: "test.png", maxDimension: -1 })
      ).toThrow("maxDimension must be >= 0");
    });

    it("rejects above maximum (65537)", () => {
      expect(() =>
        tileImageSchema.parse({ filePath: "test.png", maxDimension: 65537 })
      ).toThrow("must not exceed 65536");
    });

    it("rejects non-integer", () => {
      expect(() =>
        tileImageSchema.parse({ filePath: "test.png", maxDimension: 1024.5 })
      ).toThrow();
    });

    it("rejects non-number", () => {
      expect(() =>
        tileImageSchema.parse({ filePath: "test.png", maxDimension: "2048" })
      ).toThrow();
    });
  });

  describe("outputDir", () => {
    it("is optional and undefined by default", () => {
      const result = tileImageSchema.parse({ filePath: "test.png" });
      expect(result.outputDir).toBeUndefined();
    });

    it("accepts a string value", () => {
      const result = tileImageSchema.parse({
        filePath: "test.png",
        outputDir: "/tmp/tiles",
      });
      expect(result.outputDir).toBe("/tmp/tiles");
    });
  });

});

describe("GetTilesInputSchema", () => {
  describe("tilesDir", () => {
    it("accepts a valid directory path", () => {
      const result = getTilesSchema.parse({ tilesDir: "/path/to/tiles" });
      expect(result.tilesDir).toBe("/path/to/tiles");
    });

    it("rejects an empty string", () => {
      expect(() => getTilesSchema.parse({ tilesDir: "" })).toThrow(
        "Tiles directory path cannot be empty"
      );
    });

    it("rejects missing tilesDir", () => {
      expect(() => getTilesSchema.parse({})).toThrow();
    });
  });

  describe("start", () => {
    it("defaults to 0 when omitted", () => {
      const result = getTilesSchema.parse({ tilesDir: "/tiles" });
      expect(result.start).toBe(0);
    });

    it("accepts 0", () => {
      const result = getTilesSchema.parse({ tilesDir: "/tiles", start: 0 });
      expect(result.start).toBe(0);
    });

    it("rejects negative values", () => {
      expect(() =>
        getTilesSchema.parse({ tilesDir: "/tiles", start: -1 })
      ).toThrow("Start index must be >= 0");
    });
  });

  describe("end", () => {
    it("is optional and undefined by default", () => {
      const result = getTilesSchema.parse({ tilesDir: "/tiles" });
      expect(result.end).toBeUndefined();
    });

    it("accepts 0", () => {
      const result = getTilesSchema.parse({ tilesDir: "/tiles", end: 0 });
      expect(result.end).toBe(0);
    });

    it("rejects negative values", () => {
      expect(() =>
        getTilesSchema.parse({ tilesDir: "/tiles", end: -1 })
      ).toThrow("End index must be >= 0");
    });
  });

});
