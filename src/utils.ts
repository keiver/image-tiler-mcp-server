import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TileMetadata, ModelEstimate } from "./types.js";

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Returns a sensible default base directory for output files.
 * Prefers ~/Desktop, falls back to ~/Downloads, then ~.
 */
export function getDefaultOutputBase(): string {
  const desktop = path.join(os.homedir(), "Desktop");
  try {
    fs.accessSync(desktop);
    return desktop;
  } catch {
    // Desktop not available
  }

  const downloads = path.join(os.homedir(), "Downloads");
  try {
    fs.accessSync(downloads);
    return downloads;
  } catch {
    // Downloads not available
  }

  return os.homedir();
}

export function sanitizeHostname(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/\./g, "-").slice(0, 60);
  } catch {
    return "screenshot";
  }
}

export async function getVersionedFilePath(
  dir: string,
  baseName: string,
  ext: string
): Promise<string> {
  let entries: string[] = [];
  try {
    entries = await fsPromises.readdir(dir);
  } catch {
    return path.join(dir, `${baseName}_v1.${ext}`);
  }

  const prefix = `${baseName}_v`;
  let maxVersion = 0;
  for (const entry of entries) {
    if (entry.startsWith(prefix)) {
      const version = parseInt(entry.slice(prefix.length), 10);
      if (!isNaN(version) && version > maxVersion) {
        maxVersion = version;
      }
    }
  }
  return path.join(dir, `${baseName}_v${maxVersion + 1}.${ext}`);
}

export async function getVersionedOutputDir(baseDir: string): Promise<string> {
  const parent = path.dirname(baseDir);
  const baseName = path.basename(baseDir);
  const prefix = `${baseName}_v`;

  let entries: string[] = [];
  try {
    entries = await fsPromises.readdir(parent);
  } catch {
    return `${baseDir}_v1`;
  }

  let maxVersion = 0;
  for (const entry of entries) {
    if (entry.startsWith(prefix)) {
      const version = parseInt(entry.slice(prefix.length), 10);
      if (!isNaN(version) && version > maxVersion) {
        maxVersion = version;
      }
    }
  }

  return `${baseDir}_v${maxVersion + 1}`;
}

export function stripVersionSuffix(name: string): string {
  return name.replace(/_v\d+$/, "");
}

export function formatModelComparisonTable(
  width: number,
  height: number,
  allModels: ModelEstimate[],
  effectiveWidth?: number,
  effectiveHeight?: number,
): string {
  const lines: string[] = [];
  const resized = effectiveWidth != null && effectiveHeight != null &&
    (effectiveWidth !== width || effectiveHeight !== height);
  if (resized) {
    lines.push(`Image: ${width} \u00d7 ${height} \u2192 ${effectiveWidth} \u00d7 ${effectiveHeight}`);
  } else {
    lines.push(`Image: ${width} x ${height}`);
  }
  lines.push("");
  lines.push("  Preset  | Tile Size | Grid   | Tiles | Est. Tokens");
  lines.push("  --------|-----------|--------|-------|------------");

  for (const m of allModels) {
    const preset = m.model.padEnd(7);
    const tile = `${m.tileSize} px`.padStart(7);
    const grid = `${m.cols} x ${m.rows}`.padStart(6);
    const tiles = String(m.tiles).padStart(5);
    const tokens = `~${m.tokens.toLocaleString()}`.padStart(12);
    lines.push(`  ${preset} | ${tile}   | ${grid} | ${tiles} | ${tokens}`);
  }

  return lines.join("\n");
}

export function simulateDownscale(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } {
  if (maxDimension <= 0) return { width, height };
  const longestSide = Math.max(width, height);
  if (longestSide <= maxDimension) return { width, height };
  const scale = maxDimension / longestSide;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Sharp operation timed out after ${ms}ms (${label})`)), ms);
    }),
  ]);
}

export function buildTileHints(metadata: TileMetadata[]): Record<string, number[]> {
  const hints: Record<string, number[]> = {};
  for (const m of metadata) {
    const key = m.isBlank ? "blank" : m.contentHint;
    (hints[key] ??= []).push(m.index);
  }
  return hints;
}
