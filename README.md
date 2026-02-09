# image-tiler-mcp-server

MCP server that splits large images into optimally-sized tiles for LLM vision processing. Supports Claude, OpenAI, Gemini, and Gemini 3.

## The Problem

LLM vision systems automatically downscale large images. A full-page screenshot at 3600x21994 pixels gets resized to ~257x1568 by Claude, making text completely unreadable. You lose all the detail you need the model to analyze.

## The Solution

This server splits large images into tiles sized for each model's sweet spot. Each tile is processed at full resolution with no downscaling, preserving text, UI elements, and fine detail.

### Supported Models

| Model | Default tile | Tokens/tile | Max tile | Key |
|-------|-------------|-------------|----------|-----|
| Claude (default) | 1092px | 1590 | 1568px | `claude` |
| OpenAI (GPT-4o/o-series) | 768px | 765 | 2048px | `openai` |
| Gemini | 768px | 258 | 768px | `gemini` |
| Gemini 3 | 1536px | 1120 | 3072px | `gemini3` |

> **OpenAI note:** The `openai` config targets the GPT-4o / o-series vision pipeline (512px tile patches). GPT-4.1 uses a fundamentally different pipeline (32x32 pixel patches) and is not currently supported — it would require a separate model config with a different calculation approach.

> **Gemini 3 note:** Gemini 3 uses a fixed token budget per image (1120 tokens regardless of dimensions). Tiling increases total token cost but preserves fine detail. For cases where detail isn't critical, consider sending a single image instead.

## Tools

### `tiler_tile_image`

Splits a large image into tiles and saves them to disk.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `filePath` | string | yes | — | Absolute or relative path to the image file |
| `model` | string | no | `"claude"` | Target vision model: `"claude"`, `"openai"`, `"gemini"`, `"gemini3"` |
| `tileSize` | number | no | Model default | Tile size in pixels. Clamped to model min/max with a warning if out of bounds. |
| `outputDir` | string | no | `./tiles` next to source | Directory to save tiles |

Returns JSON metadata with grid dimensions, tile count, model used, estimated token cost, and per-tile file paths.

### `tiler_get_tiles`

Returns tile images as base64 in batches of 5 for the LLM to see directly.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `tilesDir` | string | yes | — | Path to tiles directory (from `tiler_tile_image`) |
| `start` | number | no | 0 | Start tile index (0-based, inclusive) |
| `end` | number | no | start + 4 | End tile index (0-based, inclusive) |

Returns text labels + image content blocks. Includes pagination hint for the next batch.

## Installation

### Claude Code

```bash
claude mcp add image-tiler -- npx -y image-tiler-mcp-server
```

See [Claude Code MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp) for more info.

### Claude Desktop

Add to your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "image-tiler": {
      "command": "npx",
      "args": ["-y", "image-tiler-mcp-server"]
    }
  }
}
```

Restart Claude Desktop after editing.

### VS Code (Cline / Continue)

Add to your VS Code MCP settings:

```json
{
  "image-tiler": {
    "command": "npx",
    "args": ["-y", "image-tiler-mcp-server"]
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "image-tiler": {
      "command": "npx",
      "args": ["-y", "image-tiler-mcp-server"]
    }
  }
}
```

### Global Install (faster startup)

```bash
npm install -g image-tiler-mcp-server
```

Then use the simpler config in any client:

```json
{
  "command": "image-tiler-mcp-server"
}
```

### From Source

```bash
git clone https://github.com/keiver/image-tiler-mcp-server.git
cd image-tiler-mcp-server
npm install
npm run build
```

Then point your MCP config to the built file:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/image-tiler-mcp-server/dist/index.js"]
}
```

## Usage

### In Claude Code

```
> Tile the screenshot at ./screenshots/full-page.png and analyze the layout

Claude will:
1. Call tiler_tile_image(filePath="./screenshots/full-page.png")
2. See: "Tiled 3600x21994 image → 4x21 grid = 84 tiles"
3. Call tiler_get_tiles(tilesDir="./screenshots/tiles", start=0, end=4)
4. Analyze tiles 0-4, then continue with start=5...
```

### With Other Models

```
> Tile this image for GPT-4o analysis

Claude will:
1. Call tiler_tile_image(filePath="./image.png", model="openai")
2. Tiles sized at 768px for OpenAI's vision pipeline
```

### Typical Workflow

1. Capture full-page screenshot with your browser extension
2. Ask Claude: _"Tile `/path/to/screencapture-localhost-3000.png` and review all sections"_
3. Claude pages through tiles automatically, analyzing each batch

## Token Cost Reference

Costs vary by model. Formula: `tokens = totalTiles x tokensPerTile`

### Claude (1092px tiles, 1590 tokens/tile)

| Image Dimensions | Tiles | Estimated Tokens |
|---|---|---|
| 1440x3000 | 6 | ~9,540 |
| 3600x5000 | 20 | ~31,800 |
| 3600x21994 | 84 | ~133,560 |

### OpenAI — GPT-4o/o-series (768px tiles, 765 tokens/tile)

| Image Dimensions | Tiles | Estimated Tokens |
|---|---|---|
| 1440x3000 | 8 | ~6,120 |
| 3600x5000 | 35 | ~26,775 |
| 3600x21994 | 145 | ~110,925 |

### Gemini (768px tiles, 258 tokens/tile)

| Image Dimensions | Tiles | Estimated Tokens |
|---|---|---|
| 1440x3000 | 8 | ~2,064 |
| 3600x5000 | 35 | ~9,030 |
| 3600x21994 | 145 | ~37,410 |

### Gemini 3 (1536px tiles, 1120 tokens/tile)

| Image Dimensions | Tiles | Estimated Tokens |
|---|---|---|
| 1440x3000 | 2 | ~2,240 |
| 3600x5000 | 12 | ~13,440 |
| 3600x21994 | 45 | ~50,400 |

> **Note:** Gemini 3 uses a fixed 1120 tokens per image regardless of dimensions. More tiles = more total tokens but better detail preservation.

## Supported Formats

PNG, JPEG, WebP, TIFF, GIF

## Technical Details

- **Image processing:** Sharp (libvips) — demand-driven pipeline, streams tiles without full decompression
- **Memory usage:** ~350-400MB peak for 30MB+ PNGs
- **Transport:** stdio (local, single-session)
- **Tile naming:** `tile_ROW_COL.png` (zero-padded, e.g., `tile_000_003.png`)
- **Grid order:** Left-to-right, top-to-bottom
- **Batch limit:** 5 tiles per `tiler_get_tiles` call to stay within MCP response limits

## Troubleshooting

**"Command not found"** — Make sure Node.js 18+ is installed: `node --version`

**"File not found"** — Use absolute paths. Relative paths resolve from the MCP server's working directory.

**"MCP tools not available"** — Restart your MCP client after config changes. In Claude Code, run `/mcp` to check server status.

## Requirements

- Node.js 18+
- Compatible MCP client (Claude Code, Claude Desktop, Cursor, VS Code with MCP extension)

## License

MIT

## Links

- [GitHub Repository](https://github.com/keiver/image-tiler-mcp-server)
- [NPM Package](https://www.npmjs.com/package/image-tiler-mcp-server)
- [Report Issues](https://github.com/keiver/image-tiler-mcp-server/issues)
