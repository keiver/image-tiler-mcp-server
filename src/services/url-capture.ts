import { spawn, execSync, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { setMaxListeners } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import WebSocket from "ws";
import {
  MAX_CAPTURE_HEIGHT,
  MAX_STITCH_BYTES,
  CHROME_MAX_CAPTURE_HEIGHT,
  CAPTURE_DEFAULT_VIEWPORT_WIDTH,
  CAPTURE_DEFAULT_VIEWPORT_HEIGHT,
  CAPTURE_DEFAULT_TIMEOUT_MS,
  CAPTURE_STITCH_SETTLE_MS,
  CAPTURE_IDLE_TIMEOUT_MS,
  ALLOWED_CAPTURE_PROTOCOLS,
  SHARP_OPERATION_TIMEOUT_MS,
  MAX_CHROME_STDERR_BYTES,
  MAX_CHROME_JSON_BYTES,
  LAZY_LOAD_SCROLL_PAUSE_MS,
  LAZY_LOAD_IMAGE_TIMEOUT_MS,
  LAZY_LOAD_TOTAL_TIMEOUT_MS,
} from "../constants.js";
import { withTimeout } from "../utils.js";
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
    try {
      fs.accessSync(chromePath, fs.constants.X_OK);
    } catch {
      throw new Error(
        `CHROME_PATH points to non-existent or non-executable file: ${chromePath}`
      );
    }
    return chromePath;
  }

  const platform = os.platform();

  // 2. Platform-specific paths
  if (platform === "darwin") {
    const macPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    try {
      fs.accessSync(macPath, fs.constants.X_OK);
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
        fs.accessSync(p, fs.constants.X_OK);
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

/**
 * Creates a settle/cleanup pair for a WebSocket promise.
 * Ensures exactly one resolve/reject per promise and removes all listeners on settlement.
 *
 * @param ws       - WebSocket to manage listeners on
 * @param timers   - Timers to clear on settlement
 * @param label    - Human-readable context for error messages
 * @param reject   - The promise's reject function
 * @returns { settle, addListener } — settle guards against double-settlement,
 *   addListener registers a WS listener that will be removed on cleanup.
 */
function createWsSettler(
  ws: WebSocket,
  timers: Array<ReturnType<typeof setTimeout>>,
  label: string,
  reject: (reason: Error) => void
): {
  settle: (fn: () => void) => void;
  addListener: <E extends string>(event: E, handler: (...args: unknown[]) => void) => void;
} {
  let settled = false;
  const listeners: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

  function cleanup(): void {
    for (const t of timers) clearTimeout(t);
    for (const { event, handler } of listeners) ws.removeListener(event, handler);
  }

  function settle(fn: () => void): void {
    if (settled) return;
    settled = true;
    cleanup();
    fn();
  }

  function addListener<E extends string>(event: E, handler: (...args: unknown[]) => void): void {
    listeners.push({ event, handler });
    ws.on(event, handler);
  }

  // Register close/error handlers that every WS promise needs
  addListener("close", (code: unknown, reason: unknown) => {
    const reasonStr = reason instanceof Buffer ? reason.toString() : String(reason ?? "");
    settle(() => reject(new Error(
      `WebSocket closed while ${label} (code ${code}, reason: ${reasonStr || "none"})`
    )));
  });

  addListener("error", (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    settle(() => reject(new Error(`WebSocket error while ${label}: ${msg}`)));
  });

  return { settle, addListener };
}

function sendCdpCommand(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
  timeout = 30_000,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (signal?.aborted) return Promise.reject(new Error("Capture timed out"));

  const id = ++cdpCommandId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`CDP command '${method}' timed out after ${timeout}ms`)));
    }, timeout);

    const { settle, addListener } = createWsSettler(
      ws, [timer], `awaiting CDP command '${method}'`, reject
    );

    // Wire abort signal for overall timeout enforcement
    if (signal) {
      const onAbort = () => settle(() => reject(new Error("Capture timed out")));
      signal.addEventListener("abort", onAbort, { once: true });
    }

    addListener("message", (data: unknown) => {
      let msg: CdpResponse;
      try {
        msg = JSON.parse((data as WebSocket.RawData).toString()) as CdpResponse;
      } catch {
        return; // Ignore malformed CDP messages
      }
      if (msg.id === id) {
        settle(() => {
          if (msg.error) {
            reject(new Error(`CDP error (${msg.error.code}): ${msg.error.message}`));
          } else {
            resolve(msg.result ?? {});
          }
        });
      }
    });

    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      settle(() => reject(new Error(`ws.send failed for CDP command '${method}': ${(err as Error).message}`)));
    }
  });
}

