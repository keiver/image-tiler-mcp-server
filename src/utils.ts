import * as fs from "node:fs";
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
