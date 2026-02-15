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

describe("integration: landscape image (7680×4032)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the landscape image", async () => {
    outputDir = await makeTempDir("landscape");
    result = await tileImage(LANDSCAPE, 1092, outputDir);

    expect(result.sourceImage.width).toBe(7680);
    expect(result.sourceImage.height).toBe(4032);
    expect(result.sourceImage.format).toBe("png");
  }, 30000);

  it("produces 8×4 grid = 32 tiles", () => {
    // ceil(7680/1092) = 8, ceil(4032/1092) = 4
    expect(result.grid.cols).toBe(8);
    expect(result.grid.rows).toBe(4);
    expect(result.grid.totalTiles).toBe(32);
    expect(result.tiles).toHaveLength(32);
  });

  it("edge tiles have correct dimensions", async () => {
    // Right column: 7680 - (7 * 1092) = 7680 - 7644 = 36px
    // Bottom row: 4032 - (3 * 1092) = 4032 - 3276 = 756px
    const rightEdgeTile = result.tiles.find((t) => t.row === 0 && t.col === 7)!;
    expect(rightEdgeTile.width).toBe(36);
    expect(rightEdgeTile.height).toBe(1092);

    const bottomEdgeTile = result.tiles.find((t) => t.row === 3 && t.col === 0)!;
    expect(bottomEdgeTile.width).toBe(1092);
    expect(bottomEdgeTile.height).toBe(756);

    // Verify actual file dimensions via Sharp
    const rightTileMeta = await sharp(rightEdgeTile.filePath).metadata();
    expect(rightTileMeta.width).toBe(36);
    expect(rightTileMeta.height).toBe(1092);

    const bottomTileMeta = await sharp(bottomEdgeTile.filePath).metadata();
    expect(bottomTileMeta.width).toBe(1092);
    expect(bottomTileMeta.height).toBe(756);
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

describe("integration: portrait image (3600×22810)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the portrait image", async () => {
    outputDir = await makeTempDir("portrait");
    result = await tileImage(PORTRAIT, 1092, outputDir);

    expect(result.sourceImage.width).toBe(3600);
    expect(result.sourceImage.height).toBe(22810);
  }, 60000);

  it("produces 4×21 grid = 84 tiles", () => {
    // ceil(3600/1092) = 4, ceil(22810/1092) = 21
    expect(result.grid.cols).toBe(4);
    expect(result.grid.rows).toBe(21);
    expect(result.grid.totalTiles).toBe(84);
    expect(result.tiles).toHaveLength(84);
  });

  it("edge tiles have correct dimensions", async () => {
    // Right column: 3600 - (3 * 1092) = 3600 - 3276 = 324px
    // Bottom row: 22810 - (20 * 1092) = 22810 - 21840 = 970px
    const rightEdgeTile = result.tiles.find((t) => t.row === 0 && t.col === 3)!;
    expect(rightEdgeTile.width).toBe(324);

    const bottomEdgeTile = result.tiles.find((t) => t.row === 20 && t.col === 0)!;
    expect(bottomEdgeTile.height).toBe(970);

    // Verify actual file dimensions
    const rightMeta = await sharp(rightEdgeTile.filePath).metadata();
    expect(rightMeta.width).toBe(324);

    const bottomMeta = await sharp(bottomEdgeTile.filePath).metadata();
    expect(bottomMeta.height).toBe(970);
  });

  it("tile files exist with correct count", async () => {
    const files = await fs.readdir(outputDir);
    const tileFiles = files.filter((f) => f.startsWith("tile_") && f.endsWith(".webp"));
    expect(tileFiles).toHaveLength(84);
  });

  it("end-to-end: tile → list → base64 → verify WebP", async () => {
    const tilePaths = await listTilesInDirectory(outputDir);
    expect(tilePaths).toHaveLength(84);

    // Read last tile
    const lastTile = tilePaths[tilePaths.length - 1];
    const base64 = await readTileAsBase64(lastTile);
    const buf = Buffer.from(base64, "base64");
    // WebP files: RIFF container (bytes 0-3) + WEBP signature (bytes 8-11)
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WEBP");
  });

  it("estimated tokens match formula", () => {
    expect(result.grid.estimatedTokens).toBe(84 * 1590);
  });
});

