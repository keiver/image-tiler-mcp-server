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

describe("integration: landscape image (3584×1866)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the landscape image", async () => {
    outputDir = await makeTempDir("landscape");
    result = await tileImage(LANDSCAPE, 1092, outputDir);

    expect(result.sourceImage.width).toBe(3584);
    expect(result.sourceImage.height).toBe(1866);
    expect(result.sourceImage.format).toBe("png");
  }, 30000);

  it("produces 4×2 grid = 8 tiles", () => {
    // ceil(3584/1092) = 4, ceil(1866/1092) = 2
    expect(result.grid.cols).toBe(4);
    expect(result.grid.rows).toBe(2);
    expect(result.grid.totalTiles).toBe(8);
    expect(result.tiles).toHaveLength(8);
  });

  it("edge tiles have correct dimensions", async () => {
    // Right column: 3584 - (3 * 1092) = 3584 - 3276 = 308px
    // Bottom row: 1866 - (1 * 1092) = 774px
    const rightEdgeTile = result.tiles.find((t) => t.row === 0 && t.col === 3)!;
    expect(rightEdgeTile.width).toBe(308);
    expect(rightEdgeTile.height).toBe(1092);

    const bottomEdgeTile = result.tiles.find((t) => t.row === 1 && t.col === 0)!;
    expect(bottomEdgeTile.width).toBe(1092);
    expect(bottomEdgeTile.height).toBe(774);

    // Verify actual file dimensions via Sharp
    const rightTileMeta = await sharp(rightEdgeTile.filePath).metadata();
    expect(rightTileMeta.width).toBe(308);
    expect(rightTileMeta.height).toBe(1092);

    const bottomTileMeta = await sharp(bottomEdgeTile.filePath).metadata();
    expect(bottomTileMeta.width).toBe(1092);
    expect(bottomTileMeta.height).toBe(774);
  });

  it("tile files exist with correct naming", async () => {
    const files = await fs.readdir(outputDir);
    const tileFiles = files.filter((f) => f.startsWith("tile_") && f.endsWith(".webp"));
    expect(tileFiles).toHaveLength(8);
    expect(tileFiles).toContain("tile_000_000.webp");
    expect(tileFiles).toContain("tile_001_003.webp"); // last tile
  });

  it("lists tiles and reads them as base64", async () => {
    const tilePaths = await listTilesInDirectory(outputDir);
    expect(tilePaths).toHaveLength(8);

    const base64 = await readTileAsBase64(tilePaths[0]);
    expect(base64.length).toBeGreaterThan(0);
    // Verify it's valid base64 that decodes to a WebP
    const buf = Buffer.from(base64, "base64");
    // WebP files: RIFF container (bytes 0-3) + WEBP signature (bytes 8-11)
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WEBP");
  });

  it("estimated tokens match formula", () => {
    expect(result.grid.estimatedTokens).toBe(8 * 1590);
  });
});

describe("integration: portrait image (3600×8412)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the portrait image", async () => {
    outputDir = await makeTempDir("portrait");
    result = await tileImage(PORTRAIT, 1092, outputDir);

    expect(result.sourceImage.width).toBe(3600);
    expect(result.sourceImage.height).toBe(8412);
  }, 60000);

  it("produces 4×8 grid = 32 tiles", () => {
    // ceil(3600/1092) = 4, ceil(8412/1092) = 8
    expect(result.grid.cols).toBe(4);
    expect(result.grid.rows).toBe(8);
    expect(result.grid.totalTiles).toBe(32);
    expect(result.tiles).toHaveLength(32);
  });

  it("edge tiles have correct dimensions", async () => {
    // Right column: 3600 - (3 * 1092) = 3600 - 3276 = 324px
    // Bottom row: 8412 - (7 * 1092) = 8412 - 7644 = 768px
    const rightEdgeTile = result.tiles.find((t) => t.row === 0 && t.col === 3)!;
    expect(rightEdgeTile.width).toBe(324);

    const bottomEdgeTile = result.tiles.find((t) => t.row === 7 && t.col === 0)!;
    expect(bottomEdgeTile.height).toBe(768);

    // Verify actual file dimensions
    const rightMeta = await sharp(rightEdgeTile.filePath).metadata();
    expect(rightMeta.width).toBe(324);

    const bottomMeta = await sharp(bottomEdgeTile.filePath).metadata();
    expect(bottomMeta.height).toBe(768);
  });

  it("tile files exist with correct count", async () => {
    const files = await fs.readdir(outputDir);
    const tileFiles = files.filter((f) => f.startsWith("tile_") && f.endsWith(".webp"));
    expect(tileFiles).toHaveLength(32);
  });

  it("end-to-end: tile → list → base64 → verify WebP", async () => {
    const tilePaths = await listTilesInDirectory(outputDir);
    expect(tilePaths).toHaveLength(32);

    // Read last tile
    const lastTile = tilePaths[tilePaths.length - 1];
    const base64 = await readTileAsBase64(lastTile);
    const buf = Buffer.from(base64, "base64");
    // WebP files: RIFF container (bytes 0-3) + WEBP signature (bytes 8-11)
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WEBP");
  });

  it("estimated tokens match formula", () => {
    expect(result.grid.estimatedTokens).toBe(32 * 1590);
  });
});

