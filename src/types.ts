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
}
