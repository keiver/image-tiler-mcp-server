import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MODEL_CONFIGS, VISION_MODELS } from "../constants.js";

const _maxModelLen = Math.max(...VISION_MODELS.map((m) => m.length));
const _maxSizeDigits = Math.max(...VISION_MODELS.map((m) => String(MODEL_CONFIGS[m].defaultTileSize).length));
const PRESET_LINES = VISION_MODELS.map((model) => {
  const c = MODEL_CONFIGS[model];
  const modelPad = " ".repeat(_maxModelLen - model.length + 2);
  const sizePad = " ".repeat(_maxSizeDigits - String(c.defaultTileSize).length + 1);
  return `  ${model}${modelPad}-- ${c.defaultTileSize}px tiles,${sizePad}~${c.tokensPerTile} tokens/tile`;
}).join("\n");

export function registerResources(server: McpServer): void {
  server.registerResource(
    "model-configs",
    "tiler://models",
    {
      title: "Vision Model Presets",
      description:
        "Supported vision model presets with tile sizes and per-tile token estimates",
      mimeType: "application/json",
    },
    (uri) => {
      const configs = Object.fromEntries(
        VISION_MODELS.map((model) => {
          const c = MODEL_CONFIGS[model];
          return [
            model,
            {
              label: c.label,
              defaultTileSize: c.defaultTileSize,
              minTileSize: c.minTileSize,
              maxTileSize: c.maxTileSize,
              tokensPerTile: c.tokensPerTile,
            },
          ];
        })
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(configs, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    "usage-guide",
    "tiler://guide",
    {
      title: "Usage Guide",
      description:
        "Quick reference: workflow, presets, and tips for the image tiler",
      mimeType: "text/plain",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/plain",
          text: `Image Tiler MCP Server -- Quick Reference

WHY TILE:
LLM vision systems downscale large images. A 3600x22000px screenshot sent whole
to Claude becomes ~257x1568px, losing all fine text. Tiling splits the image into
chunks that stay within each model's resolution sweet spot.

WORKFLOW (minimum three tool calls):
1. tiler(filePath=...) -- Phase 1: returns model comparison table and outputDir.
2. tiler(filePath=..., preset=..., outputDir=...) -- Phase 2: tiles the image, returns metadata summary.
   Re-include the original image source. For captures, use screenshotPath instead of url.
3. tiler(tilesDir=..., start=0, end=4) -- Get-tiles: retrieve tile images in batches of 5.
   Increment start/end by 5 to paginate through remaining tiles.

PRESETS:
${PRESET_LINES}

TIPS:
- Review ALL tiles before drawing conclusions about the full image.
- Tile row/col coordinates map to spatial position in the original.
- includeMetadata is on by default; blank tiles are auto-skipped in get-tiles mode.
- URL capture requires Chrome/Chromium. Set CHROME_PATH to override detection.
- Pages taller than 16,384px are scroll-stitched automatically.
- maxDimension (default 10000px) downscales very large inputs before tiling.`,
        },
      ],
    })
  );
}
