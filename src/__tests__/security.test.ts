import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ALLOWED_DIRS_ENV_VAR, DISABLE_URL_CAPTURE_ENV_VAR } from "../constants.js";

// Mock fs/promises before importing the module under test
vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(),
}));

import * as fsPromises from "node:fs/promises";
import { getAllowedDirs, assertSafePath, isUrlCaptureDisabled } from "../security.js";

const mockRealpath = vi.mocked(fsPromises.realpath);

describe("getAllowedDirs()", () => {
  beforeEach(() => {
    delete process.env[ALLOWED_DIRS_ENV_VAR];
  });

  afterEach(() => {
    delete process.env[ALLOWED_DIRS_ENV_VAR];
  });

  it("returns null when TILER_ALLOWED_DIRS is unset", () => {
    expect(getAllowedDirs()).toBeNull();
  });

  it("returns null when TILER_ALLOWED_DIRS is empty string", () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "";
    expect(getAllowedDirs()).toBeNull();
  });

  it("returns null when TILER_ALLOWED_DIRS is whitespace only", () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "   ";
    expect(getAllowedDirs()).toBeNull();
  });

  it("returns resolved paths for a single directory", () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/tmp/allowed";
    expect(getAllowedDirs()).toEqual(["/tmp/allowed"]);
  });

  it("returns resolved absolute paths for multiple directories", () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/a,/b";
    expect(getAllowedDirs()).toEqual(["/a", "/b"]);
  });

  it("trims whitespace around entries", () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = " /a , /b ";
    expect(getAllowedDirs()).toEqual(["/a", "/b"]);
  });
});

describe("isUrlCaptureDisabled()", () => {
  afterEach(() => {
    delete process.env[DISABLE_URL_CAPTURE_ENV_VAR];
  });

  it("returns false when TILER_DISABLE_URL_CAPTURE is unset", () => {
    delete process.env[DISABLE_URL_CAPTURE_ENV_VAR];
    expect(isUrlCaptureDisabled()).toBe(false);
  });

  it("returns false when TILER_DISABLE_URL_CAPTURE is 0", () => {
    process.env[DISABLE_URL_CAPTURE_ENV_VAR] = "0";
    expect(isUrlCaptureDisabled()).toBe(false);
  });

  it("returns false when TILER_DISABLE_URL_CAPTURE is empty", () => {
    process.env[DISABLE_URL_CAPTURE_ENV_VAR] = "";
    expect(isUrlCaptureDisabled()).toBe(false);
  });

  it("returns true when TILER_DISABLE_URL_CAPTURE=1", () => {
    process.env[DISABLE_URL_CAPTURE_ENV_VAR] = "1";
    expect(isUrlCaptureDisabled()).toBe(true);
  });
});

