import { describe, it, expect, vi } from "vitest";
import { confirmTiling } from "../services/elicitation.js";

function createMockMcpServer(opts: {
  supportsElicitation?: boolean;
  elicitResult?: { action: "accept" | "decline" | "cancel" };
  capsUndefined?: boolean;
}) {
  const elicitInput = vi.fn().mockResolvedValue(opts.elicitResult ?? { action: "accept" });
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
  it("returns confirmed when client supports elicitation and user accepts", async () => {
    const server = createMockMcpServer({ supportsElicitation: true, elicitResult: { action: "accept" } });
    const result = await confirmTiling(server as any, 7680, 4032, "claude", 8, 4, 32, 50880);
    expect(result).toEqual({ confirmed: true });
    expect(server.server.elicitInput).toHaveBeenCalledTimes(1);
  });

  it("returns not confirmed when client supports elicitation and user declines", async () => {
    const server = createMockMcpServer({ supportsElicitation: true, elicitResult: { action: "decline" } });
    const result = await confirmTiling(server as any, 7680, 4032, "claude", 8, 4, 32, 50880);
    expect(result).toEqual({ confirmed: false });
  });

  it("returns not confirmed when client supports elicitation and user cancels", async () => {
    const server = createMockMcpServer({ supportsElicitation: true, elicitResult: { action: "cancel" } });
    const result = await confirmTiling(server as any, 7680, 4032, "claude", 8, 4, 32, 50880);
    expect(result).toEqual({ confirmed: false });
  });

  it("returns confirmed when client does not support elicitation", async () => {
    const server = createMockMcpServer({ supportsElicitation: false });
    const result = await confirmTiling(server as any, 7680, 4032, "claude", 8, 4, 32, 50880);
    expect(result).toEqual({ confirmed: true });
    expect(server.server.elicitInput).not.toHaveBeenCalled();
  });

  it("returns confirmed when client capabilities are undefined", async () => {
    const server = createMockMcpServer({ capsUndefined: true });
    const result = await confirmTiling(server as any, 7680, 4032, "claude", 8, 4, 32, 50880);
    expect(result).toEqual({ confirmed: true });
    expect(server.server.elicitInput).not.toHaveBeenCalled();
  });

  it("includes model label and dimensions in elicitation message", async () => {
    const server = createMockMcpServer({ supportsElicitation: true, elicitResult: { action: "accept" } });
    await confirmTiling(server as any, 7680, 4032, "claude", 8, 4, 32, 50880);
    const call = server.server.elicitInput.mock.calls[0][0];
    expect(call.message).toContain("7680x4032");
    expect(call.message).toContain("Claude");
    expect(call.message).toContain("8x4");
    expect(call.message).toContain("32 tiles");
    expect(call.message).toContain("50,880 tokens");
  });

  it("uses model key as label fallback for unknown models", async () => {
    const server = createMockMcpServer({ supportsElicitation: true, elicitResult: { action: "accept" } });
    await confirmTiling(server as any, 1000, 1000, "unknown_model" as any, 1, 1, 1, 1000);
    const call = server.server.elicitInput.mock.calls[0][0];
    expect(call.message).toContain("unknown_model");
  });

  it("propagates errors from elicitInput", async () => {
    const server = createMockMcpServer({ supportsElicitation: true });
    server.server.elicitInput.mockRejectedValue(new Error("Transport closed"));
    await expect(
      confirmTiling(server as any, 1000, 1000, "claude", 1, 1, 1, 1590)
    ).rejects.toThrow("Transport closed");
  });

  it("sends boolean confirm field in requestedSchema", async () => {
    const server = createMockMcpServer({ supportsElicitation: true, elicitResult: { action: "accept" } });
    await confirmTiling(server as any, 1000, 1000, "claude", 1, 1, 1, 1590);
    const call = server.server.elicitInput.mock.calls[0][0];
    expect(call.requestedSchema.properties.confirm.type).toBe("boolean");
    expect(call.requestedSchema.properties.confirm.title).toBe("Proceed with tiling?");
  });
});
