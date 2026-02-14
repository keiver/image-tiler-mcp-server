import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  TileImageInputSchema,
  GetTilesInputSchema,
  RecommendSettingsInputSchema,
  PrepareImageInputSchema,
} from "../schemas/index.js";
import { MAX_DATA_URL_LENGTH } from "../constants.js";

const tileImageSchema = z.object(TileImageInputSchema);
const getTilesSchema = z.object(GetTilesInputSchema);
const recommendSettingsSchema = z.object(RecommendSettingsInputSchema);
const prepareImageSchema = z.object(PrepareImageInputSchema);

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

    it("is optional (no filePath does not throw)", () => {
      const result = tileImageSchema.parse({});
      expect(result.filePath).toBeUndefined();
    });

    it("rejects non-string filePath", () => {
      expect(() => tileImageSchema.parse({ filePath: 123 })).toThrow();
    });
  });

  describe("image source fields", () => {
    it("accepts sourceUrl", () => {
      const result = tileImageSchema.parse({ sourceUrl: "https://example.com/image.png" });
      expect(result.sourceUrl).toBe("https://example.com/image.png");
    });

    it("rejects invalid URL for sourceUrl", () => {
      expect(() => tileImageSchema.parse({ sourceUrl: "not-a-url" })).toThrow("url");
    });

    it("accepts dataUrl", () => {
      const result = tileImageSchema.parse({ dataUrl: "data:image/png;base64,AAAA" });
      expect(result.dataUrl).toBe("data:image/png;base64,AAAA");
    });

    it("accepts imageBase64", () => {
      const result = tileImageSchema.parse({ imageBase64: "AAAA" });
      expect(result.imageBase64).toBe("AAAA");
    });

    it("rejects dataUrl exceeding max length", () => {
      const oversized = "data:image/png;base64," + "A".repeat(MAX_DATA_URL_LENGTH);
      expect(() => tileImageSchema.parse({ dataUrl: oversized })).toThrow(
        "Data URL must not exceed"
      );
    });

    it("accepts dataUrl within max length", () => {
      const valid = "data:image/png;base64,AAAA";
      const result = tileImageSchema.parse({ dataUrl: valid });
      expect(result.dataUrl).toBe(valid);
    });

    it("all source fields are optional", () => {
      const result = tileImageSchema.parse({});
      expect(result.filePath).toBeUndefined();
      expect(result.sourceUrl).toBeUndefined();
      expect(result.dataUrl).toBeUndefined();
      expect(result.imageBase64).toBeUndefined();
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

describe("RecommendSettingsInputSchema", () => {
  it("accepts filePath only", () => {
    const result = recommendSettingsSchema.parse({ filePath: "test.png" });
    expect(result.filePath).toBe("test.png");
    expect(result.model).toBeUndefined();
  });

  it("accepts sourceUrl", () => {
    const result = recommendSettingsSchema.parse({ sourceUrl: "https://example.com/img.png" });
    expect(result.sourceUrl).toBe("https://example.com/img.png");
  });

  it("model is optional (no default)", () => {
    const result = recommendSettingsSchema.parse({ filePath: "test.png" });
    expect(result.model).toBeUndefined();
  });

  it("accepts all vision models", () => {
    for (const m of ["claude", "openai", "gemini", "gemini3"]) {
      const result = recommendSettingsSchema.parse({ filePath: "test.png", model: m });
      expect(result.model).toBe(m);
    }
  });

  it("intent accepts all valid values", () => {
    for (const intent of ["text_heavy", "ui_screenshot", "diagram", "photo", "general"]) {
      const result = recommendSettingsSchema.parse({ filePath: "test.png", intent });
      expect(result.intent).toBe(intent);
    }
  });

  it("rejects invalid intent", () => {
    expect(() =>
      recommendSettingsSchema.parse({ filePath: "test.png", intent: "unknown" })
    ).toThrow();
  });

  it("budget accepts all valid values", () => {
    for (const budget of ["low", "default", "max_detail"]) {
      const result = recommendSettingsSchema.parse({ filePath: "test.png", budget });
      expect(result.budget).toBe(budget);
    }
  });

  it("rejects invalid budget", () => {
    expect(() =>
      recommendSettingsSchema.parse({ filePath: "test.png", budget: "balanced" })
    ).toThrow();
  });

  it("tileSize and maxDimension are optional with no defaults", () => {
    const result = recommendSettingsSchema.parse({ filePath: "test.png" });
    expect(result.tileSize).toBeUndefined();
    expect(result.maxDimension).toBeUndefined();
  });
});

describe("PrepareImageInputSchema", () => {
  it("accepts filePath and defaults", () => {
    const result = prepareImageSchema.parse({ filePath: "test.png" });
    expect(result.filePath).toBe("test.png");
    expect(result.model).toBe("claude");
    expect(result.maxDimension).toBe(10000);
    expect(result.page).toBe(0);
  });

  it("accepts sourceUrl", () => {
    const result = prepareImageSchema.parse({ sourceUrl: "https://example.com/img.png" });
    expect(result.sourceUrl).toBe("https://example.com/img.png");
  });

  it("page defaults to 0", () => {
    const result = prepareImageSchema.parse({ filePath: "test.png" });
    expect(result.page).toBe(0);
  });

  it("accepts custom page", () => {
    const result = prepareImageSchema.parse({ filePath: "test.png", page: 3 });
    expect(result.page).toBe(3);
  });

  it("rejects negative page", () => {
    expect(() =>
      prepareImageSchema.parse({ filePath: "test.png", page: -1 })
    ).toThrow("Page must be >= 0");
  });

  it("model defaults to claude", () => {
    const result = prepareImageSchema.parse({ filePath: "test.png" });
    expect(result.model).toBe("claude");
  });

  it("all source fields are optional", () => {
    const result = prepareImageSchema.parse({});
    expect(result.filePath).toBeUndefined();
    expect(result.sourceUrl).toBeUndefined();
  });
});
