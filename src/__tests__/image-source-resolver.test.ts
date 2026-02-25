import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";

// Hoist mock functions so they can be referenced in vi.mock() factories
const { mockHttpsRequest, mockHttpRequest, mockUseAgent } = vi.hoisted(() => ({
  mockHttpsRequest: vi.fn(),
  mockHttpRequest: vi.fn(),
  mockUseAgent: vi.fn().mockReturnValue({}),
}));

vi.mock("node:fs/promises", () => ({
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:https", () => ({
  request: mockHttpsRequest,
}));

vi.mock("node:http", () => ({
  request: mockHttpRequest,
}));

vi.mock("request-filtering-agent", () => ({
  useAgent: mockUseAgent,
}));

const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedUnlink = vi.mocked(fs.unlink);

import {
  resolveImageSource,
  guessExtensionFromContentType,
  guessExtensionFromMagicBytes,
  mimeSubtypeToExtension,
} from "../services/image-source-resolver.js";
import { MAX_DOWNLOAD_SIZE_BYTES, DOWNLOAD_TIMEOUT_MS, MAX_REDIRECT_HOPS } from "../constants.js";

describe("resolveImageSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedWriteFile.mockResolvedValue(undefined);
    mockedUnlink.mockResolvedValue(undefined);
  });

  describe("filePath source", () => {
    it("returns file source with no cleanup", async () => {
      const result = await resolveImageSource({ filePath: "/path/to/image.png" });
      expect(result.sourceType).toBe("file");
      expect(result.localPath).toBe("/path/to/image.png");
      expect(result.originalSource).toBe("/path/to/image.png");
      expect(result.cleanup).toBeUndefined();
    });

    it("filePath takes precedence over other sources", async () => {
      const result = await resolveImageSource({
        filePath: "/path/to/image.png",
        sourceUrl: "https://example.com/image.png",
        imageBase64: "AAAA",
      });
      expect(result.sourceType).toBe("file");
      expect(result.localPath).toBe("/path/to/image.png");
    });
  });

  describe("dataUrl source", () => {
    it("parses valid data URL and writes temp file", async () => {
      const base64Data = Buffer.from("fake-png-data").toString("base64");
      const dataUrl = `data:image/png;base64,${base64Data}`;
      const result = await resolveImageSource({ dataUrl });

      expect(result.sourceType).toBe("data_url");
      expect(result.localPath).toMatch(/\.png$/);
      expect(result.cleanup).toBeInstanceOf(Function);
      expect(mockedWriteFile).toHaveBeenCalledTimes(1);
      expect(mockedWriteFile).toHaveBeenCalledWith(
        result.localPath,
        expect.any(Buffer)
      );
    });

    it("rejects invalid data URL format", async () => {
      await expect(
        resolveImageSource({ dataUrl: "not-a-data-url" })
      ).rejects.toThrow("Invalid data URL format");
    });

    it("maps jpeg mime subtype to .jpg extension", async () => {
      const base64Data = Buffer.from("fake-jpeg").toString("base64");
      const dataUrl = `data:image/jpeg;base64,${base64Data}`;
      const result = await resolveImageSource({ dataUrl });
      expect(result.localPath).toMatch(/\.jpg$/);
    });
  });

  describe("base64 source", () => {
    it("decodes base64 and writes temp file", async () => {
      // PNG magic bytes
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const base64 = pngHeader.toString("base64");
      const result = await resolveImageSource({ imageBase64: base64 });

      expect(result.sourceType).toBe("base64");
      expect(result.localPath).toMatch(/\.png$/);
      expect(result.cleanup).toBeInstanceOf(Function);
      expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    });

    it("guesses .jpg extension from magic bytes", async () => {
      const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      const base64 = jpegHeader.toString("base64");
      const result = await resolveImageSource({ imageBase64: base64 });
      expect(result.localPath).toMatch(/\.jpg$/);
    });

    it("rejects empty base64 (treated as no source)", async () => {
      await expect(
        resolveImageSource({ imageBase64: "" })
      ).rejects.toThrow("No image source provided");
    });

    it("rejects base64 with invalid characters", async () => {
      await expect(
        resolveImageSource({ imageBase64: "!@#$%^&*()" })
      ).rejects.toThrow("invalid characters");
    });

    it("rejects whitespace-only base64", async () => {
      await expect(
        resolveImageSource({ imageBase64: "   " })
      ).rejects.toThrow("Base64 string is empty");
    });
  });

  describe("no source", () => {
    it("throws when no source provided", async () => {
      await expect(resolveImageSource({})).rejects.toThrow(
        "No image source provided"
      );
    });
  });

  describe("cleanup", () => {
    it("cleanup is idempotent: only one unlink despite two calls", async () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const result = await resolveImageSource({ imageBase64: pngHeader.toString("base64") });

      await result.cleanup!();
      await result.cleanup!();

      expect(mockedUnlink).toHaveBeenCalledTimes(1);
    });

    it("cleanup returns undefined on success", async () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const result = await resolveImageSource({ imageBase64: pngHeader.toString("base64") });

      const warning = await result.cleanup!();
      expect(warning).toBeUndefined();
    });

    it("cleanup returns undefined for ENOENT (file already gone)", async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      mockedUnlink.mockRejectedValueOnce(err);

      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const result = await resolveImageSource({ imageBase64: pngHeader.toString("base64") });

      const warning = await result.cleanup!();
      expect(warning).toBeUndefined();
    });

    it("cleanup returns warning string on non-ENOENT failure", async () => {
      const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      mockedUnlink.mockRejectedValueOnce(err);

      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const result = await resolveImageSource({ imageBase64: pngHeader.toString("base64") });

      const warning = await result.cleanup!();
      expect(warning).toBeDefined();
      expect(warning).toContain("Failed to clean up temp file");
      expect(warning).toContain("EPERM");
    });
  });

  describe("precedence", () => {
    it("sourceUrl takes precedence over dataUrl and imageBase64", async () => {
      // Can't easily test URL fetching here, but verify filePath > sourceUrl
      const result = await resolveImageSource({
        filePath: "/path.png",
        sourceUrl: "https://example.com/image.png",
        dataUrl: "data:image/png;base64,AAAA",
        imageBase64: "AAAA",
      });
      expect(result.sourceType).toBe("file");
    });

    it("dataUrl takes precedence over imageBase64", async () => {
      const base64Data = Buffer.from("fake-png-data").toString("base64");
      const result = await resolveImageSource({
        dataUrl: `data:image/png;base64,${base64Data}`,
        imageBase64: "other-data",
      });
      expect(result.sourceType).toBe("data_url");
    });
  });

  describe("decoded buffer size validation", () => {
    it("rejects base64 that decodes to oversized buffer", async () => {
      const oversized = Buffer.alloc(MAX_DOWNLOAD_SIZE_BYTES + 1, 0x41);
      const base64 = oversized.toString("base64");
      await expect(
        resolveImageSource({ imageBase64: base64 })
      ).rejects.toThrow("exceeding the");
    });

    it("rejects data URL that decodes to oversized buffer", async () => {
      const oversized = Buffer.alloc(MAX_DOWNLOAD_SIZE_BYTES + 1, 0x41);
      const base64 = oversized.toString("base64");
      const dataUrl = `data:image/png;base64,${base64}`;
      await expect(
        resolveImageSource({ dataUrl })
      ).rejects.toThrow("exceeding the");
    });
  });
});