// ─── Wait Conditions ────────────────────────────────────────────────

/**
 * Waits for a single CDP event by method name (e.g. "Page.loadEventFired").
 * Used for both load and DOMContentLoaded wait conditions.
 */
function waitForCdpEvent(
  ws: WebSocket,
  eventName: string,
  label: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Capture timed out"));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`${label} timed out after ${timeout}ms`)));
    }, timeout);

    const { settle, addListener } = createWsSettler(
      ws, [timer], `waiting for ${label}`, reject
    );

    if (signal) {
      const onAbort = () => settle(() => reject(new Error("Capture timed out")));
      signal.addEventListener("abort", onAbort, { once: true });
    }

    addListener("message", (data: unknown) => {
      let msg: CdpEvent;
      try {
        msg = JSON.parse((data as WebSocket.RawData).toString()) as CdpEvent;
      } catch {
        return; // Ignore malformed CDP messages
      }
      if (msg.method === eventName) {
        settle(() => resolve());
      }
    });
  });
}

function waitForNetworkIdle(ws: WebSocket, timeout: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Capture timed out"));

  return new Promise((resolve, reject) => {
    let pending = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const overallTimer = setTimeout(() => {
      settle(() => reject(new Error(`Network idle timed out after ${timeout}ms`)));
    }, timeout);

    const timers = [overallTimer];
    const { settle, addListener } = createWsSettler(
      ws, timers, "waiting for network idle", reject
    );

    if (signal) {
      const onAbort = () => settle(() => reject(new Error("Capture timed out")));
      signal.addEventListener("abort", onAbort, { once: true });
    }

    function checkIdle(): void {
      if (idleTimer) clearTimeout(idleTimer);
      if (pending <= 0) {
        idleTimer = setTimeout(() => {
          settle(() => resolve());
        }, CAPTURE_IDLE_TIMEOUT_MS);
        timers.push(idleTimer);
      }
    }

    addListener("message", (data: unknown) => {
      let msg: CdpEvent;
      try {
        msg = JSON.parse((data as WebSocket.RawData).toString()) as CdpEvent;
      } catch {
        return; // Ignore malformed CDP messages
      }
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
    });

    // Start the idle check in case there are no network requests at all
    checkIdle();
  });
}

// ─── Scroll-Stitch ──────────────────────────────────────────────────