describe("integration: landscape with remainder absorption (Claude)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles with absorption enabled (maxTileSize=1568)", async () => {
    outputDir = await makeTempDir("landscape-absorb");
    result = await tileImage(LANDSCAPE, 1092, outputDir, 1590, undefined, 1568);

    expect(result.sourceImage.width).toBe(3584);
    expect(result.sourceImage.height).toBe(1866);
  }, 30000);

  it("produces 4×2 grid = 8 tiles (no absorption — remainders too large)", () => {
    // Right remainder: 3584 - 3*1092 = 308px, 308/1092 = 0.28 > 0.15 threshold → not absorbed
    // Bottom remainder: 1866 - 1*1092 = 774px, 774/1092 = 0.71 > 0.15 threshold → not absorbed
    expect(result.grid.cols).toBe(4);
    expect(result.grid.rows).toBe(2);
    expect(result.grid.totalTiles).toBe(8);
    expect(result.tiles).toHaveLength(8);
  });

  it("last column tiles are 308px wide (remainder not absorbed)", async () => {
    const lastColTile = result.tiles.find((t) => t.row === 0 && t.col === 3)!;
    expect(lastColTile.width).toBe(308);
    expect(lastColTile.height).toBe(1092);

    // Verify actual file dimensions via Sharp
    const meta = await sharp(lastColTile.filePath).metadata();
    expect(meta.width).toBe(308);
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
    expect(result.grid.totalTiles).toBe(8);
    expect(result.grid.estimatedTokens).toBe(8 * 1590);
  });

  it("tile files exist with correct count", async () => {
    const files = await fs.readdir(outputDir);
    const tileFiles = files.filter((f) => f.startsWith("tile_") && f.endsWith(".webp"));
    expect(tileFiles).toHaveLength(8);
    expect(tileFiles).toContain("tile_001_003.webp");
  });
});

describe("integration: landscape with OpenAI settings (768px tiles)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the landscape image at 768px with OpenAI token rate", async () => {
    outputDir = await makeTempDir("landscape-openai");
    result = await tileImage(LANDSCAPE, 768, outputDir, 765);

    expect(result.sourceImage.width).toBe(3584);
    expect(result.sourceImage.height).toBe(1866);
  }, 30000);

  it("produces 5×3 grid = 15 tiles", () => {
    // ceil(3584/768) = 5, ceil(1866/768) = 3
    expect(result.grid.cols).toBe(5);
    expect(result.grid.rows).toBe(3);
    expect(result.grid.totalTiles).toBe(15);
    expect(result.tiles).toHaveLength(15);
  });

  it("estimated tokens use OpenAI rate (765/tile)", () => {
    expect(result.grid.estimatedTokens).toBe(15 * 765);
  });

  it("edge tiles have correct dimensions", () => {
    // Right column: 3584 - (4 * 768) = 3584 - 3072 = 512px
    // Bottom row: 1866 - (2 * 768) = 1866 - 1536 = 330px
    const rightEdgeTile = result.tiles.find((t) => t.row === 0 && t.col === 4)!;
    expect(rightEdgeTile.width).toBe(512);

    const bottomEdgeTile = result.tiles.find((t) => t.row === 2 && t.col === 0)!;
    expect(bottomEdgeTile.height).toBe(330);
  });
});

