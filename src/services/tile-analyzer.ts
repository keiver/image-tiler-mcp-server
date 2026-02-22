import sharp from "sharp";
import type { TileMetadata } from "../types.js";
import { withTimeout } from "../utils.js";
import {
  SHARP_OPERATION_TIMEOUT_MS,
  BLANK_STDDEV_THRESHOLD,
  LOW_DETAIL_ENTROPY_THRESHOLD,
  HIGH_DETAIL_ENTROPY_THRESHOLD,
} from "../constants.js";

interface TileGeometry {
  tileSize?: number;
  extractedWidth?: number;
  extractedHeight?: number;
}

const THIN_TILE_RATIO = 0.5;

export async function analyzeTile(
  tilePath: string,
  index: number,
  geometry?: TileGeometry
): Promise<TileMetadata> {
  const stats = await withTimeout(
    sharp(tilePath).stats(),
    SHARP_OPERATION_TIMEOUT_MS,
    "tile-stats"
  );

  const channelCount = stats.channels.length;
  if (channelCount === 0) {
    throw new Error(`Unable to analyze tile at index ${index}: image has no color channels`);
  }
  const meanBrightness =
    stats.channels.reduce((sum, ch) => sum + ch.mean, 0) / channelCount;
  const stdDev =
    stats.channels.reduce((sum, ch) => sum + ch.stdev, 0) / channelCount;
  const entropy = stats.entropy ?? 0;
  const sharpness = stats.sharpness ?? 0;

  const isThin =
    geometry?.tileSize != null &&
    ((geometry.extractedWidth != null && geometry.extractedWidth < THIN_TILE_RATIO * geometry.tileSize) ||
     (geometry.extractedHeight != null && geometry.extractedHeight < THIN_TILE_RATIO * geometry.tileSize));

  let contentHint: TileMetadata["contentHint"];
  let isBlank = false;

  if (stdDev < BLANK_STDDEV_THRESHOLD) {
    contentHint = "blank";
    isBlank = true;
  } else if (isThin) {
    contentHint = "mixed";
  } else if (entropy < LOW_DETAIL_ENTROPY_THRESHOLD) {
    contentHint = "low-detail";
  } else if (entropy > HIGH_DETAIL_ENTROPY_THRESHOLD) {
    contentHint = "high-detail";
  } else {
    contentHint = "mixed";
  }

  return {
    index,
    meanBrightness: Math.round(meanBrightness * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    entropy: Math.round(entropy * 100) / 100,
    sharpness: Math.round(sharpness * 100) / 100,
    contentHint,
    isBlank,
  };
}

export async function analyzeTiles(
  tiles: Array<{ filePath: string; index: number; extractedWidth?: number; extractedHeight?: number }>,
  tileSize?: number
): Promise<TileMetadata[]> {
  return Promise.all(
    tiles.map((t) => analyzeTile(t.filePath, t.index, { tileSize, extractedWidth: t.extractedWidth, extractedHeight: t.extractedHeight }))
  );
}
