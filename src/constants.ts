export const VISION_MODELS = ["claude", "openai", "gemini", "gemini3"] as const;
export type VisionModel = (typeof VISION_MODELS)[number];

export interface ModelVisionConfig {
  defaultTileSize: number;
  minTileSize: number;
  maxTileSize: number;
  tokensPerTile: number;
  label: string;
}

export const MODEL_CONFIGS: Record<VisionModel, ModelVisionConfig> = {
  claude: {
    defaultTileSize: 1092,
    minTileSize: 256,
    maxTileSize: 1568,
    tokensPerTile: 1590,
    label: "Claude",
  },
  openai: {
    defaultTileSize: 768,
    minTileSize: 256,
    maxTileSize: 2048,
    tokensPerTile: 765,
    label: "OpenAI",
  },
  gemini: {
    defaultTileSize: 768,
    minTileSize: 256,
    maxTileSize: 768,
    tokensPerTile: 258,
    label: "Gemini",
  },
  gemini3: {
    defaultTileSize: 1536,
    minTileSize: 384,
    maxTileSize: 3072,
    tokensPerTile: 1120,
    label: "Gemini 3",
  },
};

export const DEFAULT_MODEL: VisionModel = "claude";

// Backward-compatible aliases (point to Claude config)
export const DEFAULT_TILE_SIZE = MODEL_CONFIGS.claude.defaultTileSize;
export const MAX_TILE_SIZE = MODEL_CONFIGS.claude.maxTileSize;
export const MIN_TILE_SIZE = MODEL_CONFIGS.claude.minTileSize;
export const TOKENS_PER_TILE = MODEL_CONFIGS.claude.tokensPerTile;

export const MAX_IMAGE_DIMENSION = 65536;
export const MAX_TOTAL_TILES = 10000;
export const MAX_TILES_PER_BATCH = 5;
export const SUPPORTED_FORMATS = ["png", "jpeg", "jpg", "webp", "tiff", "gif"] as const;
export const PNG_COMPRESSION_LEVEL = 6;
export const DEFAULT_MAX_DIMENSION = 10000;

// Image source resolution
export const MAX_DOWNLOAD_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
export const DOWNLOAD_TIMEOUT_MS = 30_000; // 30 seconds
export const ALLOWED_URL_PROTOCOLS = ["https:"] as const;
export const MAX_BASE64_LENGTH = 67_108_864; // ~50MB decoded (base64 is ~4/3x)
export const MAX_DATA_URL_LENGTH = MAX_BASE64_LENGTH + 256; // base64 payload + data URL prefix overhead

// Remainder absorption: if a remainder strip is < 15% of tileSize, absorb it into the last tile
export const MIN_REMAINDER_RATIO = 0.15;

// Intent and budget enums for recommend-settings
export const IMAGE_INTENTS = ["text_heavy", "ui_screenshot", "diagram", "photo", "general"] as const;
export type ImageIntent = (typeof IMAGE_INTENTS)[number];

export const BUDGET_LEVELS = ["low", "default", "max_detail"] as const;
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];

// Tile output formats
export const TILE_OUTPUT_FORMATS = ["png", "webp"] as const;
export type TileOutputFormat = (typeof TILE_OUTPUT_FORMATS)[number];
export const WEBP_QUALITY = 80;

// URL capture
export const MAX_CAPTURE_HEIGHT = 200_000; // max page height for scroll-stitching (~12 segments)
export const CHROME_MAX_CAPTURE_HEIGHT = 16384;
export const CAPTURE_DEFAULT_VIEWPORT_WIDTH = 1280;
export const CAPTURE_DEFAULT_VIEWPORT_HEIGHT = 800;
export const CAPTURE_DEFAULT_TIMEOUT_MS = 60_000;
export const CAPTURE_STITCH_SETTLE_MS = 100;
export const CAPTURE_IDLE_TIMEOUT_MS = 500;
export const WAIT_UNTIL_OPTIONS = ["load", "networkidle", "domcontentloaded"] as const;
export type WaitUntil = (typeof WAIT_UNTIL_OPTIONS)[number];
export const ALLOWED_CAPTURE_PROTOCOLS = ["https:", "http:"] as const;

// Preview rendering
export const MAX_PREVIEW_PIXELS = 16_000_000; // Safari's canvas/image rendering limit
