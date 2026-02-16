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

import { escapeHtml, getDefaultOutputBase, getVersionedOutputDir, sanitizeHostname, getVersionedFilePath } from "../utils.js";

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

describe("sanitizeHostname", () => {
  it("converts dots to hyphens", () => {
    expect(sanitizeHostname("https://example.com/page")).toBe("example-com");
  });

  it("handles subdomains", () => {
    expect(sanitizeHostname("https://www.example.com/page")).toBe("www-example-com");
  });

  it("handles IP addresses", () => {
    expect(sanitizeHostname("https://10.81.1.142:3000/")).toBe("10-81-1-142");
  });

  it("handles localhost", () => {
    expect(sanitizeHostname("http://localhost:3000")).toBe("localhost");
  });

  it("returns fallback for invalid URL", () => {
    expect(sanitizeHostname("not-a-url")).toBe("screenshot");
  });

  it("returns fallback for empty string", () => {
    expect(sanitizeHostname("")).toBe("screenshot");
  });

  it("truncates long hostnames to 60 chars", () => {
    const longHost = "a".repeat(80) + ".com";
    const result = sanitizeHostname(`https://${longHost}/page`);
    expect(result.length).toBeLessThanOrEqual(60);
  });
});

describe("getVersionedFilePath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns _v1 when directory does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const result = await getVersionedFilePath("/some/captures", "example-com", "webp");
    expect(result).toBe("/some/captures/example-com_v1.webp");
  });

  it("returns _v1 when no versioned files exist", async () => {
    mockReaddir.mockResolvedValue(["unrelated.txt"]);
    const result = await getVersionedFilePath("/some/captures", "example-com", "webp");
    expect(result).toBe("/some/captures/example-com_v1.webp");
  });

  it("returns _v2 when _v1 exists", async () => {
    mockReaddir.mockResolvedValue(["example-com_v1.webp"]);
    const result = await getVersionedFilePath("/some/captures", "example-com", "webp");
    expect(result).toBe("/some/captures/example-com_v2.webp");
  });

  it("returns _v4 when _v1 through _v3 exist", async () => {
    mockReaddir.mockResolvedValue([
      "example-com_v1.webp",
      "example-com_v2.webp",
      "example-com_v3.webp",
    ]);
    const result = await getVersionedFilePath("/some/captures", "example-com", "webp");
    expect(result).toBe("/some/captures/example-com_v4.webp");
  });

  it("ignores non-numeric suffixes", async () => {
    mockReaddir.mockResolvedValue(["example-com_vfoo.webp"]);
    const result = await getVersionedFilePath("/some/captures", "example-com", "webp");
    expect(result).toBe("/some/captures/example-com_v1.webp");
  });

  it("picks max+1 when versions have gaps", async () => {
    mockReaddir.mockResolvedValue(["example-com_v1.webp", "example-com_v5.webp"]);
    const result = await getVersionedFilePath("/some/captures", "example-com", "webp");
    expect(result).toBe("/some/captures/example-com_v6.webp");
  });

  it("works with png extension", async () => {
    mockReaddir.mockResolvedValue(["example-com_v1.png"]);
    const result = await getVersionedFilePath("/some/captures", "example-com", "png");
    expect(result).toBe("/some/captures/example-com_v2.png");
  });
});
