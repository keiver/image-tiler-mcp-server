import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import {
  MAX_DOWNLOAD_SIZE_BYTES,
  DOWNLOAD_TIMEOUT_MS,
  ALLOWED_URL_PROTOCOLS,
} from "../constants.js";
import type { ResolvedImageSource } from "../types.js";

function makeTempPath(ext: string): string {
  return path.join(os.tmpdir(), `tiler-src-${randomUUID()}${ext}`);
}

function makeIdempotentCleanup(tempPath: string): () => Promise<void> {
  let cleaned = false;
  return async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await fs.unlink(tempPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[image-tiler] Failed to clean up temp file ${tempPath}: ${msg}`);
      }
    }
  };
}

async function resolveUrl(url: string): Promise<ResolvedImageSource> {
  const parsed = new URL(url);
  if (!ALLOWED_URL_PROTOCOLS.includes(parsed.protocol as typeof ALLOWED_URL_PROTOCOLS[number])) {
    throw new Error(
      `Unsupported URL protocol "${parsed.protocol}". Only ${ALLOWED_URL_PROTOCOLS.join(", ")} allowed.`
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s: ${url}`);
    }
    throw new Error(`Failed to fetch image: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_SIZE_BYTES) {
    throw new Error(
      `Image at ${url} is ${parseInt(contentLength, 10)} bytes, exceeding the ${MAX_DOWNLOAD_SIZE_BYTES} byte limit.`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_SIZE_BYTES) {
    throw new Error(
      `Downloaded image is ${buffer.length} bytes, exceeding the ${MAX_DOWNLOAD_SIZE_BYTES} byte limit.`
    );
  }

  const ext = guessExtensionFromContentType(response.headers.get("content-type")) || ".png";
  const tempPath = makeTempPath(ext);
  await fs.writeFile(tempPath, buffer);

  return {
    localPath: tempPath,
    cleanup: makeIdempotentCleanup(tempPath),
    sourceType: "url",
    originalSource: url,
  };
}

async function resolveDataUrl(dataUrl: string): Promise<ResolvedImageSource> {
  const match = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if (!match) {
    throw new Error(
      'Invalid data URL format. Expected "data:image/<format>;base64,<data>".'
    );
  }

  const mimeSubtype = match[1];
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, "base64");

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
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) {
    throw new Error("Base64 string decoded to zero bytes.");
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

function guessExtensionFromContentType(ct: string | null): string | undefined {
  if (!ct) return undefined;
  const lower = ct.toLowerCase();
  if (lower.includes("png")) return ".png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("tiff")) return ".tiff";
  if (lower.includes("gif")) return ".gif";
  return undefined;
}

function mimeSubtypeToExtension(subtype: string): string {
  const lower = subtype.toLowerCase();
  if (lower === "jpeg" || lower === "jpg") return ".jpg";
  if (lower === "png") return ".png";
  if (lower === "webp") return ".webp";
  if (lower === "tiff") return ".tiff";
  if (lower === "gif") return ".gif";
  return `.${lower}`;
}

function guessExtensionFromMagicBytes(buf: Buffer): string | undefined {
  if (buf.length < 4) return undefined;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return ".webp";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return ".gif";
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) return ".tiff";
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
