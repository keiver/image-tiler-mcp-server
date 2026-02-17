import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MODEL_CONFIGS, VISION_MODELS } from "../constants.js";
import type { VisionModel } from "../constants.js";
import type { ModelEstimate } from "../types.js";

export interface TryElicitationOptions {
  width: number;
  height: number;
  model: VisionModel;
  allModels: ModelEstimate[];
}

export type ElicitationResult =
  | { status: "selected"; model: VisionModel }
  | { status: "cancelled" }
  | { status: "unsupported" };

/**
 * Attempts elicitation if the client supports it.
 * Returns distinct statuses: "selected" (user picked a model), "cancelled" (user
 * explicitly declined), or "unsupported" (client lacks elicitation capability).
 */
export async function tryElicitation(
  server: McpServer,
  options: TryElicitationOptions,
): Promise<ElicitationResult> {
  const caps = server.server.getClientCapabilities();
  if (!caps?.elicitation?.form) {
    return { status: "unsupported" };
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
      return { status: "selected", model: selectedModel as VisionModel };
    }
    // Fallback: user accepted but didn't pick a valid model — use the provided default
    return { status: "selected", model: options.model };
  }

  return { status: "cancelled" };
}
