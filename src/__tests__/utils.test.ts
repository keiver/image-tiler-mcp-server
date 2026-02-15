import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockHomedir, mockAccessSync, mockReaddir } = vi.hoisted(() => ({
  mockHomedir: vi.fn().mockReturnValue("/Users/test"),
  mockAccessSync: vi.fn(),
  mockReaddir: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

vi.mock("node:fs", () => ({
  accessSync: mockAccessSync,
}));

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
}));

import { escapeHtml, getDefaultOutputBase, getVersionedOutputDir } from "../utils.js";

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes less-than", () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });

  it("escapes greater-than", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it("escapes double quote", () => {
    expect(escapeHtml('a"b')).toBe("a&quot;b");
  });

  it("escapes single quote", () => {
    expect(escapeHtml("a'b")).toBe("a&#39;b");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("returns string with no special chars unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("escapes all special chars in a mixed string", () => {
    expect(escapeHtml(`<script>alert("x'&'y")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&#39;&amp;&#39;y&quot;)&lt;/script&gt;"
    );
  });

  it("escapes multiple occurrences of the same char", () => {
    expect(escapeHtml("<<>>")).toBe("&lt;&lt;&gt;&gt;");
  });
});

describe("getDefaultOutputBase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHomedir.mockReturnValue("/Users/test");
  });

  it("returns Desktop when it exists", () => {
    mockAccessSync.mockImplementation(() => {});
    expect(getDefaultOutputBase()).toBe("/Users/test/Desktop");
  });

  it("returns Downloads when Desktop does not exist", () => {
    mockAccessSync.mockImplementation((p: string) => {
      if (String(p).includes("Desktop")) throw new Error("not found");
    });
    expect(getDefaultOutputBase()).toBe("/Users/test/Downloads");
  });

  it("returns homedir when neither Desktop nor Downloads exist", () => {
    mockAccessSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(getDefaultOutputBase()).toBe("/Users/test");
  });
});

describe("getVersionedOutputDir", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns _v1 when parent directory does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const result = await getVersionedOutputDir("/some/tiles/photo");
    expect(result).toBe("/some/tiles/photo_v1");
  });

  it("returns _v1 when no versioned dirs exist", async () => {
    mockReaddir.mockResolvedValue(["unrelated"]);
    const result = await getVersionedOutputDir("/some/tiles/photo");
    expect(result).toBe("/some/tiles/photo_v1");
  });

  it("returns _v2 when _v1 exists", async () => {
    mockReaddir.mockResolvedValue(["photo_v1"]);
    const result = await getVersionedOutputDir("/some/tiles/photo");
    expect(result).toBe("/some/tiles/photo_v2");
  });

  it("returns _v4 when _v1 through _v3 exist", async () => {
    mockReaddir.mockResolvedValue(["photo_v1", "photo_v2", "photo_v3"]);
    const result = await getVersionedOutputDir("/some/tiles/photo");
    expect(result).toBe("/some/tiles/photo_v4");
  });

  it("ignores non-numeric suffixes", async () => {
    mockReaddir.mockResolvedValue(["photo_vfoo", "photo_vbar"]);
    const result = await getVersionedOutputDir("/some/tiles/photo");
    expect(result).toBe("/some/tiles/photo_v1");
  });

  it("picks max+1 when versions have gaps", async () => {
    mockReaddir.mockResolvedValue(["photo_v1", "photo_v5"]);
    const result = await getVersionedOutputDir("/some/tiles/photo");
    expect(result).toBe("/some/tiles/photo_v6");
  });
});