// ─── HTTP mock helper ────────────────────────────────────────────────────────

interface MockHttpOpts {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: Buffer;
  reqError?: string;
  /** Never fires the response callback (simulates hung connection for timeout test) */
  noCallback?: boolean;
}

/**
 * Sets up mockHttpsRequest (or mockHttpRequest) to simulate a single request.
 * Creates a fake IncomingMessage that fires data/end events asynchronously
 * after req.end() is called.
 */
function setupRequestMock(
  mock: ReturnType<typeof vi.fn>,
  opts: MockHttpOpts = {},
): void {
  mock.mockReset();
  mock.mockImplementation((...args: unknown[]) => {
    const callback = args.find((a) => typeof a === "function") as
      | ((res: unknown) => void)
      | undefined;

    const reqErrorHandlers: ((err: Error) => void)[] = [];
    const mockReq = {
      on(event: string, handler: (err: Error) => void) {
        if (event === "error") reqErrorHandlers.push(handler);
        return mockReq;
      },
      destroy: vi.fn(),
      end() {
        if (opts.noCallback) return;

        if (opts.reqError) {
          process.nextTick(() => {
            for (const h of reqErrorHandlers) h(new Error(opts.reqError));
          });
          return;
        }

        const resHandlers: Record<string, Array<(arg?: unknown) => void>> = {};
        const mockRes = {
          statusCode: opts.statusCode ?? 200,
          headers:
            opts.headers !== undefined
              ? opts.headers
              : { "content-type": "image/png" },
          destroy: vi.fn(),
          on(event: string, handler: (arg?: unknown) => void) {
            if (!resHandlers[event]) resHandlers[event] = [];
            resHandlers[event].push(handler);
            return mockRes;
          },
        };

        if (callback) {
          process.nextTick(() => {
            callback(mockRes);
            process.nextTick(() => {
              const defaultBody = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
              const body = opts.body ?? defaultBody;
              for (const h of resHandlers["data"] ?? []) h(body);
              process.nextTick(() => {
                for (const h of resHandlers["end"] ?? []) h();
              });
            });
          });
        }
      },
    };

    return mockReq as unknown;
  });
}

