import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

const BIN = "node";
const ENTRY = "dist/index.js";

function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(BIN, [ENTRY, ...args], { timeout: 5000 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.toString().trim(),
        stderr: stderr.toString().trim(),
        code: error ? error.code ?? child.exitCode : 0,
      });
    });
  });
}

describe("CLI flags", () => {
  it("--version prints version and exits with code 0", async () => {
    const result = await run(["--version"]);
    expect(result.stdout).toBe(version);
    expect(result.code).toBe(0);
  });

  it("-v prints version and exits with code 0", async () => {
    const result = await run(["-v"]);
    expect(result.stdout).toBe(version);
    expect(result.code).toBe(0);
  });

  it("--help prints usage and exits with code 0", async () => {
    const result = await run(["--help"]);
    expect(result.stdout).toContain("image-tiler-mcp-server");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--version");
    expect(result.stdout).toContain("--help");
    expect(result.code).toBe(0);
  });

  it("-h prints usage and exits with code 0", async () => {
    const result = await run(["-h"]);
    expect(result.stdout).toContain("image-tiler-mcp-server");
    expect(result.stdout).toContain("Usage:");
    expect(result.code).toBe(0);
  });

  it("no flags starts the server (prints stdio message to stderr)", async () => {
    const result = await new Promise<{ stderr: string; code: number | null }>((resolve) => {
      const child = execFile(BIN, [ENTRY], { timeout: 2000 }, (_error, _stdout, stderr) => {
        resolve({
          stderr: stderr.toString().trim(),
          code: child.exitCode,
        });
      });

      // Give the server time to start, then kill it
      setTimeout(() => child.kill("SIGTERM"), 500);
    });

    expect(result.stderr).toContain("running on stdio");
  });
});
