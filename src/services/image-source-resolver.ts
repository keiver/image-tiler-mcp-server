import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as https from "node:https";
import { randomUUID } from "node:crypto";
import { useAgent } from "request-filtering-agent";
import {
  MAX_DOWNLOAD_SIZE_BYTES,
  DOWNLOAD_TIMEOUT_MS,
  ALLOWED_URL_PROTOCOLS,
  MAX_REDIRECT_HOPS,
  DENY_HTTP_PRIVATE_ENV_VAR,
} from "../constants.js";
import type { ResolvedImageSource } from "../types.js";

function makeTempPath(ext: string): string {
  return path.join(os.tmpdir(), `tiler-src-${randomUUID()}${ext}`);
}

function makeIdempotentCleanup(tempPath: string): () => Promise<string | undefined> {
  let cleaned = false;
  return async () => {
    if (cleaned) return undefined;
    cleaned = true;
    try {
      await fs.unlink(tempPath);
      return undefined;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        const msg = err instanceof Error ? err.message : String(err);
        return `Failed to clean up temp file ${tempPath}: ${msg}`;
      }
      return undefined;
    }
  };
}

// ─── Low-level HTTP download ──────────────────────────────────────────────

interface DownloadResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Single-request download via http/https.request(). Returns status, headers, body.
 * https: always uses request-filtering-agent for SSRF protection.
 * http: skips SSRF filtering by default (allows localhost, private IPs for dev servers).
 * Set TILER_DENY_HTTP_PRIVATE=1 to opt-in to blocking private IPs on http:.
 */
function downloadWithAgent(url: string, timeoutMs: number): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    }

    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const httpPrivateDenied = process.env[DENY_HTTP_PRIVATE_ENV_VAR] === "1";
    const agent = (isHttps || httpPrivateDenied) ? useAgent(url) : undefined;
    const requestFn = isHttps ? https.request : http.request;

    const req = requestFn(url, { agent }, (res) => {
      const chunks: Buffer[] = [];
      let downloadedBytes = 0;

      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        downloadedBytes += chunk.length;
        if (downloadedBytes > MAX_DOWNLOAD_SIZE_BYTES) {
          res.destroy();
          settle(() => reject(new Error(
            `Downloaded image exceeded the ${MAX_DOWNLOAD_SIZE_BYTES} byte limit (at ${downloadedBytes} bytes). Download aborted.`
          )));
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        settle(() => resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      });

      res.on("error", (err: Error) => {
        settle(() => reject(new Error(`Failed to fetch image: ${err.message}`)));
      });
    });

    req.on("error", (err: Error) => {
      settle(() => reject(new Error(`Failed to fetch image: ${err.message}`)));
    });

    const timer = setTimeout(() => {
      req.destroy();
      settle(() => reject(new Error(`Download timed out after ${timeoutMs / 1000}s: ${url}`)));
    }, timeoutMs);

    req.end();
  });
}

// ─── URL resolution with redirect following ────────────────────────────────

/**
 * Downloads a URL with SSRF-safe redirect following.
 * - Each hop re-applies useAgent() for https: (no TOCTOU gap).
 * - Blocks https: -> http: downgrades.
 * - Allows http: -> https: upgrades.
 * - Limits to MAX_REDIRECT_HOPS (5) hops.
 */
async function resolveUrl(url: string): Promise<ResolvedImageSource> {
  const parsed = new URL(url);
  if (!ALLOWED_URL_PROTOCOLS.includes(parsed.protocol as typeof ALLOWED_URL_PROTOCOLS[number])) {
    throw new Error(
      `Unsupported URL protocol "${parsed.protocol}". Only ${ALLOWED_URL_PROTOCOLS.join(", ")} allowed.`
    );
  }

  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const result = await downloadWithAgent(currentUrl, DOWNLOAD_TIMEOUT_MS);

    // Follow redirects
    if (result.statusCode >= 300 && result.statusCode < 400) {
      const location = result.headers.location;
      if (!location) {
        throw new Error(`HTTP ${result.statusCode} redirect with no Location header from ${currentUrl}`);
      }
      if (hop === MAX_REDIRECT_HOPS) {
        throw new Error(`Too many redirects (>${MAX_REDIRECT_HOPS}) starting from ${url}`);
      }

      const nextUrl = new URL(location, currentUrl);

      // Block https -> http downgrade
      if (new URL(currentUrl).protocol === "https:" && nextUrl.protocol === "http:") {
        throw new Error(
          `Redirect from https: to http: is blocked (${currentUrl} -> ${nextUrl.href})`
        );
      }

      if (!ALLOWED_URL_PROTOCOLS.includes(nextUrl.protocol as typeof ALLOWED_URL_PROTOCOLS[number])) {
        throw new Error(
          `Redirect to unsupported protocol "${nextUrl.protocol}" (from ${currentUrl})`
        );
      }

      currentUrl = nextUrl.href;
      continue;
    }

    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`HTTP ${result.statusCode} fetching ${currentUrl}`);
    }

    // Validate Content-Type
    const contentType = result.headers["content-type"] ?? null;
    if (contentType) {
      const lower = contentType.toLowerCase();
      if (!lower.startsWith("image/") && !lower.startsWith("application/octet-stream")) {
        throw new Error(
          `URL returned non-image Content-Type "${contentType}". Expected an image/* MIME type.`
        );
      }
    }

    // Check Content-Length (also enforced during streaming above)
    const contentLengthHeader = result.headers["content-length"];
    if (contentLengthHeader && parseInt(contentLengthHeader, 10) > MAX_DOWNLOAD_SIZE_BYTES) {
      throw new Error(
        `Image at ${currentUrl} is ${parseInt(contentLengthHeader, 10)} bytes, exceeding the ${MAX_DOWNLOAD_SIZE_BYTES} byte limit.`
      );
    }

    // When Content-Type is ambiguous (octet-stream or missing), verify magic bytes
    const ctLower = (contentType ?? "").toLowerCase();
    if (!ctLower.startsWith("image/")) {
      if (!guessExtensionFromMagicBytes(result.body)) {
        throw new Error(
          `Downloaded file is not a recognized image format (checked magic bytes). Content-Type was "${contentType ?? "missing"}".`
        );
      }
    }

    const ext = guessExtensionFromContentType(contentType)
      || guessExtensionFromMagicBytes(result.body)
      || ".png";
    const tempPath = makeTempPath(ext);
    await fs.writeFile(tempPath, result.body);

    return {
      localPath: tempPath,
      cleanup: makeIdempotentCleanup(tempPath),
      sourceType: "url",
      originalSource: url,
    };
  }

  // Should not be reachable: loop always returns or throws
  throw new Error(`Too many redirects (>${MAX_REDIRECT_HOPS}) starting from ${url}`);
}

