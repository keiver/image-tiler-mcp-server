export interface ImageMetadata {
  width: number;
  height: number;
  format: string;
  fileSize: number;
  channels: number;
}

export interface TileGridInfo {
  cols: number;
  rows: number;
  totalTiles: number;
  tileSize: number;
  estimatedTokens: number;
}

export interface TileInfo {
  index: number;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  filename: string;
  filePath: string;
}

export interface ResizeInfo {
  originalWidth: number;
  originalHeight: number;
  resizedWidth: number;
  resizedHeight: number;
  scaleFactor: number; // 0-1, e.g. 0.5 = half size
}

export interface TileImageResult {
  sourceImage: ImageMetadata;
  grid: TileGridInfo;
  outputDir: string;
  tiles: TileInfo[];
  resize?: ResizeInfo; // present only when downscaling occurred
  warnings?: string[];
}

// Image source resolution
export type ImageSourceType = "file" | "url" | "data_url" | "base64";

export interface ResolvedImageSource {
  localPath: string;
  cleanup?: () => Promise<string | undefined>;
  sourceType: ImageSourceType;
  originalSource: string;
}

// URL capture
export interface CaptureUrlOptions {
  url: string;
  viewportWidth?: number;
  waitUntil?: "load" | "networkidle" | "domcontentloaded";
  delay?: number;
  timeout?: number;
}

export interface CaptureResult {
  buffer: Buffer;
  pageWidth: number;
  pageHeight: number;
  url: string;
  segmentsStitched?: number;
}

// Tile metadata (smart analysis)
export interface TileMetadata {
  index: number;
  meanBrightness: number;
  stdDev: number;
  entropy: number;      // 0.0-8.0 (Shannon entropy of greyscale histogram)
  sharpness: number;    // 0+ (Laplacian stdDev, higher = more edges)
  contentHint: "blank" | "low-detail" | "mixed" | "high-detail";
  isBlank: boolean;
}

// Tiling pipeline: Phase 1 analysis result
export interface AnalysisResult {
  outputDir: string;
  previewPath?: string;
  sourceImage: { width: number; height: number };
  effectiveImage?: { width: number; height: number };
  allModels: ModelEstimate[];
  warnings?: string[];
}

// Recommend-settings output
export interface ModelEstimate {
  model: string;
  label: string;
  tileSize: number;
  cols: number;
  rows: number;
  tiles: number;
  tokens: number;
}

