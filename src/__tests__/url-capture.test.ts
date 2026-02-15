import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// ─── Mocks ─────────────────────────────────────────────────────────

const { mockSpawn, mockExecFileSync, mockExecSync, mockAccessSync, mockWsInstance, mockWsConstructor, mockSharp, mockHttpGet } = vi.hoisted(() => {
  // Must require EventEmitter inside vi.hoisted since imports aren't available yet
  const { EventEmitter: EE } = require("node:events");

  const mockSpawn = vi.fn();
  const mockExecFileSync = vi.fn();
  const mockExecSync = vi.fn();
  const mockAccessSync = vi.fn();

  // WebSocket mock
  const mockWsInstance = Object.assign(new EE(), {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1, // OPEN
    removeListener: vi.fn(),
  });
  const mockWsConstructor = vi.fn().mockImplementation(function () {
    // Emit "open" asynchronously so the connection promise resolves
    setTimeout(() => mockWsInstance.emit("open"), 0);
    return mockWsInstance;
  });
  (mockWsConstructor as any).OPEN = 1;

  // Sharp mock for stitching
  const mockToBuffer = vi.fn().mockResolvedValue(Buffer.from("stitched-png"));
  const mockPng = vi.fn().mockReturnValue({ toBuffer: mockToBuffer });
  const mockComposite = vi.fn().mockReturnValue({ png: mockPng });
  const mockSharpInstance = { composite: mockComposite, png: mockPng, toBuffer: mockToBuffer };
  const mockSharp = Object.assign(
    vi.fn().mockReturnValue(mockSharpInstance),
    { cache: vi.fn(), concurrency: vi.fn() }
  );

  // HTTP mock for page target discovery (/json endpoint)
  const mockHttpGet = vi.fn();

  return { mockSpawn, mockExecFileSync, mockExecSync, mockAccessSync, mockWsInstance, mockWsConstructor, mockSharp, mockHttpGet };
});

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
  execFileSync: mockExecFileSync,
  execSync: mockExecSync,
}));

vi.mock("node:fs", () => ({
  accessSync: mockAccessSync,
  constants: { F_OK: 0 },
}));

vi.mock("ws", () => ({ default: mockWsConstructor }));
vi.mock("sharp", () => ({ default: mockSharp }));
vi.mock("node:http", () => ({
  default: {
    get: mockHttpGet,
  },
}));

import { findChromePath, captureUrl, detectDisplayWidth } from "../services/url-capture.js";
import { MAX_CAPTURE_HEIGHT, CHROME_MAX_CAPTURE_HEIGHT } from "../constants.js";

// ─── Chrome Detection ──────────────────────────────────────────────

describe("findChromePath", () => {
  const originalEnv = process.env.CHROME_PATH;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CHROME_PATH = originalEnv;
    } else {
      delete process.env.CHROME_PATH;
    }
    vi.clearAllMocks();
  });

  it("returns CHROME_PATH env var when set to absolute path", () => {
    process.env.CHROME_PATH = "/custom/chrome";
    expect(findChromePath()).toBe("/custom/chrome");
  });

  it("rejects relative CHROME_PATH", () => {
    process.env.CHROME_PATH = "relative/chrome";
    expect(() => findChromePath()).toThrow("CHROME_PATH must be an absolute path");
  });

  it("rejects CHROME_PATH with just a filename", () => {
    process.env.CHROME_PATH = "chrome";
    expect(() => findChromePath()).toThrow("CHROME_PATH must be an absolute path");
  });

  it("throws when Chrome not found", () => {
    delete process.env.CHROME_PATH;
    mockAccessSync.mockImplementation(() => {
      throw new Error("not found");
    });
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(() => findChromePath()).toThrow("Chrome not found");
  });
});

// ─── captureUrl ────────────────────────────────────────────────────

