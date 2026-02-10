#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTileImageTool } from "./tools/tile-image.js";
import { registerGetTilesTool } from "./tools/get-tiles.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const server = new McpServer({
  name: "image-tiler-mcp-server",
  version,
});

registerTileImageTool(server);
registerGetTilesTool(server);

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
