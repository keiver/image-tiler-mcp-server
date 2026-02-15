import sharp from "sharp";
import type { TileMetadata } from "../types.js";

export async function analyzeTile(
  tilePath: string,
  index: number
): Promise<TileMetadata> {
  const stats = await sharp(tilePath).stats();

  const channelCount = stats.channels.length;
  if (channelCount === 0) {
    throw new Error(`Unable to analyze tile at index ${index}: image has no color channels`);
  }
  const meanBrightness =
    stats.channels.reduce((sum, ch) => sum + ch.mean, 0) / channelCount;
  const stdDev =
    stats.channels.reduce((sum, ch) => sum + ch.stdev, 0) / channelCount;

  let contentHint: TileMetadata["contentHint"];
  let isBlank = false;

  if (stdDev < 5) {
    contentHint = "low-detail";
    isBlank = true;
  } else if (stdDev < 25) {
    contentHint = "text-heavy";
  } else if (stdDev > 60) {
    contentHint = "image-rich";
  } else {
    contentHint = "mixed";
  }

  return {
    index,
    meanBrightness: Math.round(meanBrightness * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    contentHint,
    isBlank,
  };
}

export async function analyzeTiles(
  tilePaths: string[]
): Promise<TileMetadata[]> {
  return Promise.all(
    tilePaths.map((tilePath, index) => analyzeTile(tilePath, index))
  );
}
