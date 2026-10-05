import { VARIABLE_PRESENTATION } from "../src/protocol";
import { fileURLToPath } from "node:url";

// Synthetic S3 fixture, using Japan's full native lattice and padded edge
// chunks, so extraction is exercised across both latitude/longitude boundaries.
export function startFixture({ forecastMesh = false } = {}) {
  const objects = new Map<string, Uint8Array | (() => Uint8Array)>();
  const requests: string[] = [];
  const put = (key: string, value: unknown) => objects.set(key, new TextEncoder().encode(JSON.stringify(value)));
  const variables = Object.keys(VARIABLE_PRESENTATION);
  const cycles = ["2026100500", "2026100418"];
  for (const collection of ["noaa-gfs", "forecast"]) {
    const mesh = forecastMesh && collection === "forecast";
    const lats = mesh ? Float64Array.from({ length: 3024 }, (_, i) => 47.6 - (i + 0.5) / 120)
      : Float32Array.from({ length: 121 }, (_, i) => 50 - i / 4);
    const lons = mesh ? Float64Array.from({ length: 2400 }, (_, i) => 120 + (i + 0.5) / 80)
      : Float32Array.from({ length: 149 }, (_, i) => 118 + i / 4);
    const timeCount = mesh ? 17 : 2;
    const chunkSize = mesh ? 512 : 100;
    for (const cycle of cycles) {
      const root = `${collection}/${cycle}.zarr`;
      const reference = cycle === cycles[0] ? Date.parse("2026-10-05T00:00:00Z") : Date.parse("2026-10-04T18:00:00Z");
      const metadata: Record<string, unknown> = { ".zattrs": {
        [mesh ? "forecast_reference_time" : "cycle"]: new Date(reference).toISOString(), title: "Fixture GFS" } };
      const addArray = (name: string, shape: number[], chunks: number[], dtype: string, attrs: Record<string, unknown> = {}) => {
        metadata[`${name}/.zarray`] = { zarr_format: 2, shape, chunks, dtype, compressor: null,
          fill_value: -9999, order: "C", filters: null };
        metadata[`${name}/.zattrs`] = attrs;
      };
      for (const [name, vector, dtype] of [
        ["latitude", lats, mesh ? "<f8" : "<f4"], ["longitude", lons, mesh ? "<f8" : "<f4"],
        ["forecast_hour", Int32Array.from({ length: timeCount }, (_, i) => i * 3), "<i4"],
        ["valid_time", BigInt64Array.from({ length: timeCount }, (_, i) => BigInt(reference + i * 3 * 3600000) * 1000000n), "<i8"],
      ] as const) {
        addArray(name, [vector.length], [vector.length], dtype);
        objects.set(`${root}/${name}/0`, new Uint8Array(vector.buffer));
      }
      for (const id of variables) {
        addArray(id, [timeCount, lats.length, lons.length], [1, chunkSize, chunkSize], "<f4", { common_name_ja: id,
          long_name: id, units: id === "air_temperature_2m" ? "K" : id === "mean_sea_level_pressure" ? "Pa" : VARIABLE_PRESENTATION[id]!.displayUnits,
          level: "surface", statistic: "instant" });
        for (let time = 0; time < timeCount; time++) for (let cy = 0; cy < Math.ceil(lats.length / chunkSize); cy++) for (let cx = 0; cx < Math.ceil(lons.length / chunkSize); cx++) {
          // Generate requested chunks lazily so a mesh fixture does not retain
          // every variable and forecast time in memory.
          objects.set(`${root}/${id}/${time}.${cy}.${cx}`, () => {
            const chunk = new Float32Array(chunkSize * chunkSize).fill(-9999);
            for (let y = 0; y < chunkSize; y++) for (let x = 0; x < chunkSize; x++) {
              const row = cy * chunkSize + y, col = cx * chunkSize + x;
              if (row >= lats.length || col >= lons.length) continue;
              const scale = mesh ? 1000 : 10;
              let value = row / scale + col / scale - 5.5 + time;
              if (id === "air_temperature_2m") value += 273.15;
              if (id === "mean_sea_level_pressure") value = (1000.5 + row / scale + col / scale + time) * 100;
              if (row === 0 && col === 0) value = NaN;
              if (row === 0 && col === 1) value = -9999;
              if (row === 0 && col === 2) value = 1e8;
              if (row === 0 && col === 3) value = -1e8;
              chunk[y * chunkSize + x] = value;
            }
            return new Uint8Array(chunk.buffer);
          });
        }
      }
      put(`${root}/.zmetadata`, { zarr_consolidated_format: 1, metadata });
      put(`${root}/.zgroup`, { zarr_format: 2 });
      objects.set(`${root}/_SUCCESS`, new Uint8Array());
    }
  }
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/weather\/?/, ""));
    requests.push(`${key}?${url.searchParams}`);
    if (url.searchParams.has("list-type")) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) =>
        `<Contents><Key>${key}</Key><Size>${typeof bytes === "function" ? 0 : bytes.length}</Size><LastModified>2026-10-05T00:00:00.000Z</LastModified></Contents>`).join("");
      return new Response(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`, { headers: { "Content-Type": "application/xml" } });
    }
    const object = objects.get(key);
    const bytes = typeof object === "function" ? object() : object;
    return bytes ? new Response(Uint8Array.from(bytes)) : new Response("Not found", { status: 404 });
  } });
  return { server, requests };
}

export async function startApp(s3Endpoint: string) {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const app = Bun.spawn([process.execPath, "src/server.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PORT: String(port), S3_ENDPOINT_URL: s3Endpoint,
      S3_BUCKET: "weather", S3_PREFIXES: "noaa-gfs,forecast", AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "fixture-only", AWS_SECRET_ACCESS_KEY: "fixture-only" },
    stdout: "ignore", stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}/weather-viewer`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)) return { app, base };
    if (app.exitCode !== null) throw new Error(await new Response(app.stderr).text());
    await Bun.sleep(50);
  }
  app.kill();
  throw new Error("Fixture application did not start");
}
