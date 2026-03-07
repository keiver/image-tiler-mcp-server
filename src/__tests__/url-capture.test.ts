import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// ─── Mocks ─────────────────────────────────────────────────────────

const { mockSpawn, mockExecFileSync, mockAccessSync, mockWsInstance, mockWsConstructor, mockSharp, mockHttpGet, mockIsUrlCaptureDisabled } = vi.hoisted(() => {
  // Must require EventEmitter inside vi.hoisted since imports aren't available yet
  const { EventEmitter: EE } = require("node:events");

  const mockSpawn = vi.fn();
  const mockExecFileSync = vi.fn();
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

  const mockIsUrlCaptureDisabled = vi.fn().mockReturnValue(false);

  return { mockSpawn, mockExecFileSync, mockAccessSync, mockWsInstance, mockWsConstructor, mockSharp, mockHttpGet, mockIsUrlCaptureDisabled };
});

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
  execFileSync: mockExecFileSync,
}));

vi.mock("node:fs", () => ({
  accessSync: mockAccessSync,
  constants: { F_OK: 0, X_OK: 1 },
}));

vi.mock("ws", () => ({ default: mockWsConstructor }));
vi.mock("sharp", () => ({ default: mockSharp }));
vi.mock("../security.js", () => ({
  isUrlCaptureDisabled: mockIsUrlCaptureDisabled,
}));
vi.mock("node:http", () => ({
  default: {
    get: mockHttpGet,
  },
}));

