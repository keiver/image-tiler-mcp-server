import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GetTilesInputSchema } from "../schemas/index.js";
import {
  listTilesInDirectory,
  readTileAsBase64,
} from "../services/image-processor.js";
import { MAX_TILES_PER_BATCH } from "../constants.js";

export function registerGetTilesTool(server: McpServer): void {
  server.registerTool(
    "tiler_get_tiles",
    {
      title: "Get Tile Images",
      description: `Retrieve tiled images in batches as base64 for LLM vision analysis.

Returns up to ${MAX_TILES_PER_BATCH} tiles per call to stay within MCP response size limits. Tiles are returned as image content blocks that Claude can see directly.

Args:
  - tilesDir (string, required): Path to the tiles directory (from tiler_tile_image output)
  - start (number, optional): Start tile index, 0-based inclusive (default: 0)
  - end (number, optional): End tile index, 0-based inclusive (default: start + ${MAX_TILES_PER_BATCH - 1})

Returns:
  A text summary followed by image content blocks for each tile in the requested range.
  Each image is labeled with its tile index and grid position.

Pagination example for 21 tiles:
  1. tiler_get_tiles(tilesDir="...", start=0, end=4)   → tiles 0-4
  2. tiler_get_tiles(tilesDir="...", start=5, end=9)   → tiles 5-9
  3. tiler_get_tiles(tilesDir="...", start=10, end=14)  → tiles 10-14
  4. tiler_get_tiles(tilesDir="...", start=15, end=19)  → tiles 15-19
  5. tiler_get_tiles(tilesDir="...", start=20, end=20)  → tile 20`,
      inputSchema: GetTilesInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ tilesDir, start, end }) => {
      try {
        if (end !== undefined && end < start) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Error: end index (${end}) must be >= start index (${start}).`,
              },
            ],
          };
        }

        const tilePaths = await listTilesInDirectory(tilesDir);
        const totalTiles = tilePaths.length;

        const effectiveEnd = Math.min(
          end !== undefined ? end : start + MAX_TILES_PER_BATCH - 1,
          totalTiles - 1
        );

        if (start >= totalTiles) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Error: Start index ${start} is out of range. Total tiles: ${totalTiles} (valid range: 0-${totalTiles - 1}).`,
              },
            ],
          };
        }

        if (effectiveEnd - start + 1 > MAX_TILES_PER_BATCH) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Error: Requested ${effectiveEnd - start + 1} tiles but max batch size is ${MAX_TILES_PER_BATCH}. Use start=${start}, end=${start + MAX_TILES_PER_BATCH - 1} instead.`,
              },
            ],
          };
        }

        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [];

        const hasMore = effectiveEnd < totalTiles - 1;
        const summary = [
          `Returning tiles ${start}-${effectiveEnd} of ${totalTiles} total`,
          hasMore
            ? `Next batch: tiler_get_tiles(tilesDir="${tilesDir}", start=${effectiveEnd + 1})`
            : `This is the last batch.`,
        ].join("\n");

        content.push({ type: "text" as const, text: summary });

        for (let i = start; i <= effectiveEnd; i++) {
          const tilePath = tilePaths[i];
          const filename = path.basename(tilePath);
          const match = filename.match(/tile_(\d+)_(\d+)\.png/);
          const row = match ? parseInt(match[1], 10) : -1;
          const col = match ? parseInt(match[2], 10) : -1;

          content.push({
            type: "text" as const,
            text: `--- Tile ${i} (row ${row}, col ${col}) ---`,
          });

          const base64Data = await readTileAsBase64(tilePath);
          content.push({
            type: "image" as const,
            data: base64Data,
            mimeType: "image/png",
          });
        }

        return { content };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error retrieving tiles: ${message}`,
            },
          ],
        };
      }
    }
  );
}
