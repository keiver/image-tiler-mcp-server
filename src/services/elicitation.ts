import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MODEL_CONFIGS, VISION_MODELS } from "../constants.js";
import { formatModelComparisonTable } from "../utils.js";
import type { ConfirmTilingResult, ModelEstimate } from "../types.js";

export interface ConfirmTilingOptions {
  width: number;
  height: number;
  model: string;
  gridCols: number;
  gridRows: number;
  totalTiles: number;
  estimatedTokens: number;
  allModels: ModelEstimate[];
  confirmed?: boolean;
}

export async function confirmTiling(
  server: McpServer,
  options: ConfirmTilingOptions,
): Promise<ConfirmTilingResult> {
  // Path 0: bypass when confirmed=true (phase 2 call)
  if (options.confirmed === true) {
    return { confirmed: true };
  }

  // Path A: client supports elicitation — show model picker with oneOf enum
  const caps = server.server.getClientCapabilities();
  if (caps?.elicitation?.form) {
    const oneOf = VISION_MODELS.map((m) => {
      const c = MODEL_CONFIGS[m];
      const estimate = options.allModels.find((e) => e.model === m);
      const gridLabel = estimate
        ? `${estimate.cols}x${estimate.rows} grid, ${estimate.tiles} tiles, ~${estimate.tokens.toLocaleString()} tokens`
        : `${c.defaultTileSize}px tiles`;
      return {
        const: m,
        title: `${c.label} — ${gridLabel}`,
      };
    });

    const result = await server.server.elicitInput({
      message: `About to tile a ${options.width}x${options.height} image. Select a tiling preset:`,
      requestedSchema: {
        type: "object" as const,
        properties: {
          model: {
            type: "string" as const,
            title: "Select tiling preset",
            description: `Image: ${options.width}x${options.height}`,
            oneOf,
            default: options.model,
          },
        },
        required: ["model"],
      },
    });

    if (result.action === "accept") {
      const selectedModel = (result.content as Record<string, unknown>)?.model as string | undefined;
      return {
        confirmed: true,
        selectedModel: selectedModel && selectedModel !== options.model ? selectedModel : undefined,
      };
    }

    return { confirmed: false };
  }

  // Path B: no elicitation support — return pending confirmation with comparison table
  const summary = formatModelComparisonTable(options.width, options.height, options.allModels);
  return {
    confirmed: false,
    pendingConfirmation: {
      allModels: options.allModels,
      summary,
    },
  };
}
