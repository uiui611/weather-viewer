import indexPage from "../web/index.html";
import mapPage from "../web/map.html";
import { getCatalogResponse, getGridPng, getSourceMetadata } from "./zarr";
import { CATALOG_CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL } from "./protocol";

const port = Number(process.env.PORT ?? 3000);
const configuredBase = process.env.APP_BASE_PATH ?? "/weather-viewer";
const base = `/${configuredBase.replace(/^\/+|\/+$/g, "")}`;

function json(data: unknown, status = 200, cacheControl = "no-store"): Response {
  return Response.json(data, { status, headers: { "Cache-Control": cacheControl } });
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const status = message.startsWith("Unknown") ? 400 : 500;
  console.error(error);
  return json({ error: message }, status);
}

const server = Bun.serve({
  port,
  routes: {
    [base]: indexPage,
    [`${base}/`]: indexPage,
    [`${base}/map`]: mapPage,
    [`${base}/api/catalog`]: {
      async GET() {
        try {
          return json(await getCatalogResponse(), 200, CATALOG_CACHE_CONTROL);
        } catch (error) { return errorResponse(error); }
      },
    },
    [`${base}/api/metadata`]: {
      async GET(request: Request) {
        try {
          const url = new URL(request.url);
          const collection = url.searchParams.get("collection") ?? "";
          const revision = url.searchParams.get("revision") ?? "";
          if (!/^[a-f0-9]{64}$/.test(revision)) return json({ error: "Invalid metadata revision" }, 400);
          return json(await getSourceMetadata(collection, revision), 200, IMMUTABLE_CACHE_CONTROL);
        } catch (error) { return errorResponse(error); }
      },
    },
    [`${base}/api/grid.png`]: {
      async GET(request: Request) {
        try {
          const url = new URL(request.url);
          const dataset = url.searchParams.get("dataset") ?? "";
          const variable = url.searchParams.get("variable") ?? "";
          const rawTime = url.searchParams.get("time") ?? "";
          const time = Number(rawTime);
          const revision = url.searchParams.get("revision") ?? "";
          if (!/^\d+$/.test(rawTime) || !Number.isSafeInteger(time) ||
              !/^[a-f0-9]{64}$/.test(revision) || url.searchParams.has("stride")) {
            return json({ error: "Invalid time/revision; stride is not supported" }, 400);
          }
          return new Response(Uint8Array.from(await getGridPng(dataset, variable, time, revision)), {
            headers: { "Content-Type": "image/png", "Cache-Control": IMMUTABLE_CACHE_CONTROL },
          });
        } catch (error) { return errorResponse(error); }
      },
    },
    [`${base}/healthz`]: () => json({ status: "ok" }),
    [`${base}/og.png`]: () =>
      new Response(Bun.file(new URL("../web/og.png", import.meta.url)), {
        headers: { "Cache-Control": "public, max-age=86400", "Content-Type": "image/png" },
      }),
  },
  fetch() { return new Response("Not Found", { status: 404 }); },
});

console.log(`Weather Zarr Viewer listening on ${server.url.origin}${base}/`);