describe("assertSafePath()", () => {
  beforeEach(() => {
    delete process.env[ALLOWED_DIRS_ENV_VAR];
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env[ALLOWED_DIRS_ENV_VAR];
  });

  // No-op when TILER_ALLOWED_DIRS unset

  it("is a no-op when TILER_ALLOWED_DIRS is unset", async () => {
    await expect(
      assertSafePath("/etc/passwd", "filePath", true)
    ).resolves.toBeUndefined();
    expect(mockRealpath).not.toHaveBeenCalled();
  });

  // mustExist=true (read paths)

  it("allows a path within the allowed directory (mustExist=true)", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    mockRealpath.mockResolvedValue("/allowed/subdir/image.png" as never);

    await expect(
      assertSafePath("/allowed/subdir/image.png", "filePath", true)
    ).resolves.toBeUndefined();
    expect(mockRealpath).toHaveBeenCalledWith("/allowed/subdir/image.png");
  });

  it("allows path that equals the allowed directory exactly (mustExist=true)", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    mockRealpath.mockResolvedValue("/allowed" as never);

    await expect(
      assertSafePath("/allowed", "filePath", true)
    ).resolves.toBeUndefined();
  });

  it("blocks a path outside the allowed directory (mustExist=true)", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    mockRealpath.mockResolvedValue("/etc/passwd" as never);

    await expect(
      assertSafePath("/etc/passwd", "filePath", true)
    ).rejects.toThrow("[TILER_ALLOWED_DIRS]");
  });

  it("blocks a path with a common prefix but not a real subdirectory (mustExist=true)", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    mockRealpath.mockResolvedValue("/allowed-sibling/secret" as never);

    await expect(
      assertSafePath("/allowed-sibling/secret", "filePath", true)
    ).rejects.toThrow("[TILER_ALLOWED_DIRS]");
  });

  it("blocks a symlink pointing outside the allowed directory (mustExist=true)", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    mockRealpath.mockResolvedValue("/secret/file" as never);

    await expect(
      assertSafePath("/allowed/link", "filePath", true)
    ).rejects.toThrow("[TILER_ALLOWED_DIRS]");
  });

  it("throws 'path does not exist' when realpath fails with ENOENT (mustExist=true)", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
    mockRealpath.mockRejectedValue(err as never);

    await expect(
      assertSafePath("/allowed/missing.png", "filePath", true)
    ).rejects.toThrow("path does not exist");
    // Verify the error does NOT have the [TILER_ALLOWED_DIRS] prefix
    mockRealpath.mockRejectedValue(err as never);
    await expect(
      assertSafePath("/allowed/missing.png", "filePath", true)
    ).rejects.not.toThrow("[TILER_ALLOWED_DIRS]");
  });

  it("throws 'path does not exist' when realpath fails with ENOTDIR (mustExist=true)", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    const err = Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    mockRealpath.mockRejectedValue(err as never);

    await expect(
      assertSafePath("/allowed/file/subpath", "filePath", true)
    ).rejects.toThrow("path does not exist");
  });

  it("preserves [TILER_ALLOWED_DIRS] prefix for non-ENOENT realpath failures (mustExist=true)", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    mockRealpath.mockRejectedValue(err as never);

    await expect(
      assertSafePath("/allowed/locked.png", "filePath", true)
    ).rejects.toThrow("[TILER_ALLOWED_DIRS]");
  });

  it("allows path across multiple allowed directories (mustExist=true)", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/a,/b";
    mockRealpath.mockResolvedValue("/b/image.png" as never);

    await expect(
      assertSafePath("/b/image.png", "filePath", true)
    ).resolves.toBeUndefined();
  });

  // mustExist=false (write paths / outputDir)

  it("allows an output path whose existing ancestor is within the allowed directory (mustExist=false)", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    mockRealpath
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as never)
      .mockResolvedValue("/allowed/tiles" as never);

    await expect(
      assertSafePath("/allowed/tiles/new-dir", "outputDir", false)
    ).resolves.toBeUndefined();
  });

  it("treats ENOTDIR during mustExist=false ancestor walk same as ENOENT (walks up)", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    mockRealpath
      .mockRejectedValueOnce(Object.assign(new Error("not a directory"), { code: "ENOTDIR" }) as never)
      .mockResolvedValue("/allowed/file.txt" as never);

    await expect(
      assertSafePath("/allowed/file.txt/subdir", "outputDir", false)
    ).resolves.toBeUndefined();
  });

  it("blocks an output path whose existing ancestor is outside the allowed directory (mustExist=false)", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    mockRealpath
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as never)
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as never)
      .mockResolvedValue("/etc" as never);

    await expect(
      assertSafePath("/etc/tiles/output", "outputDir", false)
    ).rejects.toThrow("[TILER_ALLOWED_DIRS]");
  });

  it("allows output path when directory already exists and is within allowed dir (mustExist=false)", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    mockRealpath.mockResolvedValue("/allowed/existing-dir" as never);

    await expect(
      assertSafePath("/allowed/existing-dir", "outputDir", false)
    ).resolves.toBeUndefined();
  });

  it("error message includes param name and resolved path", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    mockRealpath.mockResolvedValue("/etc/passwd" as never);

    await expect(
      assertSafePath("/etc/passwd", "filePath", true)
    ).rejects.toThrow('"filePath"');

    mockRealpath.mockResolvedValue("/etc/passwd" as never);
    await expect(
      assertSafePath("/etc/passwd", "filePath", true)
    ).rejects.toThrow("/etc/passwd");
  });

  it("error message starts with [TILER_ALLOWED_DIRS] prefix", async () => {
    process.env[ALLOWED_DIRS_ENV_VAR] = "/allowed";
    mockRealpath.mockResolvedValue("/etc/passwd" as never);

    let error: Error | undefined;
    try {
      await assertSafePath("/etc/passwd", "filePath", true);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/^\[TILER_ALLOWED_DIRS\]/);
  });
});
