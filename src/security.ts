import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ALLOWED_DIRS_ENV_VAR, DISABLE_URL_CAPTURE_ENV_VAR } from "./constants.js";

/**
 * Returns the list of allowed directories from TILER_ALLOWED_DIRS, or null if unset.
 * Each entry is resolved to an absolute path.
 */
export function getAllowedDirs(): string[] | null {
  const raw = process.env[ALLOWED_DIRS_ENV_VAR];
  if (!raw || raw.trim() === "") return null;
  const dirs = raw
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .map((d) => path.resolve(d));
  return dirs.length > 0 ? dirs : null;
}

/**
 * Returns true when TILER_DISABLE_URL_CAPTURE=1, indicating Chrome URL capture
 * should be disabled (for cloud deployments without network-level Chrome isolation).
 */
export function isUrlCaptureDisabled(): boolean {
  return process.env[DISABLE_URL_CAPTURE_ENV_VAR] === "1";
}

function isWithinAllowedDirs(resolvedPath: string, allowedDirs: string[]): boolean {
  return allowedDirs.some(
    (dir) => resolvedPath === dir || resolvedPath.startsWith(dir + path.sep)
  );
}

/**
 * Asserts that inputPath is within one of the allowed directories.
 * No-op when TILER_ALLOWED_DIRS is unset (preserves backward-compatible local behaviour).
 *
 * @param inputPath  Path to check (will be resolved to absolute).
 * @param param      Parameter name used in error messages.
 * @param mustExist  true for read paths (filePath, tilesDir): resolves symlinks via realpath().
 *                   false for write paths (outputDir): walks up to existing ancestor, realpath()s that.
 */
export async function assertSafePath(
  inputPath: string,
  param: string,
  mustExist: boolean,
): Promise<void> {
  const allowedDirs = getAllowedDirs();
  if (!allowedDirs) return;

  const resolvedInput = path.resolve(inputPath);

  if (mustExist) {
    let realResolved: string;
    try {
      realResolved = await fs.realpath(resolvedInput);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new Error(`"${param}" path does not exist: ${resolvedInput}`);
      }
      throw new Error(
        `[TILER_ALLOWED_DIRS] Cannot verify path for "${param}": ${(err as Error).message}`
      );
    }
    if (!isWithinAllowedDirs(realResolved, allowedDirs)) {
      throw new Error(
        `[TILER_ALLOWED_DIRS] Access denied: "${param}" resolves to "${realResolved}", which is outside the allowed directories.`
      );
    }
    return;
  }

  // mustExist=false (output paths): walk up to find closest existing ancestor, realpath it, then
  // combine with the non-existing suffix to get the effective path for containment checking.
  let current = resolvedInput;
  while (true) {
    try {
      const realAncestor = await fs.realpath(current);
      const remaining = resolvedInput.slice(current.length);
      const effectivePath = realAncestor + remaining;
      if (!isWithinAllowedDirs(effectivePath, allowedDirs)) {
        throw new Error(
          `[TILER_ALLOWED_DIRS] Access denied: "${param}" resolves to "${effectivePath}", which is outside the allowed directories.`
        );
      }
      return;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("[TILER_ALLOWED_DIRS]")) {
        throw err;
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new Error(
          `[TILER_ALLOWED_DIRS] Cannot verify path for "${param}": ${(err as Error).message}`
        );
      }
      // Path segment doesn't exist yet: walk up to parent
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached filesystem root without finding an existing ancestor
        if (!isWithinAllowedDirs(resolvedInput, allowedDirs)) {
          throw new Error(
            `[TILER_ALLOWED_DIRS] Access denied: "${param}" path "${resolvedInput}" is outside the allowed directories.`
          );
        }
        return;
      }
      current = parent;
    }
  }
}
