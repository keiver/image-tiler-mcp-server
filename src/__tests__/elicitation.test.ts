import { describe, it, expect, vi } from "vitest";
import { confirmTiling } from "../services/elicitation.js";
import type { ModelEstimate } from "../types.js";

const sampleAllModels: ModelEstimate[] = [
  { model: "claude", label: "Claude", tileSize: 1092, cols: 8, rows: 4, tiles: 32, tokens: 50880 },
  { model: "openai", label: "OpenAI", tileSize: 768, cols: 10, rows: 6, tiles: 60, tokens: 45900 },
  { model: "gemini", label: "Gemini", tileSize: 768, cols: 10, rows: 6, tiles: 60, tokens: 15480 },
  { model: "gemini3", label: "Gemini 3", tileSize: 1536, cols: 5, rows: 3, tiles: 15, tokens: 16800 },
];

function makeOptions(overrides?: Record<string, unknown>) {
  return {
    width: 7680,
    height: 4032,
    model: "claude",
    gridCols: 8,
    gridRows: 4,
    totalTiles: 32,
    estimatedTokens: 50880,
    allModels: sampleAllModels,
    ...overrides,
  };
}

function createMockMcpServer(opts: {
  supportsElicitation?: boolean;
  elicitResult?: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
  capsUndefined?: boolean;
}) {
  const elicitInput = vi.fn().mockResolvedValue(opts.elicitResult ?? { action: "accept", content: { model: "claude" } });
  return {
    server: {
      getClientCapabilities: vi.fn().mockReturnValue(
        opts.capsUndefined
          ? undefined
          : opts.supportsElicitation
            ? { elicitation: { form: {} } }
            : {}
      ),
      elicitInput,
    },
  };
}

describe("confirmTiling", () => {
  describe("confirmed bypass (Path 0)", () => {
    it("returns confirmed when confirmed=true, skipping everything", async () => {
      const server = createMockMcpServer({ supportsElicitation: true });
      const result = await confirmTiling(server as any, makeOptions({ confirmed: true }));
      expect(result).toEqual({ confirmed: true });
      expect(server.server.elicitInput).not.toHaveBeenCalled();
      expect(server.server.getClientCapabilities).not.toHaveBeenCalled();
    });

    it("returns confirmed when confirmed=true even without elicitation support", async () => {
      const server = createMockMcpServer({ supportsElicitation: false });
      const result = await confirmTiling(server as any, makeOptions({ confirmed: true }));
      expect(result).toEqual({ confirmed: true });
    });
  });

  describe("elicitation-capable clients (Path A)", () => {
    it("returns confirmed when user accepts", async () => {
      const server = createMockMcpServer({
        supportsElicitation: true,
        elicitResult: { action: "accept", content: { model: "claude" } },
      });
      const result = await confirmTiling(server as any, makeOptions());
      expect(result.confirmed).toBe(true);
      expect(result.selectedModel).toBeUndefined(); // same model, no change
      expect(server.server.elicitInput).toHaveBeenCalledTimes(1);
    });

    it("returns selectedModel when user picks a different model", async () => {
      const server = createMockMcpServer({
        supportsElicitation: true,
        elicitResult: { action: "accept", content: { model: "openai" } },
      });
      const result = await confirmTiling(server as any, makeOptions({ model: "claude" }));
      expect(result.confirmed).toBe(true);
      expect(result.selectedModel).toBe("openai");
    });

    it("returns not confirmed when user declines", async () => {
      const server = createMockMcpServer({
        supportsElicitation: true,
        elicitResult: { action: "decline" },
      });
      const result = await confirmTiling(server as any, makeOptions());
      expect(result).toEqual({ confirmed: false });
    });

    it("returns not confirmed when user cancels", async () => {
      const server = createMockMcpServer({
        supportsElicitation: true,
        elicitResult: { action: "cancel" },
      });
      const result = await confirmTiling(server as any, makeOptions());
      expect(result).toEqual({ confirmed: false });
    });

    it("sends oneOf enum schema with all models", async () => {
      const server = createMockMcpServer({
        supportsElicitation: true,
        elicitResult: { action: "accept", content: { model: "claude" } },
      });
      await confirmTiling(server as any, makeOptions());
      const call = server.server.elicitInput.mock.calls[0][0];
      const schema = call.requestedSchema;
      expect(schema.properties.model.type).toBe("string");
      expect(schema.properties.model.oneOf).toHaveLength(4);
      expect(schema.properties.model.oneOf[0].const).toBe("claude");
      expect(schema.properties.model.oneOf[0].title).toContain("Claude");
      expect(schema.properties.model.oneOf[0].title).toContain("32 tiles");
      expect(schema.properties.model.oneOf[1].const).toBe("openai");
      expect(schema.properties.model.oneOf[2].const).toBe("gemini");
      expect(schema.properties.model.oneOf[3].const).toBe("gemini3");
      expect(schema.properties.model.default).toBe("claude");
    });

    it("includes image dimensions in elicitation message", async () => {
      const server = createMockMcpServer({
        supportsElicitation: true,
        elicitResult: { action: "accept", content: { model: "claude" } },
      });
      await confirmTiling(server as any, makeOptions());
      const call = server.server.elicitInput.mock.calls[0][0];
      expect(call.message).toContain("7680x4032");
    });

    it("propagates errors from elicitInput", async () => {
      const server = createMockMcpServer({ supportsElicitation: true });
      server.server.elicitInput.mockRejectedValue(new Error("Transport closed"));
      await expect(
        confirmTiling(server as any, makeOptions())
      ).rejects.toThrow("Transport closed");
    });
  });

  describe("non-elicitation clients (Path B)", () => {
    it("returns pendingConfirmation when client lacks elicitation support", async () => {
      const server = createMockMcpServer({ supportsElicitation: false });
      const result = await confirmTiling(server as any, makeOptions());
      expect(result.confirmed).toBe(false);
      expect(result.pendingConfirmation).toBeDefined();
      expect(result.pendingConfirmation!.allModels).toEqual(sampleAllModels);
      expect(result.pendingConfirmation!.summary).toContain("7680 x 4032");
      expect(result.pendingConfirmation!.summary).toContain("confirmed=true");
      expect(server.server.elicitInput).not.toHaveBeenCalled();
    });

    it("returns pendingConfirmation when client capabilities are undefined", async () => {
      const server = createMockMcpServer({ capsUndefined: true });
      const result = await confirmTiling(server as any, makeOptions());
      expect(result.confirmed).toBe(false);
      expect(result.pendingConfirmation).toBeDefined();
      expect(result.pendingConfirmation!.allModels).toHaveLength(4);
    });

    it("pendingConfirmation summary includes model comparison table", async () => {
      const server = createMockMcpServer({ supportsElicitation: false });
      const result = await confirmTiling(server as any, makeOptions());
      const summary = result.pendingConfirmation!.summary;
      expect(summary).toContain("Preset");
      expect(summary).toContain("Tile Size");
      expect(summary).toContain("Grid");
      expect(summary).toContain("Tiles");
      expect(summary).toContain("Est. Tokens");
    });
  });
});
