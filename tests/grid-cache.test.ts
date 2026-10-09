import { describe, expect, test } from "bun:test";
import { ByteLruCache } from "../web/grid-cache";
import { gridCodesFromRgba, gridValue } from "../web/grid";
import { VARIABLE_PRESENTATION } from "../src/protocol";

describe("browser grid cache", () => {
  test("mixed sizes obey byte budget and hits promote the LRU entry", () => {
    const cache = new ByteLruCache<Uint8Array>(10, 128, (v) => v.byteLength);
    const first = new Uint8Array(3);
    cache.set("a", first);
    cache.set("b", new Uint8Array(4));
    expect(cache.get("a")).toBe(first);
    cache.set("c", new Uint8Array(5));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(first);
    expect(cache.byteLength).toBe(8);
    cache.set("d", new Uint8Array(7));
    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.byteLength).toBe(7);
  });

  test("count limit, replacement accounting, and oversized entries", () => {
    const cache = new ByteLruCache<Uint8Array>(10, 2, (v) => v.byteLength);
    cache.set("a", new Uint8Array(2));
    cache.set("b", new Uint8Array(2));
    cache.set("a", new Uint8Array(3));
    expect(cache.byteLength).toBe(5);
    cache.set("c", new Uint8Array(1));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size).toBe(2);
    cache.set("a", new Uint8Array(11));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")?.byteLength).toBe(1);
    expect(cache.byteLength).toBe(1);
  });

  test("native mesh3 grids remain bounded during repeated time/variable changes", () => {
    const cache = new ByteLruCache<Uint8Array>(64 * 1024 * 1024, 128, (v) => v.byteLength);
    for (let i = 0; i < 40; i++) {
      cache.set(String(i), new Uint8Array(3024 * 2400));
      expect(cache.byteLength).toBeLessThanOrEqual(cache.maxBytes);
    }
    expect(cache.size).toBe(9);
    expect(cache.get("0")).toBeUndefined();
    expect(cache.get("39")?.byteLength).toBe(7257600);
  });
});

test("8bit codes preserve missing values, negative offsets, and physical palette inputs", () => {
  const encoding = VARIABLE_PRESENTATION.air_temperature_2m!.encoding;
  const codes = [0, 60, 100, 255];
  const rgba = new Uint8ClampedArray(codes.flatMap((code) => [code, code, code, 255]));
  const packed = gridCodesFromRgba(rgba, encoding);
  expect(packed).toBeInstanceOf(Uint8Array);
  expect(packed.byteLength).toBe(codes.length);
  expect([...packed]).toEqual(codes);
  expect([...packed].map((code) => gridValue(code, encoding.offset)))
    .toEqual(codes.map((code) => code === 255 ? null : code + encoding.offset));
  expect(gridValue(undefined, encoding.offset)).toBeUndefined();
  rgba[1] = 1;
  expect(() => gridCodesFromRgba(rgba, encoding)).toThrow();
});
