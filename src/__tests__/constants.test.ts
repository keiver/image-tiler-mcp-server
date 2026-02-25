import { describe, it, expect } from "vitest";
import {
  DEFAULT_TILE_SIZE,
  MAX_TILE_SIZE,
  MIN_TILE_SIZE,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MAX_TOTAL_TILES,
  MAX_TILES_PER_BATCH,
  SUPPORTED_FORMATS,
  PNG_COMPRESSION_LEVEL,
  TOKENS_PER_TILE,
  VISION_MODELS,
  MODEL_CONFIGS,
  DEFAULT_MODEL,
  DEFAULT_MAX_DIMENSION,
  MAX_DOWNLOAD_SIZE_BYTES,
  DOWNLOAD_TIMEOUT_MS,
  ALLOWED_URL_PROTOCOLS,
  MAX_BASE64_LENGTH,
  MIN_REMAINDER_RATIO,
  MIN_PREVIEW_WIDTH,
  SHARP_OPERATION_TIMEOUT_MS,
  MAX_CHROME_STDERR_BYTES,
  MAX_CHROME_JSON_BYTES,
  BLANK_STDDEV_THRESHOLD,
  LOW_DETAIL_ENTROPY_THRESHOLD,
  HIGH_DETAIL_ENTROPY_THRESHOLD,
} from "../constants.js";


