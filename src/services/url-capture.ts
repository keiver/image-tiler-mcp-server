import { spawn, execSync, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import WebSocket from "ws";
import {
  MAX_CAPTURE_HEIGHT,
  CHROME_MAX_CAPTURE_HEIGHT,
  CAPTURE_DEFAULT_VIEWPORT_WIDTH,
  CAPTURE_DEFAULT_VIEWPORT_HEIGHT,
  CAPTURE_DEFAULT_TIMEOUT_MS,
  CAPTURE_STITCH_SETTLE_MS,
  CAPTURE_IDLE_TIMEOUT_MS,
  ALLOWED_CAPTURE_PROTOCOLS,
} from "../constants.js";
import type { CaptureUrlOptions, CaptureResult } from "../types.js";

// ─── Display Detection ──────────────────────────────────────────────

/**
 * Detects the primary display's CSS-pixel width.
 * macOS only — returns undefined on other platforms or on failure.
 */
export function detectDisplayWidth(): number | undefined {
  if (os.platform() !== "darwin") return undefined;

  try {
    const raw = execSync("system_profiler SPDisplaysDataType -json", {
      encoding: "utf8",
      timeout: 5000,
    });
    const data = JSON.parse(raw) as {
      SPDisplaysDataType?: Array<{
        spdisplays_ndrvs?: Array<{
          _spdisplays_resolution?: string;
          spdisplays_main?: string;
        }>;
      }>;
    };

    const gpus = data.SPDisplaysDataType ?? [];
    for (const gpu of gpus) {
      for (const display of gpu.spdisplays_ndrvs ?? []) {
        if (display.spdisplays_main !== "spdisplays_yes") continue;
        // Resolution string looks like "1512 x 982 @ 120.00Hz" (CSS pixels on Retina)
        // or "3024 x 1964 @ 120.00Hz" (native pixels)
        const match = display._spdisplays_resolution?.match(/(\d+)\s*x\s*(\d+)/);
        if (match) {
          return parseInt(match[1], 10);
        }
      }
    }
  } catch {
    // Never throw — just return undefined
  }

  return undefined;
}

// ─── Chrome Detection ───────────────────────────────────────────────

export function findChromePath(): string {
  // 1. Environment variable (highest priority)
  if (process.env.CHROME_PATH) {
    const chromePath = process.env.CHROME_PATH;
    if (!path.isAbsolute(chromePath)) {
      throw new Error("CHROME_PATH must be an absolute path");
    }
    return chromePath;
  }

  const platform = os.platform();

  // 2. Platform-specific paths
  if (platform === "darwin") {
    const macPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    try {
      fs.accessSync(macPath, fs.constants.F_OK);
      return macPath;
    } catch {
      // fall through
    }
  }

  if (platform === "linux") {
    for (const bin of ["google-chrome", "chromium-browser", "chromium"]) {
      try {
        const found = execFileSync("which", [bin], { encoding: "utf8" }).trim();
        if (found) return found;
      } catch {
        // try next
      }
    }
  }

  if (platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for (const p of candidates) {
      try {
        fs.accessSync(p, fs.constants.F_OK);
        return p;
      } catch {
        // try next
      }
    }
  }

  throw new Error(
    "Chrome not found. Install Google Chrome or set the CHROME_PATH environment variable to the Chrome executable path."
  );
}

// ─── CDP Helpers ────────────────────────────────────────────────────

let cdpCommandId = 0;

interface CdpResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
}

function sendCdpCommand(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
  timeout = 30_000
): Promise<Record<string, unknown>> {
  const id = ++cdpCommandId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`CDP command '${method}' timed out after ${timeout}ms`));
    }, timeout);

    function handler(data: WebSocket.RawData) {
      const msg = JSON.parse(data.toString()) as CdpResponse;
      if (msg.id === id) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        if (msg.error) {
          reject(new Error(`CDP error (${msg.error.code}): ${msg.error.message}`));
        } else {
          resolve(msg.result ?? {});
        }
      }
    }

    ws.on("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// ─── Wait Conditions ────────────────────────────────────────────────

function waitForLoad(ws: WebSocket, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`Page load timed out after ${timeout}ms`));
    }, timeout);

    function handler(data: WebSocket.RawData) {
      const msg = JSON.parse(data.toString()) as CdpEvent;
      if (msg.method === "Page.loadEventFired") {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve();
      }
    }

    ws.on("message", handler);
  });
}

function waitForDomContentLoaded(ws: WebSocket, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`DOMContentLoaded timed out after ${timeout}ms`));
    }, timeout);

    function handler(data: WebSocket.RawData) {
      const msg = JSON.parse(data.toString()) as CdpEvent;
      if (
        msg.method === "Page.lifecycleEvent" &&
        (msg.params as Record<string, unknown>)?.name === "DOMContentLoaded"
      ) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve();
      }
    }

    ws.on("message", handler);
  });
}

