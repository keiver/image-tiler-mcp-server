#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTileImageTool } from "./tools/tile-image.js";
import { registerGetTilesTool } from "./tools/get-tiles.js";
import { registerRecommendSettingsTool } from "./tools/recommend-settings.js";
import { registerPrepareImageTool } from "./tools/prepare-image.js";
import { registerCaptureUrlTool } from "./tools/capture-url.js";
import { registerCaptureAndTileTool } from "./tools/capture-and-tile.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(version);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`image-tiler-mcp-server v${version}

MCP server that splits large images into optimally-sized tiles for LLM vision.
Runs on stdio transport — designed to be launched by an MCP client.

Usage:
  image-tiler-mcp-server            Start the MCP server (stdio)
  image-tiler-mcp-server --version  Print version and exit
  image-tiler-mcp-server --help     Print this help and exit

More info: https://github.com/keiver/image-tiler-mcp-server`);
  process.exit(0);
}

const server = new McpServer({
  name: "image-tiler-mcp-server",
  version,
});

registerTileImageTool(server);
registerGetTilesTool(server);
registerRecommendSettingsTool(server);
registerPrepareImageTool(server);
registerCaptureUrlTool(server);
registerCaptureAndTileTool(server);

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("image-tiler-mcp-server running on stdio");
}

async function shutdown(): Promise<void> {
  await server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

runStdio().catch((error: unknown) => {
  console.error("Server error:", error);
  process.exit(1);
});
