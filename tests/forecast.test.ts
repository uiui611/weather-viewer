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
    expect(fixture.requests.filter((key) => key.startsWith(`${dataset.id}/air_temperature_2m/16.`)).length).toBe(30);
    // Distinct simultaneous cold requests and a duplicate must preserve pixels
    // without retaining multiple decoded grids or fetching a chunk twice.
    params.set("time", "0");
    const airUrl = `${application.base}/api/grid.png?${params}`;
    params.set("variable", "mean_sea_level_pressure");
    const pressureUrl = `${application.base}/api/grid.png?${params}`;
    const [air, duplicate, pressure] = await Promise.all([airUrl, airUrl, pressureUrl].map(async (url) => {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      return new Uint8Array(await response.arrayBuffer());
    }));
    expect(duplicate).toEqual(air);
    expect(readPng(air!).pixels[3023 * width + 2399]).toBe(79);
    expect(readPng(pressure!).pixels[3023 * width + 2399]).toBe(155);
    expect(fixture.requests.filter((key) => key.startsWith(`${dataset.id}/air_temperature_2m/0.`)).length).toBe(30);
    const gfs = catalog.sources.find((s) => s.collection === "noaa-gfs")!;
    const gfsResponse = await fetch(`${application.base}/api/metadata?${new URLSearchParams(gfs)}`);
    expect(parseSourceMetadata(await gfsResponse.json(), "noaa-gfs").grid.shape).toEqual([121, 149]);
    // Load balancing may route the PNG to a replica with no catalog or source
    // cache. Its first request must read only the requested completed dataset.
    const cold = await startApp(fixture.server.url.origin);
    try {
      const before = fixture.requests.length;
      params.set("variable", "air_temperature_2m");
      const response = await fetch(`${cold.base}/api/grid.png?${params}`);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(air!);
      expect(fixture.requests.slice(before).some((key) => key.includes("list-type"))).toBe(false);
      expect(fixture.requests.slice(before).some((key) => key.startsWith(`${dataset.id}/_SUCCESS?`))).toBe(true);
      const incomplete = catalog.datasets.find((d) => d.collection === "forecast" && d.id !== dataset.id)!;
      fixture.objects.delete(`${incomplete.id}/_SUCCESS`);
      for (const overrides of [
        { dataset: incomplete.id }, { dataset: "other/secret.zarr" },
        { revision: "0".repeat(64) },
      ]) {
        const invalid = new URLSearchParams(params);
        for (const [key, value] of Object.entries(overrides)) invalid.set(key, value);
        const response = await fetch(`${cold.base}/api/grid.png?${invalid}`);
        expect(response.status).toBe(400);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
    } finally {
      cold.app.kill();
      await cold.app.exited;
    }
  } finally {
    application?.app.kill();
    if (application) await application.app.exited;
    fixture.server.stop(true);
  }
}, 30000);