function waitForNetworkIdle(ws: WebSocket, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let pending = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    const overallTimer = setTimeout(() => {
      cleanup();
      reject(new Error(`Network idle timed out after ${timeout}ms`));
    }, timeout);

    function cleanup() {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(overallTimer);
      ws.removeListener("message", handler);
    }

    function checkIdle() {
      if (idleTimer) clearTimeout(idleTimer);
      if (pending <= 0) {
        idleTimer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve();
          }
        }, CAPTURE_IDLE_TIMEOUT_MS);
      }
    }

    function handler(data: WebSocket.RawData) {
      const msg = JSON.parse(data.toString()) as CdpEvent;
      if (msg.method === "Network.requestWillBeSent") {
        pending++;
        if (idleTimer) clearTimeout(idleTimer);
      } else if (
        msg.method === "Network.loadingFinished" ||
        msg.method === "Network.loadingFailed"
      ) {
        pending = Math.max(0, pending - 1);
        checkIdle();
      }
    }

    ws.on("message", handler);
    // Start the idle check in case there are no network requests at all
    checkIdle();
  });
}

// ─── Scroll-Stitch ──────────────────────────────────────────────────

async function captureWithStitching(
  ws: WebSocket,
  width: number,
  fullHeight: number
): Promise<{ buffer: Buffer; segments: number }> {
  const segmentHeight = CHROME_MAX_CAPTURE_HEIGHT;
  const segments: { buffer: Buffer; top: number }[] = [];
  let offset = 0;

  while (offset < fullHeight) {
    const captureHeight = Math.min(segmentHeight, fullHeight - offset);

    // Scroll to offset
    await sendCdpCommand(ws, "Runtime.evaluate", {
      expression: `window.scrollTo(0, ${offset})`,
    });

    // Wait for rendering to settle
    await new Promise((r) => setTimeout(r, CAPTURE_STITCH_SETTLE_MS));

    // Capture with clip
    const result = await sendCdpCommand(ws, "Page.captureScreenshot", {
      format: "png",
      clip: {
        x: 0,
        y: offset,
        width,
        height: captureHeight,
        scale: 1,
      },
      captureBeyondViewport: true,
    });

    const data = result.data as string;
    segments.push({
      buffer: Buffer.from(data, "base64"),
      top: offset,
    });

    offset += captureHeight;
  }

  // Stitch segments with Sharp
  const compositeInputs = segments.map((seg) => ({
    input: seg.buffer,
    top: seg.top,
    left: 0,
  }));

  const stitched = await sharp({
    create: {
      width,
      height: fullHeight,
      channels: 4 as const,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(compositeInputs)
    .png()
    .toBuffer();

  return { buffer: stitched, segments: segments.length };
}

// ─── Main Capture Function ──────────────────────────────────────────

export async function captureUrl(options: CaptureUrlOptions): Promise<CaptureResult> {
  const {
    url,
    viewportWidth = CAPTURE_DEFAULT_VIEWPORT_WIDTH,
    waitUntil = "load",
    delay = 0,
    timeout = CAPTURE_DEFAULT_TIMEOUT_MS,
  } = options;

  // URL validation
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (!ALLOWED_CAPTURE_PROTOCOLS.includes(parsed.protocol as typeof ALLOWED_CAPTURE_PROTOCOLS[number])) {
    throw new Error(
      `Unsupported protocol "${parsed.protocol}". Only ${ALLOWED_CAPTURE_PROTOCOLS.join(", ")} are allowed.`
    );
  }

  const chromePath = findChromePath();
  let chrome: ChildProcess | null = null;
  let ws: WebSocket | null = null;

  // Overall timeout
  const abortController = new AbortController();
  const overallTimer = setTimeout(() => abortController.abort(), timeout);

  try {
    // Spawn Chrome
    chrome = spawn(chromePath, [
      "--headless=new",
      "--remote-debugging-port=0",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--no-first-run",
      `--window-size=${viewportWidth},${CAPTURE_DEFAULT_VIEWPORT_HEIGHT}`,
    ], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    // Parse DevTools WebSocket URL from stderr
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const stderrTimer = setTimeout(() => {
        reject(new Error("Timed out waiting for Chrome DevTools WebSocket URL (10s)"));
      }, 10_000);

      let stderrBuf = "";
      chrome!.stderr!.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const match = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(stderrTimer);
          resolve(match[1]);
        }
      });

      chrome!.on("exit", (code) => {
        clearTimeout(stderrTimer);
        reject(new Error(`Chrome exited unexpectedly with code ${code}`));
      });

      if (abortController.signal.aborted) {
        clearTimeout(stderrTimer);
        reject(new Error("Capture timed out"));
      }
    });

    if (abortController.signal.aborted) {
      throw new Error("Capture timed out");
    }

    // Discover page-level WebSocket URL from Chrome's JSON API.
    // The wsUrl from stderr is the browser-level endpoint (/devtools/browser/...),
    // but Page/Network domains are only available on page-level targets.
    const browserWsUrl = new URL(wsUrl);
    const jsonEndpoint = `http://${browserWsUrl.hostname}:${browserWsUrl.port}/json`;

    const pageWsUrl = await new Promise<string>((resolve, reject) => {
      const jsonTimer = setTimeout(() => {
        reject(new Error("Timed out discovering Chrome page target (5s)"));
      }, 5_000);

      // Use http.get to avoid fetch compatibility concerns
      import("node:http").then(({ default: http }) => {
        http.get(jsonEndpoint, (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          res.on("end", () => {
            clearTimeout(jsonTimer);
            try {
              const targets = JSON.parse(body) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
              const pageTarget = targets.find((t) => t.type === "page");
              if (pageTarget?.webSocketDebuggerUrl) {
                resolve(pageTarget.webSocketDebuggerUrl);
              } else {
                reject(new Error("No page target found in Chrome"));
              }
            } catch (e) {
              reject(new Error(`Failed to parse Chrome targets: ${(e as Error).message}`));
            }
          });
          res.on("error", (err) => {
            clearTimeout(jsonTimer);
            reject(new Error(`Failed to fetch Chrome targets: ${err.message}`));
          });
        }).on("error", (err) => {
          clearTimeout(jsonTimer);
          reject(new Error(`Failed to connect to Chrome debug endpoint: ${err.message}`));
        });
      });
    });

    // Connect WebSocket to the page-level target
    ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(pageWsUrl);
      const connectTimer = setTimeout(() => {
        socket.close();
        reject(new Error("WebSocket connection to Chrome timed out (10s)"));
      }, 10_000);

      socket.on("open", () => {
        clearTimeout(connectTimer);
        resolve(socket);
      });
      socket.on("error", (err) => {
        clearTimeout(connectTimer);
        reject(new Error(`WebSocket connection failed: ${err.message}`));
      });
    });

    // Enable required domains
    await sendCdpCommand(ws, "Page.enable");
    if (waitUntil === "networkidle") {
      await sendCdpCommand(ws, "Network.enable");
    }

    // Set viewport before navigation so Chrome has valid dimensions for layout
    await sendCdpCommand(ws, "Emulation.setDeviceMetricsOverride", {
      width: viewportWidth,
      height: CAPTURE_DEFAULT_VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Navigate and wait
    const remainingTimeout = Math.max(1000, timeout - 15_000); // reserve ~15s for setup

    let waitPromise: Promise<void>;
    if (waitUntil === "load") {
      waitPromise = waitForLoad(ws, remainingTimeout);
    } else if (waitUntil === "domcontentloaded") {
      waitPromise = waitForDomContentLoaded(ws, remainingTimeout);
    } else {
      waitPromise = waitForNetworkIdle(ws, remainingTimeout);
    }

    await sendCdpCommand(ws, "Page.navigate", { url });
    await waitPromise;

    // Optional delay
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }

    if (abortController.signal.aborted) {
      throw new Error("Capture timed out");
    }

    // Get page dimensions
    const layoutMetrics = await sendCdpCommand(ws, "Page.getLayoutMetrics");
    const contentSize = layoutMetrics.cssContentSize as { width: number; height: number } | undefined
      ?? layoutMetrics.contentSize as { width: number; height: number };

    const pageWidth = Math.ceil(contentSize.width);
    const pageHeight = Math.ceil(contentSize.height);

    let buffer: Buffer;
    let segmentsStitched: number | undefined;

    if (pageHeight <= CHROME_MAX_CAPTURE_HEIGHT) {
      // Single capture
      await sendCdpCommand(ws, "Emulation.setDeviceMetricsOverride", {
        width: pageWidth,
        height: pageHeight,
        deviceScaleFactor: 1,
        mobile: false,
      });

      const result = await sendCdpCommand(ws, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });

      buffer = Buffer.from(result.data as string, "base64");
    } else {
      // Guard against absurdly tall pages that would OOM during stitching
      if (pageHeight > MAX_CAPTURE_HEIGHT) {
        throw new Error(
          `Page height ${pageHeight}px exceeds maximum ${MAX_CAPTURE_HEIGHT}px for scroll-stitching.`
        );
      }

      // Scroll-stitch for tall pages
      await sendCdpCommand(ws, "Emulation.setDeviceMetricsOverride", {
        width: pageWidth,
        height: pageHeight,
        deviceScaleFactor: 1,
        mobile: false,
      });

      const stitchResult = await captureWithStitching(ws, pageWidth, pageHeight);
      buffer = stitchResult.buffer;
      segmentsStitched = stitchResult.segments;
    }

    const captureResult: CaptureResult = {
      buffer,
      pageWidth,
      pageHeight,
      url,
    };

    if (segmentsStitched !== undefined) {
      captureResult.segmentsStitched = segmentsStitched;
    }

    return captureResult;
  } finally {
    clearTimeout(overallTimer);

    // Close WebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }

    // Kill Chrome
    if (chrome && !chrome.killed) {
      try {
        chrome.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          try { if (chrome && !chrome.killed) chrome.kill("SIGKILL"); } catch { /* already dead */ }
        }, 2000);
        chrome.on("exit", () => clearTimeout(killTimer));
      } catch {
        // Process already dead — safe to ignore
      }
    }
  }
}
