import { vi } from "vitest";

export interface CapturedTool {
  name: string;
  config: Record<string, unknown>;
  handler: (...args: unknown[]) => Promise<unknown>;
}

export function createMockServer() {
  const tools: CapturedTool[] = [];

  const server = {
    registerTool: vi.fn(
      (name: string, config: Record<string, unknown>, handler: (...args: unknown[]) => Promise<unknown>) => {
        tools.push({ name, config, handler });
      }
    ),
  };

  return {
    server,
    getTools: () => tools,
    getTool: (name: string) => tools.find((t) => t.name === name),
  };
}
