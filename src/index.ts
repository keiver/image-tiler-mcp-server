#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTileImageTool } from "./tools/tile-image.js";
import { registerGetTilesTool } from "./tools/get-tiles.js";

const server = new McpServer({
  name: "image-tiler-mcp-server",
  version: "1.0.0",
});

registerTileImageTool(server);
registerGetTilesTool(server);

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("image-tiler-mcp-server running on stdio");
}

runStdio().catch((error: unknown) => {
  console.error("Server error:", error);
  process.exit(1);
});