function setupHttpsMock(opts: MockHttpOpts = {}): void {
  setupRequestMock(mockHttpsRequest, opts);
}

// ─── sourceUrl resolution ────────────────────────────────────────────────────

describe("sourceUrl resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedWriteFile.mockResolvedValue(undefined);
    mockedUnlink.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("downloads image from valid HTTPS URL", async () => {
    setupHttpsMock();
    const result = await resolveImageSource({ sourceUrl: "https://example.com/photo.png" });
    expect(result.sourceType).toBe("url");
    expect(result.localPath).toMatch(/\.png$/);
    expect(result.cleanup).toBeInstanceOf(Function);
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
  });

  it("passes SSRF filtering agent to https.request", async () => {
    const fakeAgent = { _ssrfAgent: true };
    mockUseAgent.mockReturnValue(fakeAgent);
    setupHttpsMock();

    await resolveImageSource({ sourceUrl: "https://example.com/photo.png" });

    expect(mockUseAgent).toHaveBeenCalledWith("https://example.com/photo.png");
    const [, options] = mockHttpsRequest.mock.calls[0] as [unknown, { agent: unknown }, unknown];
    expect(options.agent).toBe(fakeAgent);
  });

  it("uses http.request for http: URLs (no SSRF agent)", async () => {
    setupRequestMock(mockHttpRequest);
    const result = await resolveImageSource({ sourceUrl: "http://localhost:3000/photo.png" });
    expect(result.sourceType).toBe("url");
    expect(mockHttpRequest).toHaveBeenCalled();
    expect(mockHttpsRequest).not.toHaveBeenCalled();
    expect(mockUseAgent).not.toHaveBeenCalled();
  });

  it("rejects unsupported protocols (ftp, etc.)", async () => {
    await expect(
      resolveImageSource({ sourceUrl: "ftp://example.com/photo.png" })
    ).rejects.toThrow("Unsupported URL protocol");
  });

  it("throws on HTTP error status", async () => {
    setupHttpsMock({ statusCode: 404 });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/missing.png" })
    ).rejects.toThrow("HTTP 404");
  });

  it("throws on timeout", async () => {
    vi.useFakeTimers();
    setupHttpsMock({ noCallback: true });

    const promise = resolveImageSource({ sourceUrl: "https://example.com/slow.png" });
    const expectation = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS + 1000);
    await expectation;
  });

  it("throws on network error (req.on error)", async () => {
    setupHttpsMock({ reqError: "ECONNREFUSED" });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/down.png" })
    ).rejects.toThrow("Failed to fetch image");
  });

  it("rejects when content-length exceeds limit", async () => {
    setupHttpsMock({
      headers: {
        "content-type": "image/png",
        "content-length": String(MAX_DOWNLOAD_SIZE_BYTES + 1),
      },
    });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/huge.png" })
    ).rejects.toThrow("exceeding the");
  });

  it("rejects when downloaded buffer exceeds limit", async () => {
    const oversized = Buffer.alloc(MAX_DOWNLOAD_SIZE_BYTES + 1, 0x00);
    setupHttpsMock({ body: oversized });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/sneaky-big.png" })
    ).rejects.toThrow("byte limit");
  });

  it("rejects non-image Content-Type", async () => {
    setupHttpsMock({ headers: { "content-type": "text/html" } });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/page.html" })
    ).rejects.toThrow("non-image Content-Type");
  });

  it("rejects application/json Content-Type", async () => {
    setupHttpsMock({ headers: { "content-type": "application/json" } });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/api" })
    ).rejects.toThrow("non-image Content-Type");
  });

  it("accepts application/octet-stream with valid image magic bytes", async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    setupHttpsMock({
      headers: { "content-type": "application/octet-stream" },
      body: pngBuffer,
    });
    const result = await resolveImageSource({ sourceUrl: "https://example.com/binary" });
    expect(result.sourceType).toBe("url");
  });

  it("rejects application/octet-stream with non-image magic bytes", async () => {
    const nonImageBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    setupHttpsMock({
      headers: { "content-type": "application/octet-stream" },
      body: nonImageBuffer,
    });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/binary" })
    ).rejects.toThrow("not a recognized image format");
  });

  it("rejects missing Content-Type with non-image magic bytes", async () => {
    const nonImageBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    setupHttpsMock({ headers: {}, body: nonImageBuffer });
    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/noheader" })
    ).rejects.toThrow("not a recognized image format");
  });

  it("accepts missing Content-Type with image magic bytes (falls back to .png)", async () => {
    setupHttpsMock({ headers: {} });
    const result = await resolveImageSource({ sourceUrl: "https://example.com/noheader" });
    expect(result.sourceType).toBe("url");
    expect(result.localPath).toMatch(/\.png$/);
  });

  it("guesses .jpg extension from Content-Type", async () => {
    setupHttpsMock({ headers: { "content-type": "image/jpeg" } });
    const result = await resolveImageSource({ sourceUrl: "https://example.com/photo.jpg" });
    expect(result.localPath).toMatch(/\.jpg$/);
  });
});

