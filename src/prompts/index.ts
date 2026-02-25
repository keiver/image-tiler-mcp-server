import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VISION_MODELS } from "../constants.js";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "tile-and-analyze",
    {
      title: "Tile and Analyze Image",
      description:
        "Tile a local image and analyze every tile at full resolution",
      argsSchema: {
        filePath: z.string().describe("Absolute or relative path to the image file"),
        preset: z
          .enum([...VISION_MODELS] as [string, ...string[]])
          .optional()
          .describe("Vision model preset (claude, openai, gemini3, gemini)"),
        focus: z
          .string()
          .optional()
          .describe("Analysis focus area (e.g. 'text readability', 'UI layout')"),
      },
    },
    ({ filePath, preset, focus }) => {
      const presetNote = preset ? ` with preset="${preset}"` : "";
      const focusNote = focus ? `\n\nFocus your analysis on: ${focus}` : "";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Tile and analyze "${filePath}" at full resolution. Follow this exact workflow:

1. Phase 1: call tiler(filePath="${filePath}"${presetNote}). Returns a model comparison table and an outputDir.
   Present the table and let the user pick a preset (or auto-select the cheapest).
2. Phase 2: call tiler(filePath="${filePath}", preset=<chosen>, outputDir=<from step 1>).
   This tiles the image and returns a metadata summary (no tile images yet).
3. Retrieve tiles: call tiler(tilesDir=<outputDir>, start=0, end=4) to get the first batch.
4. Analyze each tile. Note its row/col grid position to understand spatial layout.
5. Paginate: increment start/end by 5 and repeat until all tiles are reviewed.
6. Synthesize a full-image summary from your tile-by-tile observations.${focusNote}

LLM vision systems downscale large images automatically. Tiling preserves the detail that would otherwise be lost.`,
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
        "Capture a web page screenshot via Chrome, tile it, and analyze each tile",
      argsSchema: {
        url: z.string().url().describe("URL of the web page to capture"),
        focus: z
          .string()
          .optional()
          .describe("Analysis focus area (e.g. 'accessibility', 'responsive layout')"),
      },
    },
    ({ url, focus }) => {
      const focusNote = focus ? `\n\nFocus your analysis on: ${focus}` : "";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Capture and analyze "${url}" at full resolution. Follow this exact workflow:

1. Phase 1: call tiler(url="${url}"). Captures the page and returns a model comparison table,
   an outputDir, and a screenshotPath. Present the table and let the user pick a preset.
2. Phase 2: call tiler(screenshotPath=<from step 1>, preset=<chosen>, outputDir=<from step 1>).
   Important: use screenshotPath (not url) to reuse the existing screenshot.
   Returns a metadata summary (no tile images yet).
3. Retrieve tiles: call tiler(tilesDir=<outputDir>, start=0, end=4) to get the first batch.
4. Analyze each tile. Note spatial layout and content at each grid position.
5. Paginate: increment start/end by 5 and repeat until all tiles are reviewed.
6. Synthesize a complete page analysis from your tile-by-tile observations.${focusNote}

Requires Chrome/Chromium installed. Pages taller than 16,384px are scroll-stitched automatically.`,
            },
          },
        ],
      };
    }
  );
}
