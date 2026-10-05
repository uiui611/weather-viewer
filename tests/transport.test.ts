import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { AsyncCache } from "../src/cache";
import { encodeGrayscalePng } from "../src/png";
import { parseSourceMetadata, quantize, validateGrid, VARIABLE_PRESENTATION, type SourceMetadata } from "../src/protocol";
import { parseCatalog } from "../web/grid";

// Independently inspect the wire format (including CRC and Sub unfiltering).
export function readPng(png: Uint8Array) {
  const bytes = Buffer.from(png);
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let width = 0, height = 0;
  const compressed: Buffer[] = [];
  const types: string[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    expect(bytes.readUInt32BE(offset + 8 + length)).toBe((crc ^ 0xffffffff) >>> 0);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      expect([...data.subarray(8)]).toEqual([8, 0, 0, 0, 0]);
    }
    if (type === "IDAT") compressed.push(data);
    types.push(type);
    offset += length + 12;
  }
  expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
  const rows = inflateSync(Buffer.concat(compressed));
  expect(rows.length).toBe((width + 1) * height);
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    expect(rows[y * (width + 1)]).toBe(1);
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      pixels[index] = (rows[y * (width + 1) + x + 1]! + (x ? pixels[index - 1]! : 0)) & 255;
    }
  }
  return { width, height, pixels };
}

describe("integer transport", () => {
  test("mesh3 validation preserves cell centers, density and orientation", () => {
    const grid: SourceMetadata["grid"] = {
      shape: [3024, 2400],
      lats: Array.from({ length: 3024 }, (_, i) => 47.6 - (i + 0.5) / 120),
      lons: Array.from({ length: 2400 }, (_, i) => 120 + (i + 0.5) / 80),
    };
    expect(() => validateGrid(grid)).not.toThrow();
    for (const invalid of [
      { ...grid, shape: [2400, 3024] },
      { ...grid, lats: grid.lats.slice(1) },
      { ...grid, lats: [...grid.lats].reverse() },
      { ...grid, lons: [...grid.lons].reverse() },
      { ...grid, lats: grid.lats.map(Math.fround) },
      { ...grid, lats: grid.lats.map((lat) => lat + 1 / 240) },
      { ...grid, lons: grid.lons.map((lon, i) => i === 10 ? NaN : lon) },
      { ...grid, lons: grid.lons.map((lon, i) => i === 10 ? Infinity : lon) },
    ]) expect(() => validateGrid(invalid as SourceMetadata["grid"])).toThrow();
  });

  test("floors physical units, including negative values; reserves 255", () => {
    const temp = VARIABLE_PRESENTATION.air_temperature_2m!.encoding;
    expect(quantize(-1.2, temp)).toBe(78); // -2°C, not -1°C
    expect(quantize(12.99, temp)).toBe(92);
    expect(quantize(-81, temp)).toBe(0);
    expect(quantize(200, temp)).toBe(140);
    for (const value of [null, NaN, Infinity, -Infinity]) expect(quantize(value, temp)).toBe(255);
    const pressure = VARIABLE_PRESENTATION.mean_sea_level_pressure!.encoding;
    expect(quantize(1005.9, pressure)).toBe(155);
    expect(quantize(1200, pressure)).toBe(254);
    for (const { encoding } of Object.values(VARIABLE_PRESENTATION)) {
      expect(quantize(encoding.max, encoding)).toBeLessThan(255);
      expect(quantize(encoding.min, encoding)).toBeGreaterThanOrEqual(0);
    }
  });

  test("PNG preserves every byte with no alpha or color metadata", () => {
    const pixels = Uint8Array.from({ length: 256 * 3 }, (_, i) => i % 256);
    const result = readPng(encodeGrayscalePng(256, 3, pixels));
    expect(result.pixels).toEqual(pixels);
  });

  test("accepts the native contract and rejects unsupported metadata", () => {
    const metadata: SourceMetadata = {
      version: 1, collection: "noaa-gfs", format: "png-grayscale-8", missingValue: 255, rounding: "floor",
      grid: { shape: [121, 149], lats: Array.from({ length: 121 }, (_, i) => 50 - i / 4),
        lons: Array.from({ length: 149 }, (_, i) => 118 + i / 4) },
      variables: [{ id: "air_temperature_2m", label: "気温", longName: "Temperature", sourceUnits: "K",
        level: "2m", statistic: "instant", ...VARIABLE_PRESENTATION.air_temperature_2m! }],
    };
    expect(parseSourceMetadata(metadata, "noaa-gfs")).toBe(metadata);
    expect(() => parseSourceMetadata({ ...metadata, version: 2 }, "noaa-gfs")).toThrow();
    expect(() => parseSourceMetadata({ ...metadata, missingValue: 0 }, "noaa-gfs")).toThrow();
    expect(() => parseSourceMetadata({ ...metadata, grid: { ...metadata.grid, lats: [...metadata.grid.lats].reverse() } }, "noaa-gfs")).toThrow();
    expect(() => parseSourceMetadata({ ...metadata, variables: [{ ...metadata.variables[0], palette: "new" }] }, "noaa-gfs")).toThrow();
    expect(() => parseSourceMetadata(null, "noaa-gfs")).toThrow();
    expect(() => parseCatalog({ version: 1, sources: [], datasets: [{}] })).toThrow();
  });
});

describe("immutable bounded cache", () => {
  test("coalesces requests and retries after a failure", async () => {
    const cache = new AsyncCache<number>(2);
    let calls = 0;
    const create = async () => ++calls;
    expect(await Promise.all([cache.get("a", create), cache.get("a", create)])).toEqual([1, 1]);
    await expect(cache.get("bad", async () => { throw new Error("temporary"); })).rejects.toThrow();
    expect(await cache.get("bad", create)).toBe(2);
  });
  test("evicts the least recently used entry", async () => {
    const cache = new AsyncCache<number>(2);
    let calls = 0;
    const create = async () => ++calls;
    await cache.get("a", create); await cache.get("b", create); await cache.get("a", create);
    await cache.get("c", create);
    expect(await cache.get("a", create)).toBe(1);
    expect(await cache.get("b", create)).toBe(4);
  });
});
