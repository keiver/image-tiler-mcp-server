import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MODEL_CONFIGS, VISION_MODELS } from "../constants.js";
import type { VisionModel } from "../constants.js";
import type { ModelEstimate } from "../types.js";

export interface TryElicitationOptions {
  width: number;
  height: number;
  model: string;
  allModels: ModelEstimate[];
}

/**
 * Attempts elicitation if the client supports it.
 * Returns the selected model (VisionModel) if the user picks one,
 * or null if elicitation is unavailable or user declines/cancels.
 */
export async function tryElicitation(
  server: McpServer,
  options: TryElicitationOptions,
): Promise<VisionModel | null> {
  const caps = server.server.getClientCapabilities();
  if (!caps?.elicitation?.form) {
    return null;
  }

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
    if (selectedModel && VISION_MODELS.includes(selectedModel as VisionModel)) {
      return selectedModel as VisionModel;
    }
    // Fallback: user accepted but didn't pick a valid model — use the provided default if valid
    if (VISION_MODELS.includes(options.model as VisionModel)) {
      return options.model as VisionModel;
    }
    return VISION_MODELS[0];
  }

  return null;
}
