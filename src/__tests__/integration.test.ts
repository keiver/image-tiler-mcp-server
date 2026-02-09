import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import sharp from "sharp";
import {
  tileImage,
  listTilesInDirectory,
  readTileAsBase64,
} from "../services/image-processor.js";

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
    const tileFiles = files.filter((f) => f.startsWith("tile_") && f.endsWith(".png"));
    expect(tileFiles).toHaveLength(32);
    expect(tileFiles).toContain("tile_000_000.png");
    expect(tileFiles).toContain("tile_003_007.png"); // last tile
  });

  it("lists tiles and reads them as base64", async () => {
    const tilePaths = await listTilesInDirectory(outputDir);
    expect(tilePaths).toHaveLength(32);

    const base64 = await readTileAsBase64(tilePaths[0]);
    expect(base64.length).toBeGreaterThan(0);
    // Verify it's valid base64 that decodes to a PNG
    const buf = Buffer.from(base64, "base64");
    // PNG magic bytes: 137 80 78 71
    expect(buf[0]).toBe(137);
    expect(buf[1]).toBe(80);
    expect(buf[2]).toBe(78);
    expect(buf[3]).toBe(71);
  });

  it("estimated tokens match formula", () => {
    expect(result.grid.estimatedTokens).toBe(32 * 1590);
  });
});

describe("integration: portrait image (3600×21994)", () => {
  let outputDir: string;
  let result: Awaited<ReturnType<typeof tileImage>>;

  it("tiles the portrait image", async () => {
    outputDir = await makeTempDir("portrait");
    result = await tileImage(PORTRAIT, 1092, outputDir);

    expect(result.sourceImage.width).toBe(3600);
    expect(result.sourceImage.height).toBe(21994);
  }, 60000);

  it("produces 4×21 grid = 84 tiles", () => {
    // ceil(3600/1092) = 4, ceil(21994/1092) = 21
    expect(result.grid.cols).toBe(4);
    expect(result.grid.rows).toBe(21);
    expect(result.grid.totalTiles).toBe(84);
    expect(result.tiles).toHaveLength(84);
  });

  it("edge tiles have correct dimensions", async () => {
    // Right column: 3600 - (3 * 1092) = 3600 - 3276 = 324px
    // Bottom row: 21994 - (20 * 1092) = 21994 - 21840 = 154px
    const rightEdgeTile = result.tiles.find((t) => t.row === 0 && t.col === 3)!;
    expect(rightEdgeTile.width).toBe(324);

    const bottomEdgeTile = result.tiles.find((t) => t.row === 20 && t.col === 0)!;
    expect(bottomEdgeTile.height).toBe(154);

    // Verify actual file dimensions
    const rightMeta = await sharp(rightEdgeTile.filePath).metadata();
    expect(rightMeta.width).toBe(324);

    const bottomMeta = await sharp(bottomEdgeTile.filePath).metadata();
    expect(bottomMeta.height).toBe(154);
  });

  it("tile files exist with correct count", async () => {
    const files = await fs.readdir(outputDir);
    const tileFiles = files.filter((f) => f.startsWith("tile_") && f.endsWith(".png"));
    expect(tileFiles).toHaveLength(84);
  });

  it("end-to-end: tile → list → base64 → verify PNG", async () => {
    const tilePaths = await listTilesInDirectory(outputDir);
    expect(tilePaths).toHaveLength(84);

    // Read last tile
    const lastTile = tilePaths[tilePaths.length - 1];
    const base64 = await readTileAsBase64(lastTile);
    const buf = Buffer.from(base64, "base64");
    // PNG magic bytes
    expect(buf[0]).toBe(137);
    expect(buf[1]).toBe(80);
  });

  it("estimated tokens match formula", () => {
    expect(result.grid.estimatedTokens).toBe(84 * 1590);
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