import { findChromePath, captureUrl } from "../services/url-capture.js";
import { MAX_CAPTURE_HEIGHT, CHROME_MAX_CAPTURE_HEIGHT, MAX_CHROME_STDERR_BYTES, CAPTURE_DEFAULT_VIEWPORT_WIDTH, CAPTURE_DEFAULT_VIEWPORT_HEIGHT, DEFAULT_MOBILE_USER_AGENT, CAPTURE_MOBILE_VIEWPORT_WIDTH, CAPTURE_MOBILE_DEVICE_SCALE_FACTOR } from "../constants.js";

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

  it("rejects CHROME_PATH pointing to non-existent file", () => {
    process.env.CHROME_PATH = "/nonexistent/chrome";
    mockAccessSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(() => findChromePath()).toThrow("non-existent or non-executable");
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

    // Set CHROME_PATH to avoid detection logic + satisfy accessSync check
    process.env.CHROME_PATH = "/usr/bin/chrome";
    mockAccessSync.mockImplementation(() => {});

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
    }) as unknown as EventEmitter & Partial<ChildProcess>;

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
    delete process.env.CHROME_NO_SANDBOX;
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
          const expr = msg.params?.expression as string ?? "";
          if (expr.includes("scrollHeight")) {
            respondToCdp(id, { result: { value: pageHeight } });
          } else {
            respondToCdp(id, { result: { value: undefined } });
          }
        } else {
          respondToCdp(id, {});
        }
      }, 0);
    });
  }

  function getSentCdpCommands() {
    return mockWsInstance.send.mock.calls.map(
      (call: [string]) => JSON.parse(call[0]) as { method: string; params?: Record<string, unknown> }
    );
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

    const result = await captureUrl({ url: "http://localhost:3000", delay: 0 });
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

    await expect(captureUrl({ url: "https://example.com", delay: 0 })).rejects.toThrow(
      "Chrome exited unexpectedly with code 1"
    );
  });

  it("includes stderr tail in Chrome exit error", async () => {
    setTimeout(() => {
      (chromeProcess.stderr as EventEmitter).emit(
        "data",
        Buffer.from("Failed to launch Chrome: no usable sandbox\n")
      );
      chromeProcess.emit("exit", 1);
    }, 0);

    await expect(captureUrl({ url: "https://example.com", delay: 0 })).rejects.toThrow(
      /Chrome exited unexpectedly with code 1\nFailed to launch Chrome: no usable sandbox/
    );
  });

  // ─── Chrome Hang / Timeout Tests ────────────────────────────────

  it("times out when Chrome never emits DevTools URL", async () => {
    // Chrome spawns but never writes to stderr — no DevTools URL appears
    // The startup timer (capped to the capture timeout) should fire
    await expect(
      captureUrl({ url: "https://example.com", timeout: 5_000 })
    ).rejects.toThrow("Timed out waiting for Chrome DevTools WebSocket URL");
  }, 10_000);

  // ─── Scroll-Stitch Tests ────────────────────────────────────────

  it("single capture for page at exactly 16,384px (no stitching)", async () => {
    setupCdpAutoResponder(1280, CHROME_MAX_CAPTURE_HEIGHT);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com", delay: 0 });
    expect(result.pageHeight).toBe(CHROME_MAX_CAPTURE_HEIGHT);
    expect(result.segmentsStitched).toBeUndefined();
    expect(result.buffer).toBeInstanceOf(Buffer);
  });

  it("scroll-stitches page at 16,385px (minimal 2-segment stitch)", async () => {
    const tallHeight = CHROME_MAX_CAPTURE_HEIGHT + 1; // 16,385
    setupCdpAutoResponder(1280, tallHeight);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com", delay: 0 });
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

    const result = await captureUrl({ url: "https://example.com", delay: 0 });
    expect(result.pageHeight).toBe(tallHeight);
    expect(result.segmentsStitched).toBe(4);
  });

  // ─── MAX_CAPTURE_HEIGHT Guard ───────────────────────────────────

  it("rejects pages exceeding MAX_CAPTURE_HEIGHT", async () => {
    const absurdHeight = MAX_CAPTURE_HEIGHT + 1;
    setupCdpAutoResponder(1280, absurdHeight);
    setTimeout(emitDevToolsUrl, 0);

    await expect(captureUrl({ url: "https://example.com", delay: 0 })).rejects.toThrow(
      `Page height ${absurdHeight}px exceeds maximum ${MAX_CAPTURE_HEIGHT}px`
    );
  });

  it("accepts pages at exactly MAX_CAPTURE_HEIGHT", async () => {
    setupCdpAutoResponder(1280, MAX_CAPTURE_HEIGHT);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com", delay: 0 });
    expect(result.pageHeight).toBe(MAX_CAPTURE_HEIGHT);
    // Should stitch (200,000 > 16,384)
    expect(result.segmentsStitched).toBeGreaterThan(1);
  }, 15_000);

  // ─── Buffer Cap Tests ────────────────────────────────────────────

  it("caps stderr buffer at MAX_CHROME_STDERR_BYTES", async () => {
    // Emit a large amount of stderr data WITHOUT the DevTools URL
    // The buffer should stop growing once it hits the cap
    const bigChunk = Buffer.alloc(MAX_CHROME_STDERR_BYTES + 100_000, 0x41); // 'A' bytes, over limit

    // Track what the internal buffer would look like by intercepting stderr events
    let stderrEmitted = 0;
    const origOn = chromeProcess.stderr!.on;
    (chromeProcess.stderr as any).on = function (event: string, handler: (...args: any[]) => void) {
      if (event === "data") {
        const wrappedHandler = (chunk: Buffer) => {
          stderrEmitted += chunk.length;
          handler(chunk);
        };
        return origOn.call(this, event, wrappedHandler);
      }
      return origOn.call(this, event, handler);
    };

    // This should time out since no DevTools URL is emitted
    const promise = captureUrl({ url: "https://example.com", timeout: 5_000 });

    // Emit the big chunk
    setTimeout(() => {
      (chromeProcess.stderr as EventEmitter).emit("data", bigChunk);
    }, 50);

    await expect(promise).rejects.toThrow("Timed out waiting for Chrome DevTools WebSocket URL");
    // The important thing is it didn't crash or OOM from unbounded buffer growth
  }, 10_000);

  // ─── Chrome Error Page Detection ──────────────────────────────────

  it("detects chrome-error:// page and throws descriptive error", async () => {
    mockWsInstance.send = vi.fn((data: string) => {
      const msg = JSON.parse(data);
      const id = msg.id;
      setTimeout(() => {
        if (msg.method === "Page.navigate") {
          respondToCdp(id, {});
          respondToCdpEvent("Page.loadEventFired");
        } else if (msg.method === "Runtime.evaluate") {
          if (msg.params?.expression === "document.location.href") {
            respondToCdp(id, { result: { value: "chrome-error://chromewebdata/" } });
          } else if (msg.params?.expression?.includes("innerText")) {
            respondToCdp(id, { result: { value: "This site can't be reached\nDNS_PROBE_FINISHED_NXDOMAIN" } });
          } else {
            respondToCdp(id, { result: { value: undefined } });
          }
        } else {
          respondToCdp(id, {});
        }
      }, 0);
    });
    setTimeout(emitDevToolsUrl, 0);

    await expect(captureUrl({ url: "https://nonexistent.invalid", delay: 0 })).rejects.toThrow(
      /Chrome navigated to an error page.*This site can't be reached/
    );
  });

  it("handles chrome-error:// with no body text", async () => {
    mockWsInstance.send = vi.fn((data: string) => {
      const msg = JSON.parse(data);
      const id = msg.id;
      setTimeout(() => {
        if (msg.method === "Page.navigate") {
          respondToCdp(id, {});
          respondToCdpEvent("Page.loadEventFired");
        } else if (msg.method === "Runtime.evaluate") {
          if (msg.params?.expression === "document.location.href") {
            respondToCdp(id, { result: { value: "chrome-error://chromewebdata/" } });
          } else {
            respondToCdp(id, { result: { value: "" } });
          }
        } else {
          respondToCdp(id, {});
        }
      }, 0);
    });
    setTimeout(emitDevToolsUrl, 0);

    await expect(captureUrl({ url: "https://broken.test", delay: 0 })).rejects.toThrow(
      /Chrome navigated to an error page/
    );
  });

  // ─── Lazy Loading Tests ──────────────────────────────────────────

  it("triggers lazy loading via Runtime.evaluate before capture", async () => {
    setupCdpAutoResponder(1280, 800);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", delay: 0 });

    // Collect all CDP commands sent
    const sentCommands = getSentCdpCommands();

    // Find the Runtime.evaluate call with the lazy loading script
    const lazyLoadCall = sentCommands.find(
      (cmd: { method: string; params?: Record<string, unknown> }) =>
        cmd.method === "Runtime.evaluate" &&
        cmd.params?.awaitPromise === true &&
        typeof cmd.params?.expression === "string" &&
        (cmd.params.expression as string).includes('loading="lazy"') &&
        (cmd.params.expression as string).includes("scrollTo")
    );
    expect(lazyLoadCall).toBeDefined();

    // Verify it converts lazy → eager
    expect(lazyLoadCall!.params!.expression).toContain('img.loading = \'eager\'');

    // Verify it scrolls back to top
    expect(lazyLoadCall!.params!.expression).toContain("scrollTo(0, 0)");
  });

  it("calls lazy loading before error page check and before capture", async () => {
    const commandOrder: string[] = [];

    mockWsInstance.send = vi.fn((data: string) => {
      const msg = JSON.parse(data);
      const id = msg.id;

      // Track relevant command order
      if (msg.method === "Runtime.evaluate") {
        const expr = msg.params?.expression as string ?? "";
        if (expr.includes('loading="lazy"')) {
          commandOrder.push("lazy-load");
        } else if (expr === "document.location.href") {
          commandOrder.push("error-check");
        }
      } else if (msg.method === "Page.captureScreenshot") {
        commandOrder.push("capture");
      }

      setTimeout(() => {
        if (msg.method === "Page.navigate") {
          respondToCdp(id, {});
          respondToCdpEvent("Page.loadEventFired");
        } else if (msg.method === "Page.getLayoutMetrics") {
          respondToCdp(id, {
            cssContentSize: { width: 1280, height: 800 },
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
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", delay: 0 });

    // Lazy loading must come before error check and capture
    expect(commandOrder.indexOf("lazy-load")).toBeLessThan(commandOrder.indexOf("error-check"));
    expect(commandOrder.indexOf("lazy-load")).toBeLessThan(commandOrder.indexOf("capture"));
  });

  it("skips scrolling when no lazy images exist (guard check)", async () => {
    setupCdpAutoResponder(1280, 800);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", delay: 0 });

    // Collect all CDP commands sent
    const sentCommands = getSentCdpCommands();

    // Find the lazy loading Runtime.evaluate call
    const lazyLoadCall = sentCommands.find(
      (cmd: { method: string; params?: Record<string, unknown> }) =>
        cmd.method === "Runtime.evaluate" &&
        cmd.params?.awaitPromise === true &&
        typeof cmd.params?.expression === "string" &&
        (cmd.params.expression as string).includes('img[loading="lazy"]')
    );
    expect(lazyLoadCall).toBeDefined();

    // The script checks lazyImages.length === 0 and returns early
    // So scrollTo should be inside the guard (after the length check)
    const expr = lazyLoadCall!.params!.expression as string;
    const guardIndex = expr.indexOf("if (lazyImages.length === 0) return");
    const scrollIndex = expr.indexOf("scrollTo");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(scrollIndex).toBeGreaterThan(guardIndex);
  });

  // ─── Zero-Dimension Fallback Tests ──────────────────────────────

  it("falls back to viewportWidth when contentSize.width is 0", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setupCdpAutoResponder(0, 800);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com", delay: 0 });
    expect(result.pageWidth).toBe(CAPTURE_DEFAULT_VIEWPORT_WIDTH);
    expect(result.pageHeight).toBe(800);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("content width=0"));
    warnSpy.mockRestore();
  });

  it("falls back to default height when contentSize.height is 0", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setupCdpAutoResponder(1280, 0);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com", delay: 0 });
    expect(result.pageWidth).toBe(1280);
    expect(result.pageHeight).toBe(CAPTURE_DEFAULT_VIEWPORT_HEIGHT);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("content height=0"));
    warnSpy.mockRestore();
  });

  it("falls back to both defaults when both dimensions are 0", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setupCdpAutoResponder(0, 0);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com", delay: 0 });
    expect(result.pageWidth).toBe(CAPTURE_DEFAULT_VIEWPORT_WIDTH);
    expect(result.pageHeight).toBe(CAPTURE_DEFAULT_VIEWPORT_HEIGHT);
    // 3 warnings: settle loop (scrollHeight=0), width fallback, height fallback
    expect(warnSpy).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });

  it("falls back to defaults when dimensions are negative", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setupCdpAutoResponder(-5, -10);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com", delay: 0 });
    expect(result.pageWidth).toBe(CAPTURE_DEFAULT_VIEWPORT_WIDTH);
    expect(result.pageHeight).toBe(CAPTURE_DEFAULT_VIEWPORT_HEIGHT);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("content width=-5"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("content height=-10"));
    warnSpy.mockRestore();
  });

  // ─── Mobile Emulation Tests ──────────────────────────────────────

  it("forwards mobile and deviceScaleFactor in Emulation.setDeviceMetricsOverride", async () => {
    setupCdpAutoResponder(390, 800);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", viewportWidth: 390, mobile: true, deviceScaleFactor: 2, delay: 0 });

    const sentCommands = getSentCdpCommands();
    const metricsOverrides = sentCommands.filter(
      (cmd: { method: string }) => cmd.method === "Emulation.setDeviceMetricsOverride"
    );
    // All setDeviceMetricsOverride calls should use mobile: true and deviceScaleFactor: 2
    expect(metricsOverrides.length).toBeGreaterThanOrEqual(1);
    for (const cmd of metricsOverrides) {
      expect(cmd.params!.mobile).toBe(true);
      expect(cmd.params!.deviceScaleFactor).toBe(2);
    }
  });

  it("calls Emulation.setUserAgentOverride when userAgent is provided", async () => {
    setupCdpAutoResponder(1280, 800);
    setTimeout(emitDevToolsUrl, 0);

    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)";
    await captureUrl({ url: "https://example.com", userAgent: ua, delay: 0 });

    const sentCommands = getSentCdpCommands();
    const uaOverride = sentCommands.find(
      (cmd: { method: string }) => cmd.method === "Emulation.setUserAgentOverride"
    );
    expect(uaOverride).toBeDefined();
    expect(uaOverride!.params!.userAgent).toBe(ua);
  });

  it("does not call Emulation.setUserAgentOverride when userAgent is omitted", async () => {
    setupCdpAutoResponder(1280, 800);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", delay: 0 });

    const sentCommands = getSentCdpCommands();
    const uaOverride = sentCommands.find(
      (cmd: { method: string }) => cmd.method === "Emulation.setUserAgentOverride"
    );
    expect(uaOverride).toBeUndefined();
  });

  it("defaults mobile to false and deviceScaleFactor to 1 when omitted", async () => {
    setupCdpAutoResponder(1280, 800);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", delay: 0 });

    const sentCommands = getSentCdpCommands();
    const metricsOverride = sentCommands.find(
      (cmd: { method: string }) => cmd.method === "Emulation.setDeviceMetricsOverride"
    );
    expect(metricsOverride).toBeDefined();
    expect(metricsOverride!.params!.mobile).toBe(false);
    expect(metricsOverride!.params!.deviceScaleFactor).toBe(1);
  });

  it("defaults to mobile viewport width and 2x scale when mobile is true without explicit overrides", async () => {
    setupCdpAutoResponder(390, 800);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", mobile: true, delay: 0 });

    const sentCommands = getSentCdpCommands();
    const metricsOverrides = sentCommands.filter(
      (cmd: { method: string }) => cmd.method === "Emulation.setDeviceMetricsOverride"
    );
    expect(metricsOverrides.length).toBeGreaterThanOrEqual(1);
    for (const cmd of metricsOverrides) {
      expect(cmd.params!.width).toBe(390);
      expect(cmd.params!.mobile).toBe(true);
      expect(cmd.params!.deviceScaleFactor).toBe(2);
    }
  });

  it("respects explicit viewportWidth even with mobile: true", async () => {
    setupCdpAutoResponder(414, 800);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", mobile: true, viewportWidth: 414, delay: 0 });

    const sentCommands = getSentCdpCommands();
    const metricsOverride = sentCommands.find(
      (cmd: { method: string }) => cmd.method === "Emulation.setDeviceMetricsOverride"
    );
    expect(metricsOverride).toBeDefined();
    expect(metricsOverride!.params!.width).toBe(414);
  });

  it("respects explicit deviceScaleFactor even with mobile: true", async () => {
    setupCdpAutoResponder(390, 800);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", mobile: true, deviceScaleFactor: 3, delay: 0 });

    const sentCommands = getSentCdpCommands();
    const metricsOverrides = sentCommands.filter(
      (cmd: { method: string }) => cmd.method === "Emulation.setDeviceMetricsOverride"
    );
    expect(metricsOverrides.length).toBeGreaterThanOrEqual(1);
    for (const cmd of metricsOverrides) {
      expect(cmd.params!.deviceScaleFactor).toBe(3);
    }
  });

  // ─── Mobile User Agent Tests ─────────────────────────────────────

  it("sets default mobile user agent when mobile is true and userAgent is omitted", async () => {
    setupCdpAutoResponder(390, 800);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", mobile: true, delay: 0 });

    const sentCommands = getSentCdpCommands();
    const uaOverride = sentCommands.find(
      (cmd: { method: string }) => cmd.method === "Emulation.setUserAgentOverride"
    );
    expect(uaOverride).toBeDefined();
    expect(uaOverride!.params!.userAgent).toBe(DEFAULT_MOBILE_USER_AGENT);
  });

  it("uses explicit userAgent over mobile default", async () => {
    setupCdpAutoResponder(390, 800);
    setTimeout(emitDevToolsUrl, 0);

    const customUA = "Custom/1.0";
    await captureUrl({ url: "https://example.com", mobile: true, userAgent: customUA, delay: 0 });

    const sentCommands = getSentCdpCommands();
    const uaOverride = sentCommands.find(
      (cmd: { method: string }) => cmd.method === "Emulation.setUserAgentOverride"
    );
    expect(uaOverride).toBeDefined();
    expect(uaOverride!.params!.userAgent).toBe(customUA);
  });

  it("does not set user agent when mobile is false and userAgent is omitted", async () => {
    setupCdpAutoResponder(1280, 800);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", mobile: false, delay: 0 });

    const sentCommands = getSentCdpCommands();
    const uaOverride = sentCommands.find(
      (cmd: { method: string }) => cmd.method === "Emulation.setUserAgentOverride"
    );
    expect(uaOverride).toBeUndefined();
  });

  // ─── CaptureResult Fields Tests ────────────────────────────────

  it("CaptureResult includes viewportWidth and deviceScaleFactor for desktop defaults", async () => {
    setupCdpAutoResponder(1280, 800);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com", delay: 0 });
    expect(result.viewportWidth).toBe(CAPTURE_DEFAULT_VIEWPORT_WIDTH);
    expect(result.deviceScaleFactor).toBe(1);
  });

  it("CaptureResult includes mobile viewport and DPR when mobile is true", async () => {
    setupCdpAutoResponder(390, 800);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com", mobile: true, delay: 0 });
    expect(result.viewportWidth).toBe(CAPTURE_MOBILE_VIEWPORT_WIDTH);
    expect(result.deviceScaleFactor).toBe(CAPTURE_MOBILE_DEVICE_SCALE_FACTOR);
  });

  it("CaptureResult reflects explicit viewportWidth and deviceScaleFactor", async () => {
    setupCdpAutoResponder(414, 800);
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com", viewportWidth: 414, deviceScaleFactor: 3, delay: 0 });
    expect(result.viewportWidth).toBe(414);
    expect(result.deviceScaleFactor).toBe(3);
  });

  // ─── Stitching DPR Tests ──────────────────────────────────────

  it("passes deviceScaleFactor to stitching clip.scale", async () => {
    const tallHeight = CHROME_MAX_CAPTURE_HEIGHT + 1;
    setupCdpAutoResponder(390, tallHeight);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", mobile: true, delay: 0 });

    const sentCommands = getSentCdpCommands();
    const captureCommands = sentCommands.filter(
      (cmd: { method: string }) => cmd.method === "Page.captureScreenshot"
    );
    expect(captureCommands.length).toBeGreaterThanOrEqual(1);
    for (const cmd of captureCommands) {
      const clip = cmd.params!.clip as { scale: number } | undefined;
      if (clip) {
        expect(clip.scale).toBe(CAPTURE_MOBILE_DEVICE_SCALE_FACTOR);
      }
    }
  });

  it("stitching creates canvas scaled by deviceScaleFactor", async () => {
    const tallHeight = CHROME_MAX_CAPTURE_HEIGHT + 1;
    setupCdpAutoResponder(390, tallHeight);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", mobile: true, delay: 0 });

    // Sharp should have been called with DPR-scaled dimensions
    expect(mockSharp).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        width: 390 * CAPTURE_MOBILE_DEVICE_SCALE_FACTOR,
        height: tallHeight * CAPTURE_MOBILE_DEVICE_SCALE_FACTOR,
      }),
    }));
  });

  // ─── DOM scrollHeight Cross-Check Tests ─────────────────────────

  it("uses DOM scrollHeight when it exceeds cssContentSize", async () => {
    // cssContentSize reports 800, but DOM scrollHeight is 4105
    mockWsInstance.send = vi.fn((data: string) => {
      const msg = JSON.parse(data);
      const id = msg.id;
      setTimeout(() => {
        if (msg.method === "Page.navigate") {
          respondToCdp(id, {});
          respondToCdpEvent("Page.loadEventFired");
        } else if (msg.method === "Page.getLayoutMetrics") {
          respondToCdp(id, {
            cssContentSize: { width: 1280, height: 800 },
          });
        } else if (msg.method === "Page.captureScreenshot") {
          respondToCdp(id, { data: Buffer.from("screenshot-data").toString("base64") });
        } else if (msg.method === "Runtime.evaluate") {
          const expr = msg.params?.expression as string ?? "";
          if (expr.includes("scrollHeight")) {
            respondToCdp(id, { result: { value: 4105 } });
          } else {
            respondToCdp(id, { result: { value: undefined } });
          }
        } else {
          respondToCdp(id, {});
        }
      }, 0);
    });
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com", delay: 0 });
    expect(result.pageHeight).toBe(4105);
  });

  it("uses cssContentSize when it exceeds DOM scrollHeight", async () => {
    // cssContentSize reports 5000, but DOM scrollHeight is 3000
    mockWsInstance.send = vi.fn((data: string) => {
      const msg = JSON.parse(data);
      const id = msg.id;
      setTimeout(() => {
        if (msg.method === "Page.navigate") {
          respondToCdp(id, {});
          respondToCdpEvent("Page.loadEventFired");
        } else if (msg.method === "Page.getLayoutMetrics") {
          respondToCdp(id, {
            cssContentSize: { width: 1280, height: 5000 },
          });
        } else if (msg.method === "Page.captureScreenshot") {
          respondToCdp(id, { data: Buffer.from("screenshot-data").toString("base64") });
        } else if (msg.method === "Runtime.evaluate") {
          const expr = msg.params?.expression as string ?? "";
          if (expr.includes("scrollHeight")) {
            respondToCdp(id, { result: { value: 3000 } });
          } else {
            respondToCdp(id, { result: { value: undefined } });
          }
        } else {
          respondToCdp(id, {});
        }
      }, 0);
    });
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com", delay: 0 });
    expect(result.pageHeight).toBe(5000);
  });

  // ─── Settle Loop Tests ──────────────────────────────────────────

  it("settle loop breaks early when height stabilizes", async () => {
    let settleScrollHeightCalls = 0;
    const scrollHeightExpr = "Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)";
    mockWsInstance.send = vi.fn((data: string) => {
      const msg = JSON.parse(data);
      const id = msg.id;
      setTimeout(() => {
        if (msg.method === "Page.navigate") {
          respondToCdp(id, {});
          respondToCdpEvent("Page.loadEventFired");
        } else if (msg.method === "Page.getLayoutMetrics") {
          respondToCdp(id, {
            cssContentSize: { width: 1280, height: 2000 },
          });
        } else if (msg.method === "Page.captureScreenshot") {
          respondToCdp(id, { data: Buffer.from("screenshot-data").toString("base64") });
        } else if (msg.method === "Runtime.evaluate") {
          const expr = msg.params?.expression as string ?? "";
          if (expr === scrollHeightExpr) {
            settleScrollHeightCalls++;
            // Height is stable from the start: 1500 on every poll.
            // Settle loop: i=0 -> 1500 (prevHeight=0, no match), i=1 -> 1500 (matches, break).
            // That's 2 settle polls + 1 final cross-check = 3 total.
            respondToCdp(id, { result: { value: 1500 } });
          } else if (expr.includes("scrollHeight")) {
            // Lazy loading script also contains scrollHeight; respond normally
            respondToCdp(id, { result: { value: undefined } });
          } else {
            respondToCdp(id, { result: { value: undefined } });
          }
        } else {
          respondToCdp(id, {});
        }
      }, 0);
    });
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", delay: 0 });

    // Without early break: 3 settle polls + 1 cross-check = 4.
    // With early break at i=1: 2 settle polls + 1 cross-check = 3.
    expect(settleScrollHeightCalls).toBe(3);
  });

  it("falls back to cssContentSize when scrollHeight returns NaN", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockWsInstance.send = vi.fn((data: string) => {
      const msg = JSON.parse(data);
      const id = msg.id;
      setTimeout(() => {
        if (msg.method === "Page.navigate") {
          respondToCdp(id, {});
          respondToCdpEvent("Page.loadEventFired");
        } else if (msg.method === "Page.getLayoutMetrics") {
          respondToCdp(id, {
            cssContentSize: { width: 1280, height: 2000 },
          });
        } else if (msg.method === "Page.captureScreenshot") {
          respondToCdp(id, { data: Buffer.from("screenshot-data").toString("base64") });
        } else if (msg.method === "Runtime.evaluate") {
          const expr = msg.params?.expression as string ?? "";
          if (expr.includes("scrollHeight")) {
            respondToCdp(id, { result: { value: NaN } });
          } else {
            respondToCdp(id, { result: { value: undefined } });
          }
        } else {
          respondToCdp(id, {});
        }
      }, 0);
    });
    setTimeout(emitDevToolsUrl, 0);

    const result = await captureUrl({ url: "https://example.com", delay: 0 });
    // NaN scrollHeight should be treated as 0, so cssContentSize height wins
    expect(result.pageHeight).toBe(2000);
    // Settle loop warning should fire since prevHeight stayed 0
    expect(warnSpy).toHaveBeenCalledWith(
      "[url-capture] Layout settle: scrollHeight was 0 on all polls; relying on cssContentSize only"
    );
    warnSpy.mockRestore();
  });

  // ─── Kill Switch ─────────────────────────────────────────────────

  it("rejects when URL capture is disabled via env", async () => {
    mockIsUrlCaptureDisabled.mockReturnValue(true);
    await expect(
      captureUrl({ url: "https://example.com", delay: 0 })
    ).rejects.toThrow("URL capture is disabled");
    mockIsUrlCaptureDisabled.mockReturnValue(false);
  });

  // ─── --no-sandbox Conditional Logic ──────────────────────────────

  it("spawn receives --no-sandbox when CHROME_NO_SANDBOX=1", async () => {
    process.env.CHROME_NO_SANDBOX = "1";
    setupCdpAutoResponder(1280, 800);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", delay: 0 });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--no-sandbox");
  });

  it("spawn does NOT include --no-sandbox when neither root nor env var set", async () => {
    setupCdpAutoResponder(1280, 800);
    setTimeout(emitDevToolsUrl, 0);

    await captureUrl({ url: "https://example.com", delay: 0 });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain("--no-sandbox");
  });

  // ─── Abort Signal Tests ───────────────────────────────────────────

  it("rejects CDP commands when overall timeout fires", async () => {
    // Set up auto-responder that is very slow for one command
    mockWsInstance.send = vi.fn((data: string) => {
      const msg = JSON.parse(data);
      const id = msg.id;
      setTimeout(() => {
        if (msg.method === "Page.navigate") {
          respondToCdp(id, {});
          respondToCdpEvent("Page.loadEventFired");
        } else if (msg.method === "Runtime.evaluate") {
          respondToCdp(id, { result: { value: undefined } });
        } else if (msg.method === "Page.getLayoutMetrics") {
          // Never respond — simulate a hang
        } else {
          respondToCdp(id, {});
        }
      }, 0);
    });
    setTimeout(emitDevToolsUrl, 0);

    // Short timeout so abort fires before the 30s CDP default
    await expect(
      captureUrl({ url: "https://example.com", timeout: 16_000, delay: 0 })
    ).rejects.toThrow("Capture timed out");
  }, 20_000);
});

