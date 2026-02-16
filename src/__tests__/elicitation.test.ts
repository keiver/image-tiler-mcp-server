import { describe, it, expect, vi } from "vitest";
import { tryElicitation } from "../services/elicitation.js";
import type { TryElicitationOptions } from "../services/elicitation.js";
import type { VisionModel } from "../constants.js";
import type { ModelEstimate } from "../types.js";

const sampleAllModels: ModelEstimate[] = [
  { model: "claude", label: "Claude", tileSize: 1092, cols: 8, rows: 4, tiles: 32, tokens: 50880 },
  { model: "openai", label: "OpenAI", tileSize: 768, cols: 10, rows: 6, tiles: 60, tokens: 45900 },
  { model: "gemini", label: "Gemini", tileSize: 768, cols: 10, rows: 6, tiles: 60, tokens: 15480 },
  { model: "gemini3", label: "Gemini 3", tileSize: 1536, cols: 5, rows: 3, tiles: 15, tokens: 16800 },
];

function makeOptions(overrides?: Partial<TryElicitationOptions>): TryElicitationOptions {
  return {
    width: 7680,
    height: 4032,
    model: "claude" as VisionModel,
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

describe("tryElicitation", () => {
  describe("no elicitation support", () => {
    it("returns null when client lacks elicitation support", async () => {
      const server = createMockMcpServer({ supportsElicitation: false });
      const result = await tryElicitation(server as any, makeOptions());
      expect(result).toBeNull();
      expect(server.server.elicitInput).not.toHaveBeenCalled();
    });

    it("returns null when client capabilities are undefined", async () => {
      const server = createMockMcpServer({ capsUndefined: true });
      const result = await tryElicitation(server as any, makeOptions());
      expect(result).toBeNull();
    });
  });

  describe("elicitation-capable clients", () => {
    it("returns selected model when user accepts", async () => {
      const server = createMockMcpServer({
        supportsElicitation: true,
        elicitResult: { action: "accept", content: { model: "claude" } },
      });
      const result = await tryElicitation(server as any, makeOptions());
      expect(result).toBe("claude");
      expect(server.server.elicitInput).toHaveBeenCalledTimes(1);
    });

    it("returns different model when user picks a different one", async () => {
      const server = createMockMcpServer({
        supportsElicitation: true,
        elicitResult: { action: "accept", content: { model: "openai" } },
      });
      const result = await tryElicitation(server as any, makeOptions({ model: "claude" }));
      expect(result).toBe("openai");
    });

    it("returns null when user declines", async () => {
      const server = createMockMcpServer({
        supportsElicitation: true,
        elicitResult: { action: "decline" },
      });
      const result = await tryElicitation(server as any, makeOptions());
      expect(result).toBeNull();
    });

    it("returns null when user cancels", async () => {
      const server = createMockMcpServer({
        supportsElicitation: true,
        elicitResult: { action: "cancel" },
      });
      const result = await tryElicitation(server as any, makeOptions());
      expect(result).toBeNull();
    });

    it("sends oneOf enum schema with all models", async () => {
      const server = createMockMcpServer({
        supportsElicitation: true,
        elicitResult: { action: "accept", content: { model: "claude" } },
      });
      await tryElicitation(server as any, makeOptions());
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
      await tryElicitation(server as any, makeOptions());
      const call = server.server.elicitInput.mock.calls[0][0];
      expect(call.message).toContain("7680x4032");
    });

    it("propagates errors from elicitInput", async () => {
      const server = createMockMcpServer({ supportsElicitation: true });
      server.server.elicitInput.mockRejectedValue(new Error("Transport closed"));
      await expect(
        tryElicitation(server as any, makeOptions())
      ).rejects.toThrow("Transport closed");
    });

    it("falls back to options.model when user accepts without selecting a model", async () => {
      const server = createMockMcpServer({
        supportsElicitation: true,
        elicitResult: { action: "accept", content: {} },
      });
      const result = await tryElicitation(server as any, makeOptions({ model: "openai" }));
      expect(result).toBe("openai");
    });

    it("falls back to options.model directly when user accepts without selecting", async () => {
      const server = createMockMcpServer({
        supportsElicitation: true,
        elicitResult: { action: "accept", content: {} },
      });
      const result = await tryElicitation(server as any, makeOptions({ model: "gemini3" }));
      expect(result).toBe("gemini3"); // returns the provided default directly
    });
  });
});
