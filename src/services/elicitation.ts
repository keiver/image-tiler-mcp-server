import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MODEL_CONFIGS } from "../constants.js";

interface ConfirmTilingResult {
  confirmed: boolean;
}

export async function confirmTiling(
  server: McpServer,
  width: number,
  height: number,
  model: string,
  gridCols: number,
  gridRows: number,
  totalTiles: number,
  estimatedTokens: number,
): Promise<ConfirmTilingResult> {
  const caps = server.server.getClientCapabilities();
  if (!caps?.elicitation?.form) {
    return { confirmed: true };
  }

  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  const label = config?.label ?? model;

  const result = await server.server.elicitInput({
    message: `About to tile a ${width}x${height} image for ${label}.\nGrid: ${gridCols}x${gridRows} (${totalTiles} tiles), estimated ~${estimatedTokens.toLocaleString()} tokens.`,
    requestedSchema: {
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          title: "Proceed with tiling?",
          default: true,
        },
      },
      required: ["confirm"],
    },
  });

  return {
    confirmed: result.action === "accept",
  };
}
