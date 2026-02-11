import sharp from "sharp";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_IMAGE_DIMENSION,
  MAX_TOTAL_TILES,
  PNG_COMPRESSION_LEVEL,
  TOKENS_PER_TILE,
} from "../constants.js";
import type { ImageMetadata, ResizeInfo, TileGridInfo, TileInfo, TileImageResult } from "../types.js";

sharp.cache({ items: 10, memory: 200 });
sharp.concurrency(2);

export async function getImageMetadata(
  filePath: string
): Promise<ImageMetadata> {
  const stats = await fs.stat(filePath);
  const metadata = await sharp(filePath).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error(
      `Unable to read image dimensions from ${filePath}. File may be corrupted or not a supported image format.`
    );
  }

  if (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION) {
    throw new Error(
      `Image dimensions ${metadata.width}×${metadata.height} exceed maximum allowed ${MAX_IMAGE_DIMENSION}px. ` +
      `Resize the image before tiling.`
    );
  }

  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format || "unknown",
    fileSize: stats.size,
    channels: metadata.channels || 0,
  };
}

export function calculateGrid(
  width: number,
  height: number,
  tileSize: number,
  tokensPerTile: number = TOKENS_PER_TILE
): TileGridInfo {
  const cols = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const totalTiles = cols * rows;

  return {
    cols,
    rows,
    totalTiles,
    tileSize,
    estimatedTokens: totalTiles * tokensPerTile,
  };
}

export async function resizeImage(
  filePath: string,
  maxDimension: number,
  outputPath: string
): Promise<ResizeInfo | null> {
  const metadata = await sharp(filePath).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(
      `Unable to read image dimensions from ${filePath}. File may be corrupted or not a supported image format.`
    );
  }

  const longestSide = Math.max(metadata.width, metadata.height);
  if (longestSide <= maxDimension) {
    return null; // no resize needed
  }

  const scaleFactor = maxDimension / longestSide;
  const resizedWidth = Math.round(metadata.width * scaleFactor);
  const resizedHeight = Math.round(metadata.height * scaleFactor);

  await sharp(filePath)
    .resize(resizedWidth, resizedHeight, { fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: PNG_COMPRESSION_LEVEL })
    .toFile(outputPath);

  return {
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    resizedWidth,
    resizedHeight,
    scaleFactor: Math.round(scaleFactor * 1000) / 1000,
  };
}

export async function tileImage(
  filePath: string,
  tileSize: number,
  outputDir: string,
  tokensPerTile: number = TOKENS_PER_TILE,
  maxDimension?: number
): Promise<TileImageResult> {
  const resolvedPath = path.resolve(filePath);

  try {
    await fs.access(resolvedPath);
  } catch {
    throw new Error(
      `File not found: ${resolvedPath}. Verify the file path is correct and the file exists.`
    );
  }

  const resolvedOutputDir = path.resolve(outputDir);
  await fs.mkdir(resolvedOutputDir, { recursive: true });

  let sourcePath = resolvedPath;
  let resizeInfo: ResizeInfo | null = null;
  let resizedTempPath: string | null = null;

  if (maxDimension !== undefined) {
    const tempPath = path.join(resolvedOutputDir, `__resized_${randomUUID()}.png`);
    resizeInfo = await resizeImage(resolvedPath, maxDimension, tempPath);
    if (resizeInfo) {
      sourcePath = tempPath;
      resizedTempPath = tempPath;
    }
  }

  try {
    const imageMetadata = await getImageMetadata(sourcePath);
    const grid = calculateGrid(
      imageMetadata.width,
      imageMetadata.height,
      tileSize,
      tokensPerTile
    );

    if (grid.totalTiles > MAX_TOTAL_TILES) {
      throw new Error(
        `Tiling would produce ${grid.totalTiles} tiles (${grid.cols}×${grid.rows}), exceeding the maximum of ${MAX_TOTAL_TILES}. ` +
        `Use a larger tile size or a smaller image.`
      );
    }

    const tiles: TileInfo[] = [];
    let index = 0;

    try {
      for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.cols; col++) {
          const x = col * tileSize;
          const y = row * tileSize;
          const tileWidth = Math.min(tileSize, imageMetadata.width - x);
          const tileHeight = Math.min(tileSize, imageMetadata.height - y);

          const filename = `tile_${String(row).padStart(3, "0")}_${String(col).padStart(3, "0")}.png`;
          const tilePath = path.join(resolvedOutputDir, filename);

          await sharp(sourcePath)
            .extract({ left: x, top: y, width: tileWidth, height: tileHeight })
            .png({ compressionLevel: PNG_COMPRESSION_LEVEL })
            .toFile(tilePath);

          tiles.push({
            index,
            row,
            col,
            x,
            y,
            width: tileWidth,
            height: tileHeight,
            filename,
            filePath: tilePath,
          });

          index++;
        }
      }
    } catch (error) {
      for (const tile of tiles) {
        await fs.unlink(tile.filePath).catch(() => {});
      }
      throw error;
    }

    const result: TileImageResult = {
      sourceImage: imageMetadata,
      grid,
      outputDir: resolvedOutputDir,
      tiles,
    };

    if (resizeInfo) {
      result.resize = resizeInfo;
    }

    return result;
  } finally {
    if (resizedTempPath) {
      try {
        await fs.unlink(resizedTempPath);
      } catch (err: unknown) {
        // ENOENT = already gone, safe to ignore.
        // Anything else = orphaned temp file, surface it.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[image-tiler] Failed to clean up temp file ${resizedTempPath}: ${msg}`);
        }
      }
    }
  }
}

export async function readTileAsBase64(tilePath: string): Promise<string> {
  const buffer = await fs.readFile(tilePath);
  return buffer.toString("base64");
}

export async function listTilesInDirectory(
  tilesDir: string
): Promise<string[]> {
  const resolvedDir = path.resolve(tilesDir);

  try {
    await fs.access(resolvedDir);
  } catch {
    throw new Error(
      `Tiles directory not found: ${resolvedDir}. Run tiler_tile_image first to generate tiles.`
    );
  }

  const entries = await fs.readdir(resolvedDir);
  const tileFiles = entries
    .filter((f) => f.startsWith("tile_") && f.endsWith(".png"))
    .sort();

  if (tileFiles.length === 0) {
    throw new Error(
      `No tile files found in ${resolvedDir}. Run tiler_tile_image first to generate tiles.`
    );
  }

  return tileFiles.map((f) => path.join(resolvedDir, f));
}