describe("integration: landscape with remainder absorption (Claude)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles with absorption enabled (maxTileSize=1568)", async () => {
    outputDir = await makeTempDir("landscape-absorb");
    result = await tileImage(LANDSCAPE, 1092, outputDir, 1590, undefined, 1568);

    expect(result.sourceImage.width).toBe(7680);
    expect(result.sourceImage.height).toBe(4032);
  }, 30000);

  it("produces 7×4 grid = 28 tiles (absorbed thin column)", () => {
    // Without absorption: ceil(7680/1092)=8, with absorption: 7 (36px remainder absorbed)
    // Bottom row: 4032 - 3*1092 = 756px, 756/1092 = 0.69 > 0.15, not absorbed → 4 rows
    expect(result.grid.cols).toBe(7);
    expect(result.grid.rows).toBe(4);
    expect(result.grid.totalTiles).toBe(28);
    expect(result.tiles).toHaveLength(28);
  });

  it("last column tiles are 1128px wide (absorbed remainder)", async () => {
    // 7680 - 6*1092 = 1128px
    const lastColTile = result.tiles.find((t) => t.row === 0 && t.col === 6)!;
    expect(lastColTile.width).toBe(1128);
    expect(lastColTile.height).toBe(1092);

    // Verify actual file dimensions via Sharp
    const meta = await sharp(lastColTile.filePath).metadata();
    expect(meta.width).toBe(1128);
    expect(meta.height).toBe(1092);
  });

  it("interior tiles remain at nominal tileSize", async () => {
    const interiorTile = result.tiles.find((t) => t.row === 0 && t.col === 0)!;
    expect(interiorTile.width).toBe(1092);
    expect(interiorTile.height).toBe(1092);

    const meta = await sharp(interiorTile.filePath).metadata();
    expect(meta.width).toBe(1092);
  });

  it("saves 4 tiles / ~6,360 tokens vs non-absorbed", () => {
    expect(result.grid.totalTiles).toBe(28);
    expect(result.grid.estimatedTokens).toBe(28 * 1590);
  });

  it("tile files exist with correct count", async () => {
    const files = await fs.readdir(outputDir);
    const tileFiles = files.filter((f) => f.startsWith("tile_") && f.endsWith(".webp"));
    expect(tileFiles).toHaveLength(28);
    // Last tile should be tile_003_006 (not tile_003_007)
    expect(tileFiles).toContain("tile_003_006.webp");
    expect(tileFiles).not.toContain("tile_003_007.webp");
  });
});

describe("integration: landscape with OpenAI settings (768px tiles)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the landscape image at 768px with OpenAI token rate", async () => {
    outputDir = await makeTempDir("landscape-openai");
    result = await tileImage(LANDSCAPE, 768, outputDir, 765);

    expect(result.sourceImage.width).toBe(7680);
    expect(result.sourceImage.height).toBe(4032);
  }, 30000);

  it("produces 10×6 grid = 60 tiles", () => {
    // ceil(7680/768) = 10, ceil(4032/768) = 6
    expect(result.grid.cols).toBe(10);
    expect(result.grid.rows).toBe(6);
    expect(result.grid.totalTiles).toBe(60);
    expect(result.tiles).toHaveLength(60);
  });

  it("estimated tokens use OpenAI rate (765/tile)", () => {
    expect(result.grid.estimatedTokens).toBe(60 * 765);
  });

  it("edge tiles have correct dimensions", () => {
    // Right column: 7680 - (9 * 768) = 7680 - 6912 = 768px (exact fit!)
    // Bottom row: 4032 - (5 * 768) = 4032 - 3840 = 192px
    const rightEdgeTile = result.tiles.find((t) => t.row === 0 && t.col === 9)!;
    expect(rightEdgeTile.width).toBe(768);

    const bottomEdgeTile = result.tiles.find((t) => t.row === 5 && t.col === 0)!;
    expect(bottomEdgeTile.height).toBe(192);
  });
});

describe("integration: landscape with Gemini settings (768px tiles)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the landscape image at 768px with Gemini token rate", async () => {
    outputDir = await makeTempDir("landscape-gemini");
    result = await tileImage(LANDSCAPE, 768, outputDir, 258);

    expect(result.sourceImage.width).toBe(7680);
    expect(result.sourceImage.height).toBe(4032);
  }, 30000);

  it("produces 10×6 grid = 60 tiles (same grid as OpenAI)", () => {
    expect(result.grid.cols).toBe(10);
    expect(result.grid.rows).toBe(6);
    expect(result.grid.totalTiles).toBe(60);
  });

  it("estimated tokens use Gemini rate (258/tile)", () => {
    expect(result.grid.estimatedTokens).toBe(60 * 258);
  });
});

