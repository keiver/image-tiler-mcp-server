import { describe, it, expect } from "vitest";
import {
  DEFAULT_TILE_SIZE,
  MAX_TILE_SIZE,
  MIN_TILE_SIZE,
  MAX_IMAGE_DIMENSION,
  MAX_TOTAL_TILES,
  MAX_TILES_PER_BATCH,
  SUPPORTED_FORMATS,
  PNG_COMPRESSION_LEVEL,
  TOKENS_PER_TILE,
  VISION_MODELS,
  MODEL_CONFIGS,
  DEFAULT_MODEL,
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
      expect(VISION_MODELS).toEqual(["claude", "openai", "gemini", "gemini3"]);
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
});
