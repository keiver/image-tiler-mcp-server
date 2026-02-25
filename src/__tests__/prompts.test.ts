import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerPrompts } from "../prompts/index.js";
import { VISION_MODELS } from "../constants.js";

interface CapturedPrompt {
  name: string;
  config: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown;
}

function createMockServer() {
  const prompts: CapturedPrompt[] = [];
  const server = {
    registerPrompt: vi.fn(
      (name: string, config: Record<string, unknown>, handler: (args: Record<string, unknown>) => unknown) => {
        prompts.push({ name, config, handler });
      }
    ),
  };
  return {
    server,
    getPrompts: () => prompts,
    getPrompt: (name: string) => prompts.find((p) => p.name === name),
  };
}

describe("registerPrompts", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    mock = createMockServer();
    registerPrompts(mock.server as any);
  });

  it("registers exactly two prompts", () => {
    expect(mock.server.registerPrompt).toHaveBeenCalledTimes(2);
    expect(mock.getPrompts().map((p) => p.name)).toEqual(["tile-and-analyze", "capture-and-analyze"]);
  });

  describe("tile-and-analyze prompt", () => {
    it("has the expected name and title", () => {
      const p = mock.getPrompt("tile-and-analyze");
      expect(p).toBeDefined();
      expect((p!.config as any).title).toBe("Tile and Analyze Image");
    });

    it("returns a user message with tiler tool instructions", () => {
      const p = mock.getPrompt("tile-and-analyze")!;
      const result = p.handler({ filePath: "/tmp/photo.png" }) as any;
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content.type).toBe("text");
      expect(result.messages[0].content.text).toContain("/tmp/photo.png");
      expect(result.messages[0].content.text).toContain("tiler");
    });

    it("includes preset in message when provided", () => {
      const p = mock.getPrompt("tile-and-analyze")!;
      const result = p.handler({ filePath: "/tmp/photo.png", preset: "openai" }) as any;
      expect(result.messages[0].content.text).toContain('preset="openai"');
    });

    it("includes focus text when provided", () => {
      const p = mock.getPrompt("tile-and-analyze")!;
      const result = p.handler({ filePath: "/tmp/photo.png", focus: "UI layout" }) as any;
      expect(result.messages[0].content.text).toContain("UI layout");
    });

    it("omits focus note when focus not provided", () => {
      const p = mock.getPrompt("tile-and-analyze")!;
      const result = p.handler({ filePath: "/tmp/photo.png" }) as any;
      expect(result.messages[0].content.text).not.toContain("Focus specifically on");
    });

    it("preset argsSchema accepts all VISION_MODELS values", () => {
      const p = mock.getPrompt("tile-and-analyze")!;
      const schema = (p!.config as any).argsSchema;
      const presetSchema = schema.preset._def.innerType; // unwrap .optional()
      const validValues: string[] = presetSchema._def.values;
      expect(validValues).toEqual(expect.arrayContaining([...VISION_MODELS]));
      expect(validValues).toHaveLength(VISION_MODELS.length);
    });
  });

  describe("capture-and-analyze prompt", () => {
    it("has the expected name and title", () => {
      const p = mock.getPrompt("capture-and-analyze");
      expect(p).toBeDefined();
      expect((p!.config as any).title).toBe("Capture and Analyze Web Page");
    });

    it("returns a user message with the URL and tiler instructions", () => {
      const p = mock.getPrompt("capture-and-analyze")!;
      const result = p.handler({ url: "https://example.com" }) as any;
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content.type).toBe("text");
      expect(result.messages[0].content.text).toContain("https://example.com");
      expect(result.messages[0].content.text).toContain("tiler");
    });

    it("includes focus text when provided", () => {
      const p = mock.getPrompt("capture-and-analyze")!;
      const result = p.handler({ url: "https://example.com", focus: "accessibility" }) as any;
      expect(result.messages[0].content.text).toContain("accessibility");
    });

    it("omits focus note when focus not provided", () => {
      const p = mock.getPrompt("capture-and-analyze")!;
      const result = p.handler({ url: "https://example.com" }) as any;
      expect(result.messages[0].content.text).not.toContain("Focus specifically on");
    });
  });
});
