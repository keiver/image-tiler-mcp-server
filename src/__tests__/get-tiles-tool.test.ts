import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockedRm } = vi.hoisted(() => ({
  mockedRm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", () => ({
  rm: mockedRm,
}));

vi.mock("../services/image-processor.js", () => ({
  listTilesInDirectory: vi.fn(),
  readTileAsBase64: vi.fn(),
}));

import {
  listTilesInDirectory,
  readTileAsBase64,
} from "../services/image-processor.js";
import { registerGetTilesTool } from "../tools/get-tiles.js";
import { createMockServer } from "./helpers/mock-server.js";

const mockedListTiles = vi.mocked(listTilesInDirectory);
const mockedReadBase64 = vi.mocked(readTileAsBase64);

function makeTilePaths(count: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 4);
    const col = i % 4;
    paths.push(
      `/tiles/tile_${String(row).padStart(3, "0")}_${String(col).padStart(3, "0")}.png`
    );
  }
  return paths;
}

describe("registerGetTilesTool", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedRm.mockResolvedValue(undefined);
    mock = createMockServer();
    registerGetTilesTool(mock.server as any);
    mockedReadBase64.mockResolvedValue("AAAA"); // minimal base64
  });

  it("registers the tool with correct name", () => {
    expect(mock.server.registerTool).toHaveBeenCalledWith(
      "tiler_get_tiles",
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("returns up to 5 tiles (max batch)", async () => {
    mockedListTiles.mockResolvedValue(makeTilePaths(20));
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 0, end: undefined },
      {} as any
    );
    const res = result as any;
    // 1 summary text + 5 * (label text + image) = 11 content blocks
    const imageBlocks = res.content.filter((c: any) => c.type === "image");
    expect(imageBlocks).toHaveLength(5);
  });

  it("respects custom start/end range", async () => {
    mockedListTiles.mockResolvedValue(makeTilePaths(20));
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 5, end: 7 },
      {} as any
    );
    const res = result as any;
    const imageBlocks = res.content.filter((c: any) => c.type === "image");
    expect(imageBlocks).toHaveLength(3); // tiles 5, 6, 7
  });

  it("clamps end to totalTiles - 1", async () => {
    mockedListTiles.mockResolvedValue(makeTilePaths(3));
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 0, end: 10 },
      {} as any
    );
    const res = result as any;
    const imageBlocks = res.content.filter((c: any) => c.type === "image");
    expect(imageBlocks).toHaveLength(3);
  });

  it("errors when start >= totalTiles", async () => {
    mockedListTiles.mockResolvedValue(makeTilePaths(5));
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 5, end: undefined },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("out of range");
  });

  it("errors when batch size exceeds MAX_TILES_PER_BATCH", async () => {
    mockedListTiles.mockResolvedValue(makeTilePaths(20));
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 0, end: 5 },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("max batch size is 5");
  });

  it("includes pagination hint when more tiles available", async () => {
    mockedListTiles.mockResolvedValue(makeTilePaths(10));
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 0, end: 4 },
      {} as any
    );
    const res = result as any;
    expect(res.content[0].text).toContain("Next batch");
    expect(res.content[0].text).toContain("start=5");
  });

  it("says 'last batch' when no more tiles", async () => {
    mockedListTiles.mockResolvedValue(makeTilePaths(3));
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 0, end: 2 },
      {} as any
    );
    const res = result as any;
    expect(res.content[0].text).toContain("last batch");
  });

  it("includes tile row/col labels in content", async () => {
    mockedListTiles.mockResolvedValue(makeTilePaths(4));
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 0, end: 0 },
      {} as any
    );
    const res = result as any;
    const labels = res.content.filter(
      (c: any) => c.type === "text" && c.text.includes("Tile 0")
    );
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toContain("row 0");
    expect(labels[0].text).toContain("col 0");
  });

  it("returns image blocks with correct mime type", async () => {
    mockedListTiles.mockResolvedValue(makeTilePaths(4));
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 0, end: 0 },
      {} as any
    );
    const res = result as any;
    const images = res.content.filter((c: any) => c.type === "image");
    expect(images[0].mimeType).toBe("image/png");
    expect(images[0].data).toBe("AAAA");
  });

  it("wraps errors from listTilesInDirectory", async () => {
    mockedListTiles.mockRejectedValue(new Error("Dir not found"));
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/missing", start: 0, end: undefined },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Error retrieving tiles");
    expect(res.content[0].text).toContain("Dir not found");
  });

  it("wraps non-Error throws", async () => {
    mockedListTiles.mockRejectedValue("unexpected");
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 0, end: undefined },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("unexpected");
  });

  it("returns summary with correct tile range info", async () => {
    mockedListTiles.mockResolvedValue(makeTilePaths(10));
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 3, end: 4 },
      {} as any
    );
    const res = result as any;
    expect(res.content[0].text).toContain("tiles 3-4 of 10 total");
  });

  it("errors when end < start", async () => {
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 10, end: 5 },
      {} as any
    );
    const res = result as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("end index (5) must be >= start index (10)");
  });

  it("returns 5 tiles from non-zero start when end is undefined", async () => {
    mockedListTiles.mockResolvedValue(makeTilePaths(20));
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 15, end: undefined },
      {} as any
    );
    const res = result as any;
    const imageBlocks = res.content.filter((c: any) => c.type === "image");
    expect(imageBlocks).toHaveLength(5); // tiles 15-19
    expect(res.content[0].text).toContain("tiles 15-19 of 20 total");
  });

  it("handles malformed tile filename with row=-1, col=-1", async () => {
    mockedListTiles.mockResolvedValue([
      "/tiles/tile_000_000.png",
      "/tiles/corrupted_file.png",
    ]);
    const tool = mock.getTool("tiler_get_tiles")!;
    const result = await tool.handler(
      { tilesDir: "/tiles", start: 1, end: 1 },
      {} as any
    );
    const res = result as any;
    const labels = res.content.filter(
      (c: any) => c.type === "text" && c.text.includes("Tile 1")
    );
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toContain("row -1");
    expect(labels[0].text).toContain("col -1");
  });

  describe("cleanup parameter", () => {
    it("deletes tiles directory on last batch when cleanup=true", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(3));
      const tool = mock.getTool("tiler_get_tiles")!;
      const result = await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 2, cleanup: true },
        {} as any
      );
      const res = result as any;
      expect(mockedRm).toHaveBeenCalledWith(
        expect.stringContaining("tiles"),
        { recursive: true }
      );
      const cleanupMsg = res.content.find(
        (c: any) => c.type === "text" && c.text.includes("cleaned up")
      );
      expect(cleanupMsg).toBeDefined();
    });

    it("does not delete tiles directory on non-last batch when cleanup=true", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(10));
      const tool = mock.getTool("tiler_get_tiles")!;
      await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 4, cleanup: true },
        {} as any
      );
      expect(mockedRm).not.toHaveBeenCalled();
    });

    it("does not delete tiles directory when cleanup=false on last batch", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(3));
      const tool = mock.getTool("tiler_get_tiles")!;
      await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 2, cleanup: false },
        {} as any
      );
      expect(mockedRm).not.toHaveBeenCalled();
    });

    it("does not delete tiles directory when cleanup is omitted", async () => {
      mockedListTiles.mockResolvedValue(makeTilePaths(3));
      const tool = mock.getTool("tiler_get_tiles")!;
      await tool.handler(
        { tilesDir: "/tiles", start: 0, end: 2 },
        {} as any
      );
      expect(mockedRm).not.toHaveBeenCalled();
    });
  });
});
