import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import sharp from "sharp";
import {
  tileImage,
  listTilesInDirectory,
  readTileAsBase64,
  computeEstimateForModel,
} from "../services/image-processor.js";
import { generateInteractivePreview } from "../services/interactive-preview-generator.js";
import { VISION_MODELS } from "../constants.js";
import type { ModelEstimate } from "../types.js";

const ASSETS_DIR = path.resolve(import.meta.dirname, "../../assets");
const LANDSCAPE = path.join(ASSETS_DIR, "landscape.png");
const PORTRAIT = path.join(ASSETS_DIR, "portrait.png");

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `tiler-test-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("integration: landscape image (8192×4320)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the landscape image", async () => {
    outputDir = await makeTempDir("landscape");
    result = await tileImage(LANDSCAPE, 1092, outputDir);

    expect(result.sourceImage.width).toBe(8192);
    expect(result.sourceImage.height).toBe(4320);
    expect(result.sourceImage.format).toBe("png");
  }, 30000);

  it("produces 8×4 grid = 32 tiles", () => {
    // ceil(8192/1092) = 8, ceil(4320/1092) = 4
    expect(result.grid.cols).toBe(8);
    expect(result.grid.rows).toBe(4);
    expect(result.grid.totalTiles).toBe(32);
    expect(result.tiles).toHaveLength(32);
  });

  it("edge tiles have correct dimensions", async () => {
    // Right column: 8192 - (7 * 1092) = 8192 - 7644 = 548px
    // Bottom row: 4320 - (3 * 1092) = 4320 - 3276 = 1044px
    const rightEdgeTile = result.tiles.find((t) => t.row === 0 && t.col === 7)!;
    expect(rightEdgeTile.width).toBe(548);
    expect(rightEdgeTile.height).toBe(1092);

    const bottomEdgeTile = result.tiles.find((t) => t.row === 3 && t.col === 0)!;
    expect(bottomEdgeTile.width).toBe(1092);
    expect(bottomEdgeTile.height).toBe(1044);

    // Verify actual file dimensions via Sharp
    const rightTileMeta = await sharp(rightEdgeTile.filePath).metadata();
    expect(rightTileMeta.width).toBe(548);
    expect(rightTileMeta.height).toBe(1092);

    const bottomTileMeta = await sharp(bottomEdgeTile.filePath).metadata();
    expect(bottomTileMeta.width).toBe(1092);
    expect(bottomTileMeta.height).toBe(1044);
  });

  it("tile files exist with correct naming", async () => {
    const files = await fs.readdir(outputDir);
    const tileFiles = files.filter((f) => f.startsWith("tile_") && f.endsWith(".webp"));
    expect(tileFiles).toHaveLength(32);
    expect(tileFiles).toContain("tile_000_000.webp");
    expect(tileFiles).toContain("tile_003_007.webp"); // last tile
  });

  it("lists tiles and reads them as base64", async () => {
    const tilePaths = await listTilesInDirectory(outputDir);
    expect(tilePaths).toHaveLength(32);

    const base64 = await readTileAsBase64(tilePaths[0]);
    expect(base64.length).toBeGreaterThan(0);
    // Verify it's valid base64 that decodes to a WebP
    const buf = Buffer.from(base64, "base64");
    // WebP files: RIFF container (bytes 0-3) + WEBP signature (bytes 8-11)
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WEBP");
  });

  it("estimated tokens match formula", () => {
    expect(result.grid.estimatedTokens).toBe(32 * 1590);
  });
});

describe("integration: portrait image (3600×20220)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the portrait image", async () => {
    outputDir = await makeTempDir("portrait");
    result = await tileImage(PORTRAIT, 1092, outputDir);

    expect(result.sourceImage.width).toBe(3600);
    expect(result.sourceImage.height).toBe(20220);
  }, 60000);

  it("produces 4×19 grid = 76 tiles", () => {
    // ceil(3600/1092) = 4, ceil(20220/1092) = 19
    expect(result.grid.cols).toBe(4);
    expect(result.grid.rows).toBe(19);
    expect(result.grid.totalTiles).toBe(76);
    expect(result.tiles).toHaveLength(76);
  });

  it("edge tiles have correct dimensions", async () => {
    // Right column: 3600 - (3 * 1092) = 3600 - 3276 = 324px
    // Bottom row: 20220 - (18 * 1092) = 20220 - 19656 = 564px
    const rightEdgeTile = result.tiles.find((t) => t.row === 0 && t.col === 3)!;
    expect(rightEdgeTile.width).toBe(324);

    const bottomEdgeTile = result.tiles.find((t) => t.row === 18 && t.col === 0)!;
    expect(bottomEdgeTile.height).toBe(564);

    // Verify actual file dimensions
    const rightMeta = await sharp(rightEdgeTile.filePath).metadata();
    expect(rightMeta.width).toBe(324);

    const bottomMeta = await sharp(bottomEdgeTile.filePath).metadata();
    expect(bottomMeta.height).toBe(564);
  });

  it("tile files exist with correct count", async () => {
    const files = await fs.readdir(outputDir);
    const tileFiles = files.filter((f) => f.startsWith("tile_") && f.endsWith(".webp"));
    expect(tileFiles).toHaveLength(76);
  });

  it("end-to-end: tile → list → base64 → verify WebP", async () => {
    const tilePaths = await listTilesInDirectory(outputDir);
    expect(tilePaths).toHaveLength(76);

    // Read last tile
    const lastTile = tilePaths[tilePaths.length - 1];
    const base64 = await readTileAsBase64(lastTile);
    const buf = Buffer.from(base64, "base64");
    // WebP files: RIFF container (bytes 0-3) + WEBP signature (bytes 8-11)
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WEBP");
  });

  it("estimated tokens match formula", () => {
    expect(result.grid.estimatedTokens).toBe(76 * 1590);
  });
});

describe("integration: landscape with remainder absorption (Claude)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles with absorption enabled (maxTileSize=1568)", async () => {
    outputDir = await makeTempDir("landscape-absorb");
    result = await tileImage(LANDSCAPE, 1092, outputDir, 1590, undefined, 1568);

    expect(result.sourceImage.width).toBe(8192);
    expect(result.sourceImage.height).toBe(4320);
  }, 30000);

  it("produces 8×4 grid = 32 tiles (no absorption — remainders too large)", () => {
    // Right remainder: 8192 - 7*1092 = 548px, 548/1092 = 0.50 > 0.15 threshold → not absorbed
    // Bottom remainder: 4320 - 3*1092 = 1044px, 1044/1092 = 0.96 > 0.15 threshold → not absorbed
    expect(result.grid.cols).toBe(8);
    expect(result.grid.rows).toBe(4);
    expect(result.grid.totalTiles).toBe(32);
    expect(result.tiles).toHaveLength(32);
  });

  it("last column tiles are 548px wide (remainder not absorbed)", async () => {
    const lastColTile = result.tiles.find((t) => t.row === 0 && t.col === 7)!;
    expect(lastColTile.width).toBe(548);
    expect(lastColTile.height).toBe(1092);

    // Verify actual file dimensions via Sharp
    const meta = await sharp(lastColTile.filePath).metadata();
    expect(meta.width).toBe(548);
    expect(meta.height).toBe(1092);
  });

  it("interior tiles remain at nominal tileSize", async () => {
    const interiorTile = result.tiles.find((t) => t.row === 0 && t.col === 0)!;
    expect(interiorTile.width).toBe(1092);
    expect(interiorTile.height).toBe(1092);

    const meta = await sharp(interiorTile.filePath).metadata();
    expect(meta.width).toBe(1092);
  });

  it("token count matches grid", () => {
    expect(result.grid.totalTiles).toBe(32);
    expect(result.grid.estimatedTokens).toBe(32 * 1590);
  });

  it("tile files exist with correct count", async () => {
    const files = await fs.readdir(outputDir);
    const tileFiles = files.filter((f) => f.startsWith("tile_") && f.endsWith(".webp"));
    expect(tileFiles).toHaveLength(32);
    expect(tileFiles).toContain("tile_003_007.webp");
  });
});

describe("integration: landscape with OpenAI settings (768px tiles)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the landscape image at 768px with OpenAI token rate", async () => {
    outputDir = await makeTempDir("landscape-openai");
    result = await tileImage(LANDSCAPE, 768, outputDir, 765);

    expect(result.sourceImage.width).toBe(8192);
    expect(result.sourceImage.height).toBe(4320);
  }, 30000);

  it("produces 11×6 grid = 66 tiles", () => {
    // ceil(8192/768) = 11, ceil(4320/768) = 6
    expect(result.grid.cols).toBe(11);
    expect(result.grid.rows).toBe(6);
    expect(result.grid.totalTiles).toBe(66);
    expect(result.tiles).toHaveLength(66);
  });

  it("estimated tokens use OpenAI rate (765/tile)", () => {
    expect(result.grid.estimatedTokens).toBe(66 * 765);
  });

  it("edge tiles have correct dimensions", () => {
    // Right column: 8192 - (10 * 768) = 8192 - 7680 = 512px
    // Bottom row: 4320 - (5 * 768) = 4320 - 3840 = 480px
    const rightEdgeTile = result.tiles.find((t) => t.row === 0 && t.col === 10)!;
    expect(rightEdgeTile.width).toBe(512);

    const bottomEdgeTile = result.tiles.find((t) => t.row === 5 && t.col === 0)!;
    expect(bottomEdgeTile.height).toBe(480);
  });
});

describe("integration: landscape with Gemini settings (768px tiles)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the landscape image at 768px with Gemini token rate", async () => {
    outputDir = await makeTempDir("landscape-gemini");
    result = await tileImage(LANDSCAPE, 768, outputDir, 258);

    expect(result.sourceImage.width).toBe(8192);
    expect(result.sourceImage.height).toBe(4320);
  }, 30000);

  it("produces 11×6 grid = 66 tiles (same grid as OpenAI)", () => {
    expect(result.grid.cols).toBe(11);
    expect(result.grid.rows).toBe(6);
    expect(result.grid.totalTiles).toBe(66);
  });

  it("estimated tokens use Gemini rate (258/tile)", () => {
    expect(result.grid.estimatedTokens).toBe(66 * 258);
  });
});

describe("integration: landscape with Gemini 3 settings (1536px tiles)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the landscape image at 1536px with Gemini 3 token rate", async () => {
    outputDir = await makeTempDir("landscape-gemini3");
    result = await tileImage(LANDSCAPE, 1536, outputDir, 1120);

    expect(result.sourceImage.width).toBe(8192);
    expect(result.sourceImage.height).toBe(4320);
  }, 30000);

  it("produces 6×3 grid = 18 tiles", () => {
    // ceil(8192/1536) = 6, ceil(4320/1536) = 3
    expect(result.grid.cols).toBe(6);
    expect(result.grid.rows).toBe(3);
    expect(result.grid.totalTiles).toBe(18);
    expect(result.tiles).toHaveLength(18);
  });

  it("estimated tokens use Gemini 3 rate (1120/tile)", () => {
    expect(result.grid.estimatedTokens).toBe(18 * 1120);
  });

  it("edge tiles have correct dimensions", () => {
    // Right column: 8192 - (5 * 1536) = 8192 - 7680 = 512px
    // Bottom row: 4320 - (2 * 1536) = 4320 - 3072 = 1248px
    const rightEdgeTile = result.tiles.find((t) => t.row === 0 && t.col === 5)!;
    expect(rightEdgeTile.width).toBe(512);

    const bottomEdgeTile = result.tiles.find((t) => t.row === 2 && t.col === 0)!;
    expect(bottomEdgeTile.height).toBe(1248);
  });
});

describe("integration: landscape with maxDimension=2000", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("downscales and tiles the landscape image", async () => {
    outputDir = await makeTempDir("landscape-maxdim");
    result = await tileImage(LANDSCAPE, 1092, outputDir, 1590, 2000);

    // Original is 8192×4320, longest side is 8192
    // scaleFactor = 2000/8192 ≈ 0.244
    expect(result.resize).toBeDefined();
    expect(result.resize!.originalWidth).toBe(8192);
    expect(result.resize!.originalHeight).toBe(4320);
    expect(result.resize!.resizedWidth).toBeLessThanOrEqual(2000);
    expect(result.resize!.resizedHeight).toBeLessThanOrEqual(2000);
    expect(result.resize!.scaleFactor).toBeGreaterThan(0);
    expect(result.resize!.scaleFactor).toBeLessThan(1);
  }, 30000);

  it("tiles at the resized dimensions, not original", () => {
    // Sharp resize can round by ±1px vs the computed target
    expect(Math.abs(result.sourceImage.width - result.resize!.resizedWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.sourceImage.height - result.resize!.resizedHeight)).toBeLessThanOrEqual(1);
  });

  it("produces fewer tiles than without maxDimension", () => {
    // Without maxDimension, 8192×4320 at 1092 → 8×4 = 32 tiles
    // With maxDimension=2000, ~2000×1055 at 1092 → 2×1 = 2 tiles
    expect(result.grid.totalTiles).toBeLessThan(32);
  });

  it("tile files exist on disk", async () => {
    const files = await fs.readdir(outputDir);
    const tileFiles = files.filter((f) => f.startsWith("tile_") && f.endsWith(".webp"));
    expect(tileFiles).toHaveLength(result.grid.totalTiles);
  });

  it("temp resized file is cleaned up", async () => {
    const files = await fs.readdir(outputDir);
    const resizedFiles = files.filter((f) => f.startsWith("__resized"));
    expect(resizedFiles).toHaveLength(0);
  });

  it("tiles are valid PNGs with correct dimensions via Sharp", async () => {
    const firstTile = result.tiles[0];
    const meta = await sharp(firstTile.filePath).metadata();
    expect(meta.width).toBe(firstTile.width);
    expect(meta.height).toBe(firstTile.height);
    expect(meta.format).toBe("webp");
  });
});

describe("integration: small image with maxDimension (no-op)", () => {
  it("does not resize when image is already within maxDimension", async () => {
    const outputDir = await makeTempDir("small-maxdim");
    // landscape.png is 8192×4320, use maxDimension=10000 which exceeds longest side
    const result = await tileImage(LANDSCAPE, 1092, outputDir, 1590, 10000);

    expect(result.resize).toBeUndefined();
    expect(result.sourceImage.width).toBe(8192);
    expect(result.sourceImage.height).toBe(4320);
  }, 30000);
});

describe("integration: portrait with maxDimension=1092", () => {
  it("dramatically reduces tiles for long-scroll image", async () => {
    const outputDir = await makeTempDir("portrait-maxdim");
    // portrait.png is 3600×20220
    // Without maxDimension: 4×19 = 76 tiles
    const result = await tileImage(PORTRAIT, 1092, outputDir, 1590, 1092);

    expect(result.resize).toBeDefined();
    expect(result.resize!.originalWidth).toBe(3600);
    expect(result.resize!.originalHeight).toBe(20220);
    // Longest side is 20220, scaleFactor = 1092/20220 ≈ 0.054
    expect(result.resize!.resizedHeight).toBeLessThanOrEqual(1092);
    // With such aggressive resize, should be 1×1 grid
    expect(result.grid.totalTiles).toBeLessThanOrEqual(4);
    expect(result.grid.totalTiles).toBeLessThan(76);

    // Verify temp file cleanup
    const files = await fs.readdir(outputDir);
    const resizedFiles = files.filter((f) => f.startsWith("__resized"));
    expect(resizedFiles).toHaveLength(0);
  }, 60000);
});

describe("integration: error handling", () => {
  it("throws a descriptive error for a corrupt image file", async () => {
    const outputDir = await makeTempDir("corrupt");
    const corruptPath = path.join(outputDir, "corrupt.png");
    // Write invalid data that is not a valid image
    await fs.writeFile(corruptPath, Buffer.from("this is not an image file at all"));

    await expect(tileImage(corruptPath, 1092, outputDir)).rejects.toThrow();
  });

  it("throws for a nonexistent file path", async () => {
    const outputDir = await makeTempDir("missing");
    const missingPath = path.join(outputDir, "does-not-exist.png");

    await expect(tileImage(missingPath, 1092, outputDir)).rejects.toThrow();
  });
});

describe("integration: interactive preview generation", () => {
  it("generates {basename}-preview.html in the output directory", async () => {
    const outputDir = await makeTempDir("preview");
    const result = await tileImage(LANDSCAPE, 3072, outputDir);
    const allModels: ModelEstimate[] = VISION_MODELS.map((m) =>
      computeEstimateForModel(m, result.sourceImage.width, result.sourceImage.height)
    );
    const previewPath = await generateInteractivePreview(
      {
        sourceImagePath: LANDSCAPE,
        effectiveWidth: result.sourceImage.width,
        effectiveHeight: result.sourceImage.height,
        originalWidth: result.sourceImage.width,
        originalHeight: result.sourceImage.height,
        maxDimension: 10000,
        recommendedModel: "claude",
        models: allModels,
      },
      outputDir
    );

    expect(previewPath).toBe(path.join(outputDir, "landscape-preview.html"));
    const stat = await fs.stat(previewPath);
    expect(stat.isFile()).toBe(true);
  }, 30000);

  it("preview HTML contains DOCTYPE and source dimensions", async () => {
    const outputDir = await makeTempDir("preview-content");
    const result = await tileImage(LANDSCAPE, 3072, outputDir);
    const allModels: ModelEstimate[] = VISION_MODELS.map((m) =>
      computeEstimateForModel(m, result.sourceImage.width, result.sourceImage.height)
    );
    const previewPath = await generateInteractivePreview(
      {
        sourceImagePath: LANDSCAPE,
        effectiveWidth: result.sourceImage.width,
        effectiveHeight: result.sourceImage.height,
        originalWidth: result.sourceImage.width,
        originalHeight: result.sourceImage.height,
        maxDimension: 10000,
        recommendedModel: "claude",
        models: allModels,
      },
      outputDir
    );

    const html = await fs.readFile(previewPath, "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("8192");
    expect(html).toContain("4320");
  }, 30000);

  it("listTilesInDirectory does NOT include preview HTML", async () => {
    const outputDir = await makeTempDir("preview-list");
    const result = await tileImage(LANDSCAPE, 3072, outputDir);
    const allModels: ModelEstimate[] = VISION_MODELS.map((m) =>
      computeEstimateForModel(m, result.sourceImage.width, result.sourceImage.height)
    );
    await generateInteractivePreview(
      {
        sourceImagePath: LANDSCAPE,
        effectiveWidth: result.sourceImage.width,
        effectiveHeight: result.sourceImage.height,
        originalWidth: result.sourceImage.width,
        originalHeight: result.sourceImage.height,
        maxDimension: 10000,
        recommendedModel: "claude",
        models: allModels,
      },
      outputDir
    );

    const tilePaths = await listTilesInDirectory(outputDir);
    const filenames = tilePaths.map((p) => path.basename(p));
    expect(filenames).not.toContain("landscape-preview.html");
    // All returned files should be tile PNGs
    for (const f of filenames) {
      expect(f).toMatch(/^tile_\d+_\d+\.(png|webp)$/);
    }
  }, 30000);
});