describe("integration: landscape with Gemini settings (768px tiles)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the landscape image at 768px with Gemini token rate", async () => {
    outputDir = await makeTempDir("landscape-gemini");
    result = await tileImage(LANDSCAPE, 768, outputDir, 258);

    expect(result.sourceImage.width).toBe(3584);
    expect(result.sourceImage.height).toBe(1866);
  }, 30000);

  it("produces 5×3 grid = 15 tiles (same grid as OpenAI)", () => {
    expect(result.grid.cols).toBe(5);
    expect(result.grid.rows).toBe(3);
    expect(result.grid.totalTiles).toBe(15);
  });

  it("estimated tokens use Gemini rate (258/tile)", () => {
    expect(result.grid.estimatedTokens).toBe(15 * 258);
  });
});

describe("integration: landscape with Gemini 3 settings (1536px tiles)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the landscape image at 1536px with Gemini 3 token rate", async () => {
    outputDir = await makeTempDir("landscape-gemini3");
    result = await tileImage(LANDSCAPE, 1536, outputDir, 1120);

    expect(result.sourceImage.width).toBe(3584);
    expect(result.sourceImage.height).toBe(1866);
  }, 30000);

  it("produces 3×2 grid = 6 tiles", () => {
    // ceil(3584/1536) = 3, ceil(1866/1536) = 2
    expect(result.grid.cols).toBe(3);
    expect(result.grid.rows).toBe(2);
    expect(result.grid.totalTiles).toBe(6);
    expect(result.tiles).toHaveLength(6);
  });

  it("estimated tokens use Gemini 3 rate (1120/tile)", () => {
    expect(result.grid.estimatedTokens).toBe(6 * 1120);
  });

  it("edge tiles have correct dimensions", () => {
    // Right column: 3584 - (2 * 1536) = 3584 - 3072 = 512px
    // Bottom row: 1866 - (1 * 1536) = 330px
    const rightEdgeTile = result.tiles.find((t) => t.row === 0 && t.col === 2)!;
    expect(rightEdgeTile.width).toBe(512);

    const bottomEdgeTile = result.tiles.find((t) => t.row === 1 && t.col === 0)!;
    expect(bottomEdgeTile.height).toBe(330);
  });
});

describe("integration: landscape with maxDimension=2000", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("downscales and tiles the landscape image", async () => {
    outputDir = await makeTempDir("landscape-maxdim");
    result = await tileImage(LANDSCAPE, 1092, outputDir, 1590, 2000);

    // Original is 3584×1866, longest side is 3584
    // scaleFactor = 2000/3584 ≈ 0.558
    expect(result.resize).toBeDefined();
    expect(result.resize!.originalWidth).toBe(3584);
    expect(result.resize!.originalHeight).toBe(1866);
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
    // Without maxDimension, 3584×1866 at 1092 → 4×2 = 8 tiles
    // With maxDimension=2000, ~2000×1041 at 1092 → 2×1 = 2 tiles
    expect(result.grid.totalTiles).toBeLessThan(8);
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
    // landscape.png is 3584×1866, use maxDimension=10000 which exceeds longest side
    const result = await tileImage(LANDSCAPE, 1092, outputDir, 1590, 10000);

    expect(result.resize).toBeUndefined();
    expect(result.sourceImage.width).toBe(3584);
    expect(result.sourceImage.height).toBe(1866);
  }, 30000);
});

describe("integration: portrait with maxDimension=1092", () => {
  it("dramatically reduces tiles for long-scroll image", async () => {
    const outputDir = await makeTempDir("portrait-maxdim");
    // portrait.png is 3600×8412
    // Without maxDimension: 4×8 = 32 tiles
    const result = await tileImage(PORTRAIT, 1092, outputDir, 1590, 1092);

    expect(result.resize).toBeDefined();
    expect(result.resize!.originalWidth).toBe(3600);
    expect(result.resize!.originalHeight).toBe(8412);
    // Longest side is 8412, scaleFactor = 1092/8412 ≈ 0.130
    expect(result.resize!.resizedHeight).toBeLessThanOrEqual(1092);
    // With such aggressive resize, should be 1×1 grid
    expect(result.grid.totalTiles).toBeLessThanOrEqual(4);
    expect(result.grid.totalTiles).toBeLessThan(32);

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
    expect(html).toContain("3584");
    expect(html).toContain("1866");
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