async function captureWithStitching(
  ws: WebSocket,
  width: number,
  fullHeight: number,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; segments: number }> {
  const segmentHeight = CHROME_MAX_CAPTURE_HEIGHT;
  const segments: { buffer: Buffer; top: number }[] = [];
  let offset = 0;
  let cumulativeBytes = 0;

  while (offset < fullHeight) {
    const captureHeight = Math.min(segmentHeight, fullHeight - offset);

    // Defense-in-depth: ensure offset is a safe integer before injecting into JS expression
    if (!Number.isFinite(offset)) {
      throw new Error(`Invalid scroll offset: ${offset}`);
    }

    // Scroll to offset (bitwise OR floors to integer, guarding against fractional drift)
    await sendCdpCommand(ws, "Runtime.evaluate", {
      expression: `window.scrollTo(0, ${offset | 0})`,
    }, 30_000, signal);

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
    }, 30_000, signal);

    const data = result.data as string;
    const segmentBuffer = Buffer.from(data, "base64");
    cumulativeBytes += segmentBuffer.length;
    if (cumulativeBytes > MAX_STITCH_BYTES) {
      throw new Error(
        `Scroll-stitch buffer exceeded ${MAX_STITCH_BYTES} bytes (${cumulativeBytes} bytes after ${segments.length + 1} segments). Page is too large to stitch.`
      );
    }
    segments.push({
      buffer: segmentBuffer,
      top: offset,
    });

    offset += captureHeight;
  }

  // Stitch segments with Sharp (use longer timeout since stitching processes multiple segments)
  const compositeInputs = segments.map((seg) => ({
    input: seg.buffer,
    top: seg.top,
    left: 0,
  }));

  const stitched = await withTimeout(
    sharp({
      create: {
        width,
        height: fullHeight,
        channels: 4 as const,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite(compositeInputs)
      .png()
      .toBuffer(),
    SHARP_OPERATION_TIMEOUT_MS * 2,
    "scroll-stitch composite"
  );

  return { buffer: stitched, segments: segments.length };
}

// ─── Lazy Loading ────────────────────────────────────────────────────

/**
 * Triggers lazy-loaded images by scrolling through the page and converting
 * loading="lazy" to loading="eager". This ensures images that rely on
 * IntersectionObserver are loaded before screenshot capture.
 */
async function triggerLazyLoading(ws: WebSocket, signal?: AbortSignal): Promise<void> {
  await sendCdpCommand(ws, "Runtime.evaluate", {
    expression: `(async () => {
  const lazyImages = document.querySelectorAll('img[loading="lazy"]');
  if (lazyImages.length === 0) return;

  // Step 1: Convert loading="lazy" to loading="eager"
  lazyImages.forEach(img => {
    img.loading = 'eager';
  });

  // Step 2: Scroll through the page in viewport-height steps
  const viewportHeight = window.innerHeight || 800;
  const totalHeight = document.documentElement.scrollHeight;
  for (let y = 0; y < totalHeight; y += viewportHeight) {
    window.scrollTo(0, y);
    await new Promise(r => setTimeout(r, ${LAZY_LOAD_SCROLL_PAUSE_MS}));
  }

  // Step 3: Wait for all <img> elements to finish loading
  const images = Array.from(document.querySelectorAll('img'));
  await Promise.all(images.map(img => {
    if (img.complete) return Promise.resolve();
    return new Promise(resolve => {
      const timeout = setTimeout(resolve, ${LAZY_LOAD_IMAGE_TIMEOUT_MS});
      img.addEventListener('load', () => { clearTimeout(timeout); resolve(); }, { once: true });
      img.addEventListener('error', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
  }));

  // Step 4: Scroll back to top
  window.scrollTo(0, 0);
})()`,
    awaitPromise: true,
    returnByValue: true,
  }, LAZY_LOAD_TOTAL_TIMEOUT_MS, signal);
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

  // Overall timeout — signal is wired into CDP commands and wait conditions
  const abortController = new AbortController();
  const signal = abortController.signal;
  // Each CDP command/wait adds an abort listener; raise limit to avoid Node warning
  // Worst case: ~15 commands + stitch segments (MAX_CAPTURE_HEIGHT / CHROME_MAX_CAPTURE_HEIGHT ≈ 13)
  setMaxListeners(50, signal);
  const overallTimer = setTimeout(() => abortController.abort(), timeout);

  try {
    // Only use --no-sandbox when running as root or when explicitly requested via env var.
    // Chrome's sandbox is an important security boundary — disabling it means a Chrome
    // RCE exploit gives the attacker the user's full permissions.
    const needsNoSandbox = process.getuid?.() === 0 || process.env.CHROME_NO_SANDBOX === "1";

    const chromeArgs = [
      "--headless=new",
      "--remote-debugging-port=0",
      "--disable-gpu",
      ...(needsNoSandbox ? ["--no-sandbox"] : []),
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--no-first-run",
      `--window-size=${viewportWidth},${CAPTURE_DEFAULT_VIEWPORT_HEIGHT}`,
    ];

    // Spawn Chrome
    chrome = spawn(chromePath, chromeArgs, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    // Parse DevTools WebSocket URL from stderr
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const stderrTimer = setTimeout(() => {
        reject(new Error("Timed out waiting for Chrome DevTools WebSocket URL (10s)"));
      }, 10_000);

      let stderrBuf = "";
      let found = false;
      chrome!.stderr!.on("data", (chunk: Buffer) => {
        if (found) return;
        if (stderrBuf.length < MAX_CHROME_STDERR_BYTES) {
          stderrBuf += chunk.toString();
        }
        // Process only recent lines to avoid re-scanning the full buffer
        const lines = stderrBuf.split("\n");
        for (const line of lines) {
          if (line.length > 1024) continue;
          const match = line.match(/DevTools listening on (ws:\/\/\S{10,200})/);
          if (match) {
            found = true;
            clearTimeout(stderrTimer);
            resolve(match[1]);
            return;
          }
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
          res.on("data", (chunk: Buffer) => {
            if (body.length >= MAX_CHROME_JSON_BYTES) {
              res.destroy();
              clearTimeout(jsonTimer);
              reject(new Error(`Chrome /json response exceeded ${MAX_CHROME_JSON_BYTES} bytes`));
              return;
            }
            body += chunk.toString();
          });
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
    await sendCdpCommand(ws, "Page.enable", {}, 30_000, signal);
    if (waitUntil === "networkidle") {
      await sendCdpCommand(ws, "Network.enable", {}, 30_000, signal);
    }

    // Set viewport before navigation so Chrome has valid dimensions for layout
    await sendCdpCommand(ws, "Emulation.setDeviceMetricsOverride", {
      width: viewportWidth,
      height: CAPTURE_DEFAULT_VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    }, 30_000, signal);

    // Navigate and wait
    const remainingTimeout = Math.max(1000, timeout - 15_000); // reserve ~15s for setup

    let waitPromise: Promise<void>;
    if (waitUntil === "load") {
      waitPromise = waitForCdpEvent(ws, "Page.loadEventFired", "Page load", remainingTimeout, signal);
    } else if (waitUntil === "domcontentloaded") {
      waitPromise = waitForCdpEvent(ws, "Page.domContentEventFired", "DOMContentLoaded", remainingTimeout, signal);
    } else {
      waitPromise = waitForNetworkIdle(ws, remainingTimeout, signal);
    }

    await sendCdpCommand(ws, "Page.navigate", { url }, 30_000, signal);
    await waitPromise;

    // Optional delay
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }

    // Trigger lazy-loaded images (scrolls page, converts loading="lazy" → "eager",
    // waits for images to finish loading, then scrolls back to top)
    await triggerLazyLoading(ws, signal);

    if (abortController.signal.aborted) {
      throw new Error("Capture timed out");
    }

    // Check if Chrome navigated to an error page (redirect loop, DNS failure, etc.)
    const navResult = await sendCdpCommand(ws, "Runtime.evaluate", {
      expression: "document.location.href",
      returnByValue: true,
    }, 30_000, signal);
    const currentUrl = (navResult.result as { value?: string })?.value ?? "";
    if (currentUrl.startsWith("chrome-error://")) {
      // Extract error text from the page for a helpful message
      const errorTextResult = await sendCdpCommand(ws, "Runtime.evaluate", {
        expression: "document.body?.innerText?.slice(0, 500) || ''",
        returnByValue: true,
      }, 30_000, signal);
      const errorText = (errorTextResult.result as { value?: string })?.value ?? "";
      const snippet = errorText.trim() ? `: ${errorText.split("\n")[0]}` : "";
      throw new Error(
        `Chrome navigated to an error page instead of ${url}${snippet}. ` +
        `This may indicate a redirect loop, DNS failure, or authentication requirement.`
      );
    }

    // Get page dimensions
    const layoutMetrics = await sendCdpCommand(ws, "Page.getLayoutMetrics", {}, 30_000, signal);
    const contentSize = layoutMetrics.cssContentSize as { width: number; height: number } | undefined
      ?? layoutMetrics.contentSize as { width: number; height: number } | undefined;

    if (!contentSize || typeof contentSize.width !== "number" || typeof contentSize.height !== "number") {
      throw new Error(
        "Chrome did not return page dimensions (neither cssContentSize nor contentSize in layoutMetrics). " +
        "This may indicate an incompatible Chrome/Chromium version."
      );
    }

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
      }, 30_000, signal);

      const result = await sendCdpCommand(ws, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      }, 30_000, signal);

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
      }, 30_000, signal);

      const stitchResult = await captureWithStitching(ws, pageWidth, pageHeight, signal);
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

    // Close WebSocket (safe to call in any state — handles CONNECTING, OPEN, etc.)
    if (ws) {
      try { ws.close(); } catch { /* already closed or failed — safe to ignore */ }
    }

    // Kill Chrome
    if (chrome && !chrome.killed) {
      try {
        const killTimer = setTimeout(() => {
          try { if (chrome && !chrome.killed) chrome.kill("SIGKILL"); } catch { /* already dead */ }
        }, 2000);
        chrome.on("exit", () => clearTimeout(killTimer));
        chrome.kill("SIGTERM");
      } catch {
        // Process already dead — safe to ignore
      }
    }
  }
}