async function resolveDataUrl(dataUrl: string): Promise<ResolvedImageSource> {
  const match = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) {
    throw new Error(
      'Invalid data URL format. Expected "data:image/<format>;base64,<data>".'
    );
  }

  const mimeSubtype = match[1];
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, "base64");

  if (buffer.length > MAX_DOWNLOAD_SIZE_BYTES) {
    throw new Error(
      `Decoded data URL is ${buffer.length} bytes, exceeding the ${MAX_DOWNLOAD_SIZE_BYTES} byte limit.`
    );
  }

  const ext = mimeSubtypeToExtension(mimeSubtype);
  const tempPath = makeTempPath(ext);
  await fs.writeFile(tempPath, buffer);

  return {
    localPath: tempPath,
    cleanup: makeIdempotentCleanup(tempPath),
    sourceType: "data_url",
    originalSource: `data:image/${mimeSubtype};base64,[${base64Data.length} chars]`,
  };
}

async function resolveBase64(base64: string): Promise<ResolvedImageSource> {
  const trimmed = base64.trim();
  if (trimmed.length === 0) {
    throw new Error("Base64 string is empty.");
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    throw new Error("Base64 string contains invalid characters.");
  }

  const buffer = Buffer.from(trimmed, "base64");
  if (buffer.length === 0) {
    throw new Error("Base64 string decoded to zero bytes.");
  }
  if (buffer.length > MAX_DOWNLOAD_SIZE_BYTES) {
    throw new Error(
      `Decoded base64 data is ${buffer.length} bytes, exceeding the ${MAX_DOWNLOAD_SIZE_BYTES} byte limit.`
    );
  }

  const ext = guessExtensionFromMagicBytes(buffer) || ".png";
  const tempPath = makeTempPath(ext);
  await fs.writeFile(tempPath, buffer);

  return {
    localPath: tempPath,
    cleanup: makeIdempotentCleanup(tempPath),
    sourceType: "base64",
    originalSource: `[base64, ${base64.length} chars]`,
  };
}

export function guessExtensionFromContentType(ct: string | null): string | undefined {
  if (!ct) return undefined;
  const lower = ct.toLowerCase();
  if (lower.includes("png")) return ".png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("tiff")) return ".tiff";
  if (lower.includes("gif")) return ".gif";
  return undefined;
}

export function mimeSubtypeToExtension(subtype: string): string {
  const lower = subtype.toLowerCase();
  if (lower === "jpeg" || lower === "jpg") return ".jpg";
  if (lower === "png") return ".png";
  if (lower === "webp") return ".webp";
  if (lower === "tiff") return ".tiff";
  if (lower === "gif") return ".gif";
  return `.${lower}`;
}

export function guessExtensionFromMagicBytes(buf: Buffer): string | undefined {
  if (buf.length < 4) return undefined;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  // RIFF container: check bytes 8-11 for "WEBP" to distinguish from AVI/WAV
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return ".webp";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return ".gif";
  if (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) return ".tiff";
  if (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a) return ".tiff";
  return undefined;
}

export interface ImageSourceParams {
  filePath?: string;
  sourceUrl?: string;
  dataUrl?: string;
  imageBase64?: string;
}

/**
 * Resolves an image from one of four possible sources to a local file path.
 * Precedence: filePath > sourceUrl > dataUrl > imageBase64
 *
 * The caller MUST call cleanup() in a finally block:
 * ```
 * const source = await resolveImageSource(params);
 * try {
 *   // use source.localPath
 * } finally {
 *   await source.cleanup?.();
 * }
 * ```
 */
export async function resolveImageSource(
  params: ImageSourceParams
): Promise<ResolvedImageSource> {
  if (params.filePath) {
    return {
      localPath: params.filePath,
      sourceType: "file",
      originalSource: params.filePath,
    };
  }

  if (params.sourceUrl) {
    return resolveUrl(params.sourceUrl);
  }

  if (params.dataUrl) {
    return resolveDataUrl(params.dataUrl);
  }

  if (params.imageBase64) {
    return resolveBase64(params.imageBase64);
  }

  throw new Error(
    "No image source provided. Supply one of: filePath, sourceUrl, dataUrl, or imageBase64."
  );
}
