import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VISION_MODELS } from "../constants.js";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "tile-and-analyze",
    {
      title: "Tile and Analyze Image",
      description:
        "Guide through tiling a large image and analyzing each tile at full resolution",
      argsSchema: {
        filePath: z.string().describe("Path to the image file to tile and analyze"),
        preset: z
          .enum([...VISION_MODELS] as [string, ...string[]])
          .optional()
          .describe("Vision model preset to optimize tile size for"),
        focus: z
          .string()
          .optional()
          .describe("What to focus on (e.g. 'UI layout', 'text readability')"),
      },
    },
    ({ filePath, preset, focus }) => {
      const presetNote = preset ? ` with preset="${preset}"` : "";
      const focusNote = focus ? `\n\nFocus specifically on: ${focus}` : "";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Analyze the image at "${filePath}" at full resolution:

1. Call the tiler tool with filePath="${filePath}"${presetNote} to get the model comparison table (Phase 1).
2. Call the tiler tool again with your chosen preset and the outputDir from step 1 to tile the image (Phase 2).
3. Call the tiler tool with tilesDir set to the outputDir to retrieve the first batch of tiles.
4. Analyze each tile, noting its row/col position in the original image.
5. Continue retrieving batches (incrementing start/end by 5) until all tiles are reviewed.
6. Provide a comprehensive summary of the full image based on your tile-by-tile analysis.${focusNote}

Process every tile before drawing conclusions. Tiling preserves full resolution that would be lost if the image were sent whole.`,
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "capture-and-analyze",
    {
      title: "Capture and Analyze Web Page",
      description:
        "Guide through capturing a web page screenshot and analyzing it tile by tile",
      argsSchema: {
        url: z.string().url().describe("URL of the web page to capture and analyze"),
        focus: z
          .string()
          .optional()
          .describe("What to focus on (e.g. 'accessibility', 'responsive layout')"),
      },
    },
    ({ url, focus }) => {
      const focusNote = focus ? `\n\nFocus specifically on: ${focus}` : "";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Analyze the web page at "${url}" at full resolution:

1. Call the tiler tool with url="${url}" to capture and get the model comparison table (Phase 1).
2. Call the tiler tool again with your chosen preset and the outputDir from step 1 (Phase 2).
3. Call the tiler tool with tilesDir to retrieve tiles in batches of up to 5.
4. Analyze each tile, noting the spatial layout and content at each position.
5. Continue until all tiles are reviewed, then summarize the complete page.${focusNote}

Chrome must be installed for URL capture. Pages taller than 16,384px are automatically scroll-stitched.`,
            },
          },
        ],
      };
    }
  );
}
