import { VARIABLE_PRESENTATION } from "../src/protocol";

// Synthetic S3 fixture, using Japan's full native lattice and padded edge
// chunks, so extraction is exercised across both latitude/longitude boundaries.
export function startFixture() {
  const objects = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const put = (key: string, value: unknown) => objects.set(key, new TextEncoder().encode(JSON.stringify(value)));
  const variables = Object.keys(VARIABLE_PRESENTATION);
  const lats = Float32Array.from({ length: 121 }, (_, i) => 50 - i / 4);
  const lons = Float32Array.from({ length: 149 }, (_, i) => 118 + i / 4);
  const cycles = ["2026100500", "2026100418"];
  for (const collection of ["noaa-gfs", "forecast"]) {
    for (const cycle of cycles) {
      const root = `${collection}/${cycle}.zarr`;
      const reference = cycle === cycles[0] ? Date.parse("2026-10-05T00:00:00Z") : Date.parse("2026-10-04T18:00:00Z");
      const metadata: Record<string, unknown> = { ".zattrs": { cycle: new Date(reference).toISOString(), title: "Fixture GFS" } };
      const addArray = (name: string, shape: number[], chunks: number[], dtype: string, attrs: Record<string, unknown> = {}) => {
        metadata[`${name}/.zarray`] = { zarr_format: 2, shape, chunks, dtype, compressor: null,
          fill_value: -9999, order: "C", filters: null };
        metadata[`${name}/.zattrs`] = attrs;
      };
      for (const [name, vector, dtype] of [
        ["latitude", lats, "<f4"], ["longitude", lons, "<f4"],
        ["forecast_hour", new Int32Array([0, 3]), "<i4"],
        ["valid_time", new BigInt64Array([BigInt(reference) * 1000000n, BigInt(reference + 3 * 3600000) * 1000000n]), "<i8"],
      ] as const) {
        addArray(name, [vector.length], [vector.length], dtype);
        objects.set(`${root}/${name}/0`, new Uint8Array(vector.buffer));
      }
      for (const id of variables) {
        addArray(id, [2, 121, 149], [1, 100, 100], "<f4", { common_name_ja: id,
          long_name: id, units: id === "air_temperature_2m" ? "K" : id === "mean_sea_level_pressure" ? "Pa" : VARIABLE_PRESENTATION[id]!.displayUnits,
          level: "surface", statistic: "instant" });
        for (let time = 0; time < 2; time++) for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) {
          const chunk = new Float32Array(100 * 100).fill(-9999);
          for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
            const row = cy * 100 + y, col = cx * 100 + x;
            if (row >= 121 || col >= 149) continue;
            let value = row / 10 + col / 10 - 5.5 + time;
            if (id === "air_temperature_2m") value += 273.15;
            if (id === "mean_sea_level_pressure") value = (1000.5 + row / 10 + col / 10 + time) * 100;
            if (row === 0 && col === 0) value = NaN;
            if (row === 0 && col === 1) value = -9999;
            if (row === 0 && col === 2) value = 1e8;
            if (row === 0 && col === 3) value = -1e8;
            chunk[y * 100 + x] = value;
          }
          objects.set(`${root}/${id}/${time}.${cy}.${cx}`, new Uint8Array(chunk.buffer));
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
        `<Contents><Key>${key}</Key><Size>${bytes.length}</Size><LastModified>2026-10-05T00:00:00.000Z</LastModified></Contents>`).join("");
      return new Response(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`, { headers: { "Content-Type": "application/xml" } });
    }
    const bytes = objects.get(key);
    return bytes ? new Response(Uint8Array.from(bytes)) : new Response("Not found", { status: 404 });
  } });
  return { server, requests };
}

export async function startApp(s3Endpoint: string) {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const app = Bun.spawn([process.execPath, "src/server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
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
