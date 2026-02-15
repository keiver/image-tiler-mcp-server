import * as fs from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CaptureUrlInputSchema } from "../schemas/index.js";
import { captureUrl, detectDisplayWidth } from "../services/url-capture.js";
import {
  WEBP_QUALITY,
  PNG_COMPRESSION_LEVEL,
  CAPTURE_DEFAULT_VIEWPORT_WIDTH,
  WAIT_UNTIL_OPTIONS,
} from "../constants.js";
import { getDefaultOutputBase } from "../utils.js";

const waitOptions = WAIT_UNTIL_OPTIONS.map((o) => `"${o}"`).join(", ");

const CAPTURE_URL_DESCRIPTION = `Capture a screenshot of a web page. Requires Google Chrome installed locally (or set CHROME_PATH env var).

Supports full-page capture including scroll-stitching for pages taller than 16,384px (Chrome's single-capture limit).

Args:
  - url (string, required): URL of the web page to capture (http or https)
  - viewportWidth (number, optional): Browser viewport width in pixels (default: ${CAPTURE_DEFAULT_VIEWPORT_WIDTH}, range: 320-3840)
  - waitUntil (string, optional): When to consider the page loaded: ${waitOptions} (default: "load")
  - delay (number, optional): Additional delay in ms after page load, before capturing (default: 0, max: 30000)
  - outputDir (string, optional): Directory to save the screenshot (default: cwd/captures/)
  - format (string, optional): Output format — "webp" (smaller, default) or "png" (lossless)

Returns:
  JSON metadata with: url, filePath, width, height, format, fileSize, segmentsStitched, viewportWidth

After capturing, use the multi-step flow for full control:
  1. tiler_recommend_settings with the saved filePath → compare models, see preview
  2. tiler_tile_image or tiler_prepare_image with the chosen model

Or use tiler_capture_and_tile for a one-shot capture + tile.`;

export function registerCaptureUrlTool(server: McpServer): void {
  server.registerTool(
    "tiler_capture_url",
    {
      title: "Capture URL Screenshot",
      description: CAPTURE_URL_DESCRIPTION,
      inputSchema: CaptureUrlInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, viewportWidth, waitUntil, delay, outputDir, format }) => {
      try {
        const resolvedViewport = viewportWidth ?? detectDisplayWidth() ?? CAPTURE_DEFAULT_VIEWPORT_WIDTH;
        const result = await captureUrl({ url, viewportWidth: resolvedViewport, waitUntil, delay });

        // Determine output directory
        const resolvedOutputDir = outputDir
          ? path.resolve(outputDir)
          : path.join(getDefaultOutputBase(), "captures");
        await fs.mkdir(resolvedOutputDir, { recursive: true });

        // Save screenshot in requested format
        const ext = format === "png" ? "png" : "webp";
        let filePath = path.join(resolvedOutputDir, `screenshot.${ext}`);
        let actualFormat = ext;
        let webpFallback = false;

        const pipeline = sharp(result.buffer);
        if (format === "png") {
          pipeline.png({ compressionLevel: PNG_COMPRESSION_LEVEL });
        } else {
          pipeline.webp({ quality: WEBP_QUALITY });
        }

        try {
          await pipeline.toFile(filePath);
        } catch (saveError) {
          if (ext === "webp" && saveError instanceof Error && saveError.message.includes("too large")) {
            // WebP has dimension limits — fall back to PNG
            actualFormat = "png";
            webpFallback = true;
            filePath = path.join(resolvedOutputDir, "screenshot.png");
            await sharp(result.buffer)
              .png({ compressionLevel: PNG_COMPRESSION_LEVEL })
              .toFile(filePath);
          } else {
            throw saveError;
          }
        }

        const fileStats = await fs.stat(filePath);

        const summaryLines = [
          `Captured ${result.pageWidth}×${result.pageHeight} screenshot of ${url}`,
          `→ Saved as ${actualFormat.toUpperCase()} to: ${filePath}`,
          `→ File size: ${(fileStats.size / 1024).toFixed(1)} KB`,
        ];

        if (webpFallback) {
          summaryLines.push(
            `⚠ Image too large for WebP format — saved as PNG instead`
          );
        }

        if (result.segmentsStitched) {
          summaryLines.push(
            `→ Scroll-stitched ${result.segmentsStitched} segments (page exceeded 16,384px height limit)`
          );
        }

        summaryLines.push(
          "",
          `Use tiler_tile_image with filePath="${filePath}" to tile this screenshot for vision analysis.`
        );

        const structuredOutput = {
          url: result.url,
          filePath,
          width: result.pageWidth,
          height: result.pageHeight,
          format: actualFormat,
          fileSize: fileStats.size,
          segmentsStitched: result.segmentsStitched ?? null,
          viewportWidth: resolvedViewport,
        };

        return {
          content: [
            { type: "text" as const, text: summaryLines.join("\n") },
            { type: "text" as const, text: JSON.stringify(structuredOutput, null, 2) },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error capturing URL: ${message}`,
            },
          ],
        };
      }
    }
  );
}
