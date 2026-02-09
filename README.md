# image-tiler-mcp-server

MCP server that splits large screenshots into Claude-optimized 1072×1072 pixel tiles for LLM vision processing.

## The Problem

Claude's vision system automatically downscales images with a long edge >1568px. A full-page screenshot at 3600×21994 pixels gets resized to ~257×1568, making text completely unreadable. You lose all the detail you need Claude to analyze.

## The Solution

This server splits large images into 1072×1072 tiles — Claude's sweet spot at ~1.15 megapixels per tile. Each tile is processed at full resolution with no downscaling, preserving text, UI elements, and fine detail.

## Tools

### `tiler_tile_image`

Splits a large image into tiles and saves them to disk.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `filePath` | string | yes | — | Absolute or relative path to the image file |
| `tileSize` | number | no | 1072 | Tile size in pixels (range: 256–1568) |
| `outputDir` | string | no | `./tiles` next to source | Directory to save tiles |

Returns JSON metadata with grid dimensions, tile count, estimated token cost, and per-tile file paths.

### `tiler_get_tiles`

Returns tile images as base64 in batches of 5 for Claude to see directly.

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
2. See: "Tiled 3600×21994 image → 4×21 grid = 84 tiles"
3. Call tiler_get_tiles(tilesDir="./screenshots/tiles", start=0, end=4)
4. Analyze tiles 0–4, then continue with start=5...
```

### Typical Workflow

1. Capture full-page screenshot with your browser extension
2. Ask Claude: _"Tile `/path/to/screencapture-localhost-3000.png` and review all sections"_
3. Claude pages through tiles automatically, analyzing each batch

## Token Cost Reference

| Image Dimensions | Tiles | Estimated Tokens |
|---|---|---|
| 1440×3000 | 6 | ~9,198 |
| 3600×5000 | 20 | ~30,660 |
| 3600×21994 | 84 | ~128,772 |

Formula: `tokens = totalTiles × 1533`

## Supported Formats

PNG, JPEG, WebP, TIFF, GIF

## Technical Details

- **Image processing:** Sharp (libvips) — demand-driven pipeline, streams tiles without full decompression
- **Memory usage:** ~350–400MB peak for 30MB+ PNGs
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