// ─── Redirect following ──────────────────────────────────────────────────────

describe("sourceUrl redirect following", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedWriteFile.mockResolvedValue(undefined);
    mockedUnlink.mockResolvedValue(undefined);
  });

  /**
   * Sets up a redirect chain where the first N calls return 3xx,
   * and the final call returns a 200 with PNG body.
   */
  function setupRedirectChain(
    locations: string[],
    finalOpts: MockHttpOpts = {},
  ): void {
    let callIndex = 0;

    // All calls go through https.request since the chain starts with https:
    mockHttpsRequest.mockReset();
    mockHttpsRequest.mockImplementation((...args: unknown[]) => {
      const callback = args.find((a) => typeof a === "function") as
        | ((res: unknown) => void)
        | undefined;

      const reqErrorHandlers: ((err: Error) => void)[] = [];
      const currentIndex = callIndex++;

      const mockReq = {
        on(event: string, handler: (err: Error) => void) {
          if (event === "error") reqErrorHandlers.push(handler);
          return mockReq;
        },
        destroy: vi.fn(),
        end() {
          const isRedirect = currentIndex < locations.length;
          const resHandlers: Record<string, Array<(arg?: unknown) => void>> = {};

          const mockRes = isRedirect
            ? {
                statusCode: 302,
                headers: { location: locations[currentIndex] },
                destroy: vi.fn(),
                on(event: string, handler: (arg?: unknown) => void) {
                  if (!resHandlers[event]) resHandlers[event] = [];
                  resHandlers[event].push(handler);
                  return mockRes;
                },
              }
            : {
                statusCode: finalOpts.statusCode ?? 200,
                headers: finalOpts.headers ?? { "content-type": "image/png" },
                destroy: vi.fn(),
                on(event: string, handler: (arg?: unknown) => void) {
                  if (!resHandlers[event]) resHandlers[event] = [];
                  resHandlers[event].push(handler);
                  return mockRes;
                },
              };

          if (callback) {
            process.nextTick(() => {
              callback(mockRes);
              process.nextTick(() => {
                if (isRedirect) {
                  // Redirect responses have empty bodies
                  for (const h of resHandlers["end"] ?? []) h();
                } else {
                  const body = finalOpts.body ?? Buffer.from([0x89, 0x50, 0x4e, 0x47]);
                  for (const h of resHandlers["data"] ?? []) h(body);
                  process.nextTick(() => {
                    for (const h of resHandlers["end"] ?? []) h();
                  });
                }
              });
            });
          }
        },
      };

      return mockReq as unknown;
    });
  }

  it("follows a single redirect", async () => {
    setupRedirectChain(["https://cdn.example.com/image.png"]);
    const result = await resolveImageSource({ sourceUrl: "https://example.com/photo.png" });
    expect(result.sourceType).toBe("url");
    expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
  });

  it("follows a chain of redirects", async () => {
    setupRedirectChain([
      "https://cdn1.example.com/redir",
      "https://cdn2.example.com/redir",
      "https://cdn3.example.com/image.png",
    ]);
    const result = await resolveImageSource({ sourceUrl: "https://example.com/photo.png" });
    expect(result.sourceType).toBe("url");
    expect(mockHttpsRequest).toHaveBeenCalledTimes(4); // 3 redirects + 1 final
  });

  it("applies SSRF agent on each hop", async () => {
    const agents = [{ hop: 0 }, { hop: 1 }];
    let agentCallIndex = 0;
    mockUseAgent.mockImplementation(() => agents[agentCallIndex++] ?? {});

    setupRedirectChain(["https://cdn.example.com/image.png"]);
    await resolveImageSource({ sourceUrl: "https://example.com/photo.png" });

    // useAgent called once per https hop
    expect(mockUseAgent).toHaveBeenCalledTimes(2);
    expect(mockUseAgent).toHaveBeenNthCalledWith(1, "https://example.com/photo.png");
    expect(mockUseAgent).toHaveBeenNthCalledWith(2, "https://cdn.example.com/image.png");
  });

  it("throws when exceeding MAX_REDIRECT_HOPS", async () => {
    // Create more redirects than allowed
    const locations = Array.from(
      { length: MAX_REDIRECT_HOPS + 1 },
      (_, i) => `https://hop${i + 1}.example.com/redir`,
    );
    setupRedirectChain(locations);

    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/start" })
    ).rejects.toThrow("Too many redirects");
  });

  it("blocks https: to http: downgrade", async () => {
    setupRedirectChain(["http://insecure.example.com/image.png"]);

    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/photo.png" })
    ).rejects.toThrow("https: to http: is blocked");
  });

  it("throws when redirect has no Location header", async () => {
    // Redirect with no location
    mockHttpsRequest.mockReset();
    mockHttpsRequest.mockImplementation((...args: unknown[]) => {
      const callback = args.find((a) => typeof a === "function") as
        | ((res: unknown) => void)
        | undefined;

      const mockReq = {
        on() { return mockReq; },
        destroy: vi.fn(),
        end() {
          const resHandlers: Record<string, Array<(arg?: unknown) => void>> = {};
          const mockRes = {
            statusCode: 301,
            headers: {}, // no location
            destroy: vi.fn(),
            on(event: string, handler: (arg?: unknown) => void) {
              if (!resHandlers[event]) resHandlers[event] = [];
              resHandlers[event].push(handler);
              return mockRes;
            },
          };

          if (callback) {
            process.nextTick(() => {
              callback(mockRes);
              process.nextTick(() => {
                for (const h of resHandlers["end"] ?? []) h();
              });
            });
          }
        },
      };
      return mockReq as unknown;
    });

    await expect(
      resolveImageSource({ sourceUrl: "https://example.com/photo.png" })
    ).rejects.toThrow("redirect with no Location header");
  });

  it("resolves relative redirect locations", async () => {
    setupRedirectChain(["/new-path/image.png"]);
    const result = await resolveImageSource({ sourceUrl: "https://example.com/old-path" });
    expect(result.sourceType).toBe("url");
    // Second call should use the resolved absolute URL
    const secondCallUrl = mockHttpsRequest.mock.calls[1]?.[0] as string;
    expect(secondCallUrl).toBe("https://example.com/new-path/image.png");
  });
});

