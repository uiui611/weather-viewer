import { expect, test } from "bun:test";
import { startApp, startFixture } from "./fixture";
import { readPng } from "./transport.test";
import type { Catalog } from "../src/protocol";

const root = "noaa-gfs/2026100500.zarr";
const variable = "precipitation_amount";
const chunk = `${root}/${variable}/0.1.1`;

function changeArray(fixture: ReturnType<typeof startFixture>, change: Record<string, unknown>) {
  const key = `${root}/.zmetadata`;
  const document = JSON.parse(new TextDecoder().decode(fixture.objects.get(key) as Uint8Array));
  Object.assign(document.metadata[`${variable}/.zarray`], change);
  fixture.objects.set(key, new TextEncoder().encode(JSON.stringify(document)));
}

async function gridUrl(base: string, time = 0) {
  const catalog = await (await fetch(`${base}/api/catalog`)).json() as Catalog;
  const source = catalog.sources.find((s) => s.collection === "noaa-gfs")!;
  const dataset = catalog.datasets.find((d) => d.id === root)!;
  return `${base}/api/grid.png?${new URLSearchParams({
    dataset: dataset.id, variable, time: String(time), revision: source.revision,
  })}`;
}

for (const fill of ["NaN", -9999, 0]) {
  test(`unwritten f000 precipitation is missing for fill_value ${fill}`, async () => {
    const fixture = startFixture();
    changeArray(fixture, { fill_value: fill });
    for (const key of fixture.objects.keys())
      if (key.startsWith(`${root}/${variable}/0.`)) fixture.objects.delete(key);
    const { app, base } = await startApp(fixture.server.url.origin);
    try {
      const response = await fetch(await gridUrl(base));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      const png = readPng(new Uint8Array(await response.arrayBuffer()));
      expect([png.height, png.width]).toEqual([121, 149]);
      expect(png.pixels.every((value) => value === 255)).toBe(true);
      const next = await fetch(await gridUrl(base, 1));
      expect(next.status).toBe(200);
      const nextPng = readPng(new Uint8Array(await next.arrayBuffer()));
      expect(nextPng.pixels[100 * 149 + 100]).toBe(15);
    } finally {
      app.kill(); await app.exited; fixture.server.stop(true);
    }
  }, 15000);
}

test("a sparse padded edge chunk does not change its neighbors or PNG dimensions", async () => {
  const fixture = startFixture();
  fixture.objects.delete(chunk);
  const { app, base } = await startApp(fixture.server.url.origin);
  try {
    const response = await fetch(await gridUrl(base));
    expect(response.status).toBe(200);
    const { pixels, width, height } = readPng(new Uint8Array(await response.arrayBuffer()));
    expect([height, width]).toEqual([121, 149]);
    expect(pixels[99 * width + 100]).toBe(14);
    expect(pixels[100 * width + 99]).toBe(14);
    for (let row = 100; row < height; row++) for (let col = 100; col < width; col++)
      expect(pixels[row * width + col]).toBe(255);
  } finally {
    app.kill(); await app.exited; fixture.server.stop(true);
  }
}, 15000);

for (const failure of ["denied", "bucket", "network", "corrupt", "fill", "dtype", "compressor", "coordinate", "metadata"]) {
  test(`sparse handling does not hide ${failure} errors`, async () => {
    const fixture = startFixture();
    fixture.objects.delete(chunk);
    if (failure === "denied") fixture.failures.set(chunk, { status: 403, code: "AccessDenied" });
    if (failure === "bucket") fixture.failures.set(chunk, { status: 404, code: "NoSuchBucket" });
    if (failure === "network") fixture.failures.set(chunk, "disconnect");
    if (failure === "corrupt") fixture.objects.set(chunk, new Uint8Array(4));
    if (failure === "fill") changeArray(fixture, { fill_value: null });
    if (failure === "dtype") changeArray(fixture, { dtype: "|u1" });
    if (failure === "compressor") changeArray(fixture, { compressor: { id: "unsupported" } });
    if (failure === "coordinate") fixture.objects.delete(`${root}/latitude/0`);
    if (failure === "metadata") fixture.objects.delete(`${root}/.zmetadata`);
    const { app, base } = await startApp(fixture.server.url.origin);
    try {
      // Fetch the source revision before triggering a failed grid read.
      const url = failure === "coordinate" || failure === "metadata"
        ? `${base}/api/catalog` : await gridUrl(base);
      const response = await fetch(url);
      expect(response.status).toBe(500);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Content-Type")).toContain("application/json");
    } finally {
      app.kill(); await app.exited; fixture.server.stop(true);
    }
  }, 15000);
}
