import { expect, test } from "bun:test";
import { startApp, startFixture } from "./fixture";
import { readPng } from "./transport.test";
import { parseSourceMetadata } from "../src/protocol";
import { parseCatalog } from "../web/grid";

test("catalog, browser metadata and padded PNG support float64 Japan mesh3 alongside GFS", async () => {
  const fixture = startFixture({ forecastMesh: true });
  let application: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    application = await startApp(fixture.server.url.origin);
    const response = await fetch(`${application.base}/api/catalog`);
    expect(response.status).toBe(200);
    const catalog = parseCatalog(await response.json());
    expect(catalog.sources.map((s) => s.collection)).toEqual(["forecast", "noaa-gfs"]);
    expect(catalog.datasets.length).toBe(4);
    const dataset = catalog.datasets.find((d) => d.collection === "forecast")!;
    expect(dataset.cycle).toBe("2026-10-05T00:00:00.000Z");
    expect(dataset.times.length).toBe(17);
    expect(dataset.times[16]).toEqual({ index: 16, forecastHour: 48, validTime: "2026-10-07T00:00:00.000Z" });
    const source = catalog.sources.find((s) => s.collection === "forecast")!;
    const metadataResponse = await fetch(`${application.base}/api/metadata?${new URLSearchParams(source)}`);
    expect(metadataResponse.status).toBe(200);
    const metadata = parseSourceMetadata(await metadataResponse.json(), "forecast");
    expect(metadata.grid.shape).toEqual([3024, 2400]);
    expect(metadata.grid.lats[0]).toBeCloseTo(47.59583333333333, 12);
    expect(metadata.grid.lats.at(-1)).toBeCloseTo(22.404166666666665, 12);
    expect(metadata.grid.lons[0]).toBeCloseTo(120.00625, 12);
    expect(metadata.grid.lons.at(-1)).toBeCloseTo(149.99375, 12);
    expect(metadata.grid.lats[1]).not.toBe(Math.fround(metadata.grid.lats[1]!));
    const params = new URLSearchParams({ dataset: dataset.id, variable: "air_temperature_2m",
      time: "16", revision: source.revision });
    const pngResponse = await fetch(`${application.base}/api/grid.png?${params}`);
    expect(pngResponse.status).toBe(200);
    expect(pngResponse.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    const { width, height, pixels } = readPng(new Uint8Array(await pngResponse.arrayBuffer()));
    expect([height, width]).toEqual(metadata.grid.shape);
    expect([...pixels.slice(0, 5)]).toEqual([255, 255, 140, 0, 90]);
    expect(pixels[512 * width + 512]).toBe(91); // Both chunk boundaries, 11.524 C.
    expect(pixels[3023 * width + 2399]).toBe(95); // Padded south/east corner, 15.922 C.
    expect(fixture.requests.some((key) => key.startsWith(`${dataset.id}/air_temperature_2m/16.5.4?`))).toBe(true);
    const gfs = catalog.sources.find((s) => s.collection === "noaa-gfs")!;
    const gfsResponse = await fetch(`${application.base}/api/metadata?${new URLSearchParams(gfs)}`);
    expect(parseSourceMetadata(await gfsResponse.json(), "noaa-gfs").grid.shape).toEqual([121, 149]);
  } finally {
    application?.app.kill();
    if (application) await application.app.exited;
    fixture.server.stop(true);
  }
}, 30000);