describe("constants", () => {
  describe("tile sizes", () => {
    it("DEFAULT_TILE_SIZE is 1092", () => {
      expect(DEFAULT_TILE_SIZE).toBe(1092);
    });

    it("MAX_TILE_SIZE is 1568", () => {
      expect(MAX_TILE_SIZE).toBe(1568);
    });

    it("MIN_TILE_SIZE is 256", () => {
      expect(MIN_TILE_SIZE).toBe(256);
    });

    it("DEFAULT is between MIN and MAX", () => {
      expect(DEFAULT_TILE_SIZE).toBeGreaterThan(MIN_TILE_SIZE);
      expect(DEFAULT_TILE_SIZE).toBeLessThan(MAX_TILE_SIZE);
    });
  });

  describe("batch and token limits", () => {
    it("MAX_TILES_PER_BATCH is 5", () => {
      expect(MAX_TILES_PER_BATCH).toBe(5);
    });

    it("TOKENS_PER_TILE is 1590", () => {
      expect(TOKENS_PER_TILE).toBe(1590);
    });
  });

  describe("image constraints", () => {
    it("MAX_IMAGE_DIMENSION is 65536", () => {
      expect(MAX_IMAGE_DIMENSION).toBe(65536);
    });

    it("MAX_TOTAL_TILES is 10000", () => {
      expect(MAX_TOTAL_TILES).toBe(10000);
    });

    it("PNG_COMPRESSION_LEVEL is 6", () => {
      expect(PNG_COMPRESSION_LEVEL).toBe(6);
    });

    it("DEFAULT_MAX_DIMENSION is 10000", () => {
      expect(DEFAULT_MAX_DIMENSION).toBe(10000);
    });

    it("MIN_REMAINDER_RATIO is 0.15", () => {
      expect(MIN_REMAINDER_RATIO).toBe(0.15);
    });

    it("MIN_PREVIEW_WIDTH is 800", () => {
      expect(MIN_PREVIEW_WIDTH).toBe(800);
    });

    it("SHARP_OPERATION_TIMEOUT_MS is 30 seconds", () => {
      expect(SHARP_OPERATION_TIMEOUT_MS).toBe(30_000);
    });

    it("MAX_IMAGE_PIXELS is 256 megapixels", () => {
      expect(MAX_IMAGE_PIXELS).toBe(256_000_000);
    });
  });

  describe("security limits", () => {
    it("MAX_CHROME_STDERR_BYTES is 1MB", () => {
      expect(MAX_CHROME_STDERR_BYTES).toBe(1_048_576);
    });

    it("MAX_CHROME_JSON_BYTES is 1MB", () => {
      expect(MAX_CHROME_JSON_BYTES).toBe(1_048_576);
    });
  });

  describe("supported formats", () => {
    it("includes all expected formats", () => {
      expect(SUPPORTED_FORMATS).toContain("png");
      expect(SUPPORTED_FORMATS).toContain("jpeg");
      expect(SUPPORTED_FORMATS).toContain("jpg");
      expect(SUPPORTED_FORMATS).toContain("webp");
      expect(SUPPORTED_FORMATS).toContain("tiff");
      expect(SUPPORTED_FORMATS).toContain("gif");
    });

    it("has exactly 6 formats", () => {
      expect(SUPPORTED_FORMATS).toHaveLength(6);
    });
  });

  describe("VISION_MODELS", () => {
    it("contains claude, openai, gemini, gemini3", () => {
      expect(VISION_MODELS).toEqual(["claude", "openai", "gemini3", "gemini"]);
    });

    it("has exactly 4 models", () => {
      expect(VISION_MODELS).toHaveLength(4);
    });
  });

  describe("DEFAULT_MODEL", () => {
    it("is claude", () => {
      expect(DEFAULT_MODEL).toBe("claude");
    });
  });

  describe("MODEL_CONFIGS", () => {
    it("has an entry for every VISION_MODEL", () => {
      for (const model of VISION_MODELS) {
        expect(MODEL_CONFIGS[model]).toBeDefined();
      }
    });

    describe("claude config", () => {
      it("has correct values", () => {
        expect(MODEL_CONFIGS.claude).toEqual({
          defaultTileSize: 1092,
          minTileSize: 256,
          maxTileSize: 1568,
          tokensPerTile: 1590,
          label: "Claude",
        });
      });
    });

    describe("openai config", () => {
      it("has correct values", () => {
        expect(MODEL_CONFIGS.openai).toEqual({
          defaultTileSize: 768,
          minTileSize: 256,
          maxTileSize: 2048,
          tokensPerTile: 765,
          label: "OpenAI",
        });
      });
    });

    describe("gemini config", () => {
      it("has correct values", () => {
        expect(MODEL_CONFIGS.gemini).toEqual({
          defaultTileSize: 768,
          minTileSize: 256,
          maxTileSize: 768,
          tokensPerTile: 258,
          label: "Gemini",
        });
      });
    });

    describe("gemini3 config", () => {
      it("has correct values", () => {
        expect(MODEL_CONFIGS.gemini3).toEqual({
          defaultTileSize: 1536,
          minTileSize: 384,
          maxTileSize: 3072,
          tokensPerTile: 1120,
          label: "Gemini 3",
        });
      });
    });

    it("all configs have expected minTileSize", () => {
      expect(MODEL_CONFIGS.claude.minTileSize).toBe(256);
      expect(MODEL_CONFIGS.openai.minTileSize).toBe(256);
      expect(MODEL_CONFIGS.gemini.minTileSize).toBe(256);
      expect(MODEL_CONFIGS.gemini3.minTileSize).toBe(384);
    });
  });

  describe("backward-compatible aliases", () => {
    it("DEFAULT_TILE_SIZE matches claude config", () => {
      expect(DEFAULT_TILE_SIZE).toBe(MODEL_CONFIGS.claude.defaultTileSize);
    });

    it("MAX_TILE_SIZE matches claude config", () => {
      expect(MAX_TILE_SIZE).toBe(MODEL_CONFIGS.claude.maxTileSize);
    });

    it("MIN_TILE_SIZE matches claude config", () => {
      expect(MIN_TILE_SIZE).toBe(MODEL_CONFIGS.claude.minTileSize);
    });

    it("TOKENS_PER_TILE matches claude config", () => {
      expect(TOKENS_PER_TILE).toBe(MODEL_CONFIGS.claude.tokensPerTile);
    });
  });

  describe("tile classification thresholds", () => {
    it("BLANK_STDDEV_THRESHOLD is 5", () => {
      expect(BLANK_STDDEV_THRESHOLD).toBe(5);
    });

    it("LOW_DETAIL_ENTROPY_THRESHOLD is 4.0", () => {
      expect(LOW_DETAIL_ENTROPY_THRESHOLD).toBe(4.0);
    });

    it("HIGH_DETAIL_ENTROPY_THRESHOLD is 6.5", () => {
      expect(HIGH_DETAIL_ENTROPY_THRESHOLD).toBe(6.5);
    });
  });

  describe("image source resolution constants", () => {
    it("MAX_DOWNLOAD_SIZE_BYTES is 50MB", () => {
      expect(MAX_DOWNLOAD_SIZE_BYTES).toBe(50 * 1024 * 1024);
    });

    it("DOWNLOAD_TIMEOUT_MS is 30 seconds", () => {
      expect(DOWNLOAD_TIMEOUT_MS).toBe(30_000);
    });

    it("ALLOWED_URL_PROTOCOLS includes https: and http:", () => {
      expect(ALLOWED_URL_PROTOCOLS).toEqual(["https:", "http:"]);
    });

    it("MAX_BASE64_LENGTH is ~50MB decoded", () => {
      expect(MAX_BASE64_LENGTH).toBe(67_108_864);
    });
  });

});