describe("integration: landscape with Gemini 3 settings (1536px tiles)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the landscape image at 1536px with Gemini 3 token rate", async () => {
    outputDir = await makeTempDir("landscape-gemini3");
    result = await tileImage(LANDSCAPE, 1536, outputDir, 1120);

    expect(result.sourceImage.width).toBe(7680);
    expect(result.sourceImage.height).toBe(4032);
  }, 30000);

  it("produces 5×3 grid = 15 tiles", () => {
    // ceil(7680/1536) = 5, ceil(4032/1536) = 3
    expect(result.grid.cols).toBe(5);
    expect(result.grid.rows).toBe(3);
    expect(result.grid.totalTiles).toBe(15);
    expect(result.tiles).toHaveLength(15);
  });

  it("estimated tokens use Gemini 3 rate (1120/tile)", () => {
    expect(result.grid.estimatedTokens).toBe(15 * 1120);
  });

  it("edge tiles have correct dimensions", () => {
    // Right column: 7680 - (4 * 1536) = 7680 - 6144 = 1536px (exact fit!)
    // Bottom row: 4032 - (2 * 1536) = 4032 - 3072 = 960px
    const rightEdgeTile = result.tiles.find((t) => t.row === 0 && t.col === 4)!;
    expect(rightEdgeTile.width).toBe(1536);

    const bottomEdgeTile = result.tiles.find((t) => t.row === 2 && t.col === 0)!;
    expect(bottomEdgeTile.height).toBe(960);
  });
});

describe("integration: landscape with maxDimension=2000", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("downscales and tiles the landscape image", async () => {
    outputDir = await makeTempDir("landscape-maxdim");
    result = await tileImage(LANDSCAPE, 1092, outputDir, 1590, 2000);

    // Original is 7680×4032, longest side is 7680
    // scaleFactor = 2000/7680 ≈ 0.260
    expect(result.resize).toBeDefined();
    expect(result.resize!.originalWidth).toBe(7680);
    expect(result.resize!.originalHeight).toBe(4032);
    expect(result.resize!.resizedWidth).toBeLessThanOrEqual(2000);
    expect(result.resize!.resizedHeight).toBeLessThanOrEqual(2000);
    expect(result.resize!.scaleFactor).toBeGreaterThan(0);
    expect(result.resize!.scaleFactor).toBeLessThan(1);
  }, 30000);

  it("tiles at the resized dimensions, not original", () => {
    expect(result.sourceImage.width).toBe(result.resize!.resizedWidth);
    expect(result.sourceImage.height).toBe(result.resize!.resizedHeight);
  });

  it("produces fewer tiles than without maxDimension", () => {
    // Without maxDimension, 7680×4032 at 1092 → 8×4 = 32 tiles
    // With maxDimension=2000, ~2000×1052 at 1092 → 2×1 = 2 tiles
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
    // landscape.png is 7680×4032, use maxDimension=10000 which exceeds longest side
    const result = await tileImage(LANDSCAPE, 1092, outputDir, 1590, 10000);

    expect(result.resize).toBeUndefined();
    expect(result.sourceImage.width).toBe(7680);
    expect(result.sourceImage.height).toBe(4032);
  }, 30000);
});

describe("integration: portrait with maxDimension=1092", () => {
  it("dramatically reduces tiles for long-scroll image", async () => {
    const outputDir = await makeTempDir("portrait-maxdim");
    // portrait.png is 3600×22810
    // Without maxDimension: 4×21 = 84 tiles
    const result = await tileImage(PORTRAIT, 1092, outputDir, 1590, 1092);

    expect(result.resize).toBeDefined();
    expect(result.resize!.originalWidth).toBe(3600);
    expect(result.resize!.originalHeight).toBe(22810);
    // Longest side is 22810, scaleFactor = 1092/22810 ≈ 0.048
    expect(result.resize!.resizedHeight).toBeLessThanOrEqual(1092);
    // With such aggressive resize, should be 1×1 grid
    expect(result.grid.totalTiles).toBeLessThanOrEqual(4);
    expect(result.grid.totalTiles).toBeLessThan(84);

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
    expect(html).toContain("7680");
    expect(html).toContain("4032");
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
