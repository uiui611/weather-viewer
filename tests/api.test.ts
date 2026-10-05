import { afterAll, beforeAll, expect, test } from "bun:test";
import { startApp, startFixture } from "./fixture";
import { readPng } from "./transport.test";
import { parseSourceMetadata, type Catalog } from "../src/protocol";

let fixture: ReturnType<typeof startFixture>;
let application: Awaited<ReturnType<typeof startApp>>;
let catalog: Catalog;
beforeAll(async () => {
  fixture = startFixture();
  application = await startApp(fixture.server.url.origin);
  const response = await fetch(`${application.base}/api/catalog`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, max-age=300");
  catalog = await response.json() as Catalog;
}, 15000);
afterAll(async () => {
  application?.app.kill();
  if (application) await application.app.exited;
  fixture?.server.stop(true);
});

test("one versioned metadata document per source, no per-element catalog metadata", async () => {
  expect(catalog.sources.length).toBe(2);
  expect(catalog.datasets.length).toBe(4);
  for (const dataset of catalog.datasets) {
    expect(dataset).not.toHaveProperty("variables");
    expect(dataset.variableIds.length).toBe(7);
  }
  for (const source of catalog.sources) {
    const response = await fetch(`${application.base}/api/metadata?${new URLSearchParams(source)}`);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    const metadata = parseSourceMetadata(await response.json(), source.collection);
    expect(metadata.grid.shape).toEqual([121, 149]);
    expect(metadata.variables.length).toBe(7);
  }
});

test("full-density PNG, missing/fill/clipping, orientation and padded chunks", async () => {
  const source = catalog.sources.find((s) => s.collection === "noaa-gfs")!;
  const params = new URLSearchParams({ dataset: catalog.datasets[0]!.id,
    variable: "air_temperature_2m", time: "0", revision: source.revision });
  // Catalog is sorted by collection; choose the matching source's dataset.
  params.set("dataset", catalog.datasets.find((d) => d.collection === source.collection)!.id);
  const url = `${application.base}/api/grid.png?${params}`;
  const response = await fetch(url);
  expect(response.headers.get("Content-Type")).toBe("image/png");
  expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
  const png = new Uint8Array(await response.arrayBuffer());
  const { width, height, pixels } = readPng(png);
  expect([height, width]).toEqual([121, 149]);
  expect([...pixels.slice(0, 5)]).toEqual([255, 255, 140, 0, 74]);
  expect(pixels[100 * width + 100]).toBe(94); // 14.5°C -> 14; crosses both chunk boundaries
  expect(pixels[120 * width + 148]).toBe(101); // 21.3°C -> 21; padded bottom/right edges
  const upstreamRequests = fixture.requests.length;
  expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(png);
  expect(fixture.requests.length).toBe(upstreamRequests);
  params.set("variable", "mean_sea_level_pressure");
  const pressure = readPng(new Uint8Array(await (await fetch(`${application.base}/api/grid.png?${params}`)).arrayBuffer()));
  expect(pressure.pixels[100 * width + 100]).toBe(170); // 1020.5hPa -> 1020
});

test("invalid inputs and unsupported strides do not get immutable error caching", async () => {
  const source = catalog.sources[0]!;
  for (const extra of [{ time: "NaN" }, { time: "-1" }, { time: "0", stride: "1" }, { time: "999" }] as Record<string, string>[]) {
    const params = new URLSearchParams({ dataset: catalog.datasets[0]!.id,
      variable: "air_temperature_2m", revision: source.revision, ...extra });
    const response = await fetch(`${application.base}/api/grid.png?${params}`);
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  const response = await fetch(`${application.base}/api/metadata?collection=forecast&revision=${"0".repeat(64)}`);
  expect(response.status).toBe(400);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
