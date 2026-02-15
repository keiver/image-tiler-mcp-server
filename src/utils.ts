import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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
