import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerResources } from "../resources/index.js";
import { VISION_MODELS, MODEL_CONFIGS } from "../constants.js";

interface CapturedResource {
  name: string;
  uri: string;
  config: Record<string, unknown>;
  handler: (uri: { href: string }) => unknown;
}

function createMockServer() {
  const resources: CapturedResource[] = [];
  const server = {
    registerResource: vi.fn(
      (
        name: string,
        uri: string,
        config: Record<string, unknown>,
        handler: (uri: { href: string }) => unknown
      ) => {
        resources.push({ name, uri, config, handler });
      }
    ),
  };
  return {
    server,
    getResources: () => resources,
    getResource: (name: string) => resources.find((r) => r.name === name),
  };
}

describe("registerResources", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    mock = createMockServer();
    registerResources(mock.server as any);
  });

  it("registers exactly two resources", () => {
    expect(mock.server.registerResource).toHaveBeenCalledTimes(2);
    expect(mock.getResources().map((r) => r.uri)).toEqual(["tiler://models", "tiler://guide"]);
  });

  describe("model-configs resource", () => {
    it("has URI tiler://models and mimeType application/json", () => {
      const r = mock.getResource("model-configs");
      expect(r).toBeDefined();
      expect(r!.uri).toBe("tiler://models");
      expect((r!.config as any).mimeType).toBe("application/json");
    });

    it("returns valid JSON with all four model keys", () => {
      const r = mock.getResource("model-configs")!;
      const result = r.handler({ href: "tiler://models" }) as any;
      expect(result.contents).toHaveLength(1);

      const parsed = JSON.parse(result.contents[0].text);
      expect(Object.keys(parsed)).toEqual(expect.arrayContaining([...VISION_MODELS]));
    });

    it("each model entry has required fields", () => {
      const r = mock.getResource("model-configs")!;
      const result = r.handler({ href: "tiler://models" }) as any;
      const parsed = JSON.parse(result.contents[0].text);
      for (const model of VISION_MODELS) {
        const entry = parsed[model];
        expect(entry).toHaveProperty("label");
        expect(entry).toHaveProperty("defaultTileSize");
        expect(entry).toHaveProperty("minTileSize");
        expect(entry).toHaveProperty("maxTileSize");
        expect(entry).toHaveProperty("tokensPerTile");
      }
    });
  });

  describe("usage-guide resource", () => {
    it("has URI tiler://guide and mimeType text/plain", () => {
      const r = mock.getResource("usage-guide");
      expect(r).toBeDefined();
      expect(r!.uri).toBe("tiler://guide");
      expect((r!.config as any).mimeType).toBe("text/plain");
    });

    it("returns non-empty text content", () => {
      const r = mock.getResource("usage-guide")!;
      const result = r.handler({ href: "tiler://guide" }) as any;
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe("text/plain");
      expect(result.contents[0].text.length).toBeGreaterThan(0);
    });

    it("includes workflow steps and preset names in the guide text", () => {
      const r = mock.getResource("usage-guide")!;
      const result = r.handler({ href: "tiler://guide" }) as any;
      const text: string = result.contents[0].text;
      expect(text).toContain("WORKFLOW");
      expect(text).toContain("claude");
      expect(text).toContain("openai");
      expect(text).toContain("gemini3");
    });

    it("PRESETS section reflects MODEL_CONFIGS values", () => {
      const r = mock.getResource("usage-guide")!;
      const result = r.handler({ href: "tiler://guide" }) as any;
      const text: string = result.contents[0].text;
      for (const model of VISION_MODELS) {
        const c = MODEL_CONFIGS[model];
        expect(text).toContain(`${c.defaultTileSize}px tiles`);
        expect(text).toContain(`~${c.tokensPerTile} tokens/tile`);
      }
    });
  });
});