// ─── Helper function tests ───────────────────────────────────────────────────

describe("guessExtensionFromContentType", () => {
  it("returns undefined for null", () => {
    expect(guessExtensionFromContentType(null)).toBeUndefined();
  });

  it("returns .png for image/png", () => {
    expect(guessExtensionFromContentType("image/png")).toBe(".png");
  });

  it("returns .jpg for image/jpeg", () => {
    expect(guessExtensionFromContentType("image/jpeg")).toBe(".jpg");
  });

  it("returns .jpg for image/jpg", () => {
    expect(guessExtensionFromContentType("image/jpg")).toBe(".jpg");
  });

  it("returns .webp for image/webp", () => {
    expect(guessExtensionFromContentType("image/webp")).toBe(".webp");
  });

  it("returns .tiff for image/tiff", () => {
    expect(guessExtensionFromContentType("image/tiff")).toBe(".tiff");
  });

  it("returns .gif for image/gif", () => {
    expect(guessExtensionFromContentType("image/gif")).toBe(".gif");
  });

  it("handles Content-Type with charset parameter", () => {
    expect(guessExtensionFromContentType("image/png; charset=utf-8")).toBe(".png");
  });

  it("is case-insensitive", () => {
    expect(guessExtensionFromContentType("IMAGE/PNG")).toBe(".png");
  });

  it("returns undefined for unknown type", () => {
    expect(guessExtensionFromContentType("image/bmp")).toBeUndefined();
  });

  it("returns undefined for non-image type", () => {
    expect(guessExtensionFromContentType("text/html")).toBeUndefined();
  });
});