describe("captureUrl", () => {
  let chromeProcess: EventEmitter & Partial<ChildProcess>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set CHROME_PATH to avoid detection logic
    process.env.CHROME_PATH = "/usr/bin/chrome";

    // Create mock Chrome process
    const stderr = new EventEmitter();
    chromeProcess = Object.assign(new EventEmitter(), {
      stderr,
      stdout: new EventEmitter(),
      stdin: null,
      stdio: [null, null, stderr],
      killed: false,
      kill: vi.fn().mockImplementation(function (this: any) {
        this.killed = true;
      }),
      pid: 12345,
    });

    mockSpawn.mockReturnValue(chromeProcess);

    // Mock HTTP /json endpoint for page target discovery
    mockHttpGet.mockImplementation((_url: string, cb: (res: EventEmitter) => void) => {
      const res = new EventEmitter();
      setTimeout(() => {
        const body = JSON.stringify([
          { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" },
        ]);
        cb(res);
        res.emit("data", Buffer.from(body));
        res.emit("end");
      }, 0);
      const req = new EventEmitter();
      return req;
    });

    // Make WebSocket emit CDP responses
    mockWsInstance.removeListener = vi.fn((event, fn) => {
      mockWsInstance.off(event, fn);
      return mockWsInstance;
    });
    // Reset event listeners
    mockWsInstance.removeAllListeners();
    mockWsInstance.readyState = 1;
  });

  afterEach(() => {
    delete process.env.CHROME_PATH;
  });

  function emitDevToolsUrl() {
    // Simulate Chrome emitting the DevTools URL
    (chromeProcess.stderr as EventEmitter).emit(
      "data",
      Buffer.from("DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc\n")
    );
  }

  function respondToCdp(id: number, result: Record<string, unknown>) {
    mockWsInstance.emit("message", JSON.stringify({ id, result }));
  }

  function respondToCdpEvent(method: string, params?: Record<string, unknown>) {
    mockWsInstance.emit("message", JSON.stringify({ method, params }));
  }

  /**
   * Sets up the WebSocket mock to auto-respond to CDP commands.
   * @param pageWidth - Reported page width
   * @param pageHeight - Reported page height
   */
  function setupCdpAutoResponder(pageWidth: number, pageHeight: number) {
    mockWsInstance.send = vi.fn((data: string) => {
      const msg = JSON.parse(data);
      const id = msg.id;
      setTimeout(() => {
        if (msg.method === "Page.navigate") {
          respondToCdp(id, {});
          respondToCdpEvent("Page.loadEventFired");
        } else if (msg.method === "Page.getLayoutMetrics") {
          respondToCdp(id, {
            cssContentSize: { width: pageWidth, height: pageHeight },
          });
        } else if (msg.method === "Page.captureScreenshot") {
          respondToCdp(id, { data: Buffer.from("screenshot-data").toString("base64") });
        } else if (msg.method === "Runtime.evaluate") {
          respondToCdp(id, { result: { value: undefined } });
        } else {
          respondToCdp(id, {});
        }
      }, 0);
    });
  }

  it("rejects invalid URLs", async () => {
    await expect(captureUrl({ url: "not-a-url" })).rejects.toThrow("Invalid URL");
  });

  it("rejects unsupported protocols", async () => {
    await expect(captureUrl({ url: "ftp://example.com" })).rejects.toThrow("Unsupported protocol");
  });

  it("accepts http URLs", async () => {
    setupCdpAutoResponder(1280, 800);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "http://localhost:3000" });
    expect(result.url).toBe("http://localhost:3000");
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.pageWidth).toBe(1280);
    expect(result.pageHeight).toBe(800);
  });

  it("kills Chrome on error", async () => {
    // Spawn Chrome, but have it exit immediately
    setTimeout(() => {
      chromeProcess.emit("exit", 1);
    }, 0);

    await expect(captureUrl({ url: "https://example.com" })).rejects.toThrow();
    // Chrome.kill should have been called (or chrome exited)
  });

  // ─── Scroll-Stitch Tests ────────────────────────────────────────

  it("single capture for page at exactly 16,384px (no stitching)", async () => {
    setupCdpAutoResponder(1280, CHROME_MAX_CAPTURE_HEIGHT);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com" });
    expect(result.pageHeight).toBe(CHROME_MAX_CAPTURE_HEIGHT);
    expect(result.segmentsStitched).toBeUndefined();
    expect(result.buffer).toBeInstanceOf(Buffer);
  });

  it("scroll-stitches page at 16,385px (minimal 2-segment stitch)", async () => {
    const tallHeight = CHROME_MAX_CAPTURE_HEIGHT + 1; // 16,385
    setupCdpAutoResponder(1280, tallHeight);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com" });
    expect(result.pageHeight).toBe(tallHeight);
    expect(result.segmentsStitched).toBe(2);
    // Sharp should have been called to create the composite canvas
    expect(mockSharp).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        width: 1280,
        height: tallHeight,
      }),
    }));
  });

  it("scroll-stitches page with multiple segments", async () => {
    const tallHeight = CHROME_MAX_CAPTURE_HEIGHT * 3 + 100; // 3 full + 1 partial = 4 segments
    setupCdpAutoResponder(1280, tallHeight);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com" });
    expect(result.pageHeight).toBe(tallHeight);
    expect(result.segmentsStitched).toBe(4);
  });

  // ─── MAX_CAPTURE_HEIGHT Guard ───────────────────────────────────

  it("rejects pages exceeding MAX_CAPTURE_HEIGHT", async () => {
    const absurdHeight = MAX_CAPTURE_HEIGHT + 1;
    setupCdpAutoResponder(1280, absurdHeight);
    setTimeout(emitDevToolsUrl, 0);

    await expect(captureUrl({ url: "https://example.com" })).rejects.toThrow(
      `Page height ${absurdHeight}px exceeds maximum ${MAX_CAPTURE_HEIGHT}px`
    );
  });

  it("accepts pages at exactly MAX_CAPTURE_HEIGHT", async () => {
    setupCdpAutoResponder(1280, MAX_CAPTURE_HEIGHT);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com" });
    expect(result.pageHeight).toBe(MAX_CAPTURE_HEIGHT);
    // Should stitch (200,000 > 16,384)
    expect(result.segmentsStitched).toBeGreaterThan(1);
  });
});

// ─── detectDisplayWidth ─────────────────────────────────────────────

describe("detectDisplayWidth", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.clearAllMocks();
  });

  it("returns undefined on non-darwin platforms", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(detectDisplayWidth()).toBeUndefined();
  });

  it("parses main display width from system_profiler JSON", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const spOutput = JSON.stringify({
      SPDisplaysDataType: [{
        spdisplays_ndrvs: [{
          spdisplays_main: "spdisplays_yes",
          _spdisplays_resolution: "1512 x 982 @ 120.00Hz",
        }],
      }],
    });
    mockExecSync.mockReturnValue(spOutput);
    expect(detectDisplayWidth()).toBe(1512);
  });

  it("returns undefined when system_profiler throws", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExecSync.mockImplementation(() => { throw new Error("command failed"); });
    expect(detectDisplayWidth()).toBeUndefined();
  });

  it("returns undefined when no main display found", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const spOutput = JSON.stringify({
      SPDisplaysDataType: [{
        spdisplays_ndrvs: [{
          spdisplays_main: "spdisplays_no",
          _spdisplays_resolution: "1512 x 982 @ 120.00Hz",
        }],
      }],
    });
    mockExecSync.mockReturnValue(spOutput);
    expect(detectDisplayWidth()).toBeUndefined();
  });
});