describe("guessExtensionFromMagicBytes", () => {
  it("detects PNG", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(guessExtensionFromMagicBytes(buf)).toBe(".png");
  });

  it("detects JPEG", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(guessExtensionFromMagicBytes(buf)).toBe(".jpg");
  });

  it("detects WebP (RIFF+WEBP header)", () => {
    const buf = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    expect(guessExtensionFromMagicBytes(buf)).toBe(".webp");
  });

  it("detects GIF", () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38]);
    expect(guessExtensionFromMagicBytes(buf)).toBe(".gif");
  });

  it("detects TIFF (little-endian II)", () => {
    const buf = Buffer.from([0x49, 0x49, 0x2a, 0x00]);
    expect(guessExtensionFromMagicBytes(buf)).toBe(".tiff");
  });

  it("detects TIFF (big-endian MM)", () => {
    const buf = Buffer.from([0x4d, 0x4d, 0x00, 0x2a]);
    expect(guessExtensionFromMagicBytes(buf)).toBe(".tiff");
  });

  it("returns undefined for buffer < 4 bytes", () => {
    expect(guessExtensionFromMagicBytes(Buffer.from([0x89, 0x50]))).toBeUndefined();
  });

  it("returns undefined for empty buffer", () => {
    expect(guessExtensionFromMagicBytes(Buffer.alloc(0))).toBeUndefined();
  });

  it("returns undefined for unknown magic bytes", () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    expect(guessExtensionFromMagicBytes(buf)).toBeUndefined();
  });
});

describe("mimeSubtypeToExtension", () => {
  it("maps jpeg to .jpg", () => {
    expect(mimeSubtypeToExtension("jpeg")).toBe(".jpg");
  });

  it("maps jpg to .jpg", () => {
    expect(mimeSubtypeToExtension("jpg")).toBe(".jpg");
  });

  it("maps png to .png", () => {
    expect(mimeSubtypeToExtension("png")).toBe(".png");
  });

  it("maps webp to .webp", () => {
    expect(mimeSubtypeToExtension("webp")).toBe(".webp");
  });

  it("maps tiff to .tiff", () => {
    expect(mimeSubtypeToExtension("tiff")).toBe(".tiff");
  });

  it("maps gif to .gif", () => {
    expect(mimeSubtypeToExtension("gif")).toBe(".gif");
  });

  it("is case-insensitive", () => {
    expect(mimeSubtypeToExtension("JPEG")).toBe(".jpg");
    expect(mimeSubtypeToExtension("PNG")).toBe(".png");
  });

  it("falls back to .{subtype} for unknown types", () => {
    expect(mimeSubtypeToExtension("bmp")).toBe(".bmp");
    expect(mimeSubtypeToExtension("svg+xml")).toBe(".svg+xml");
  });
});
