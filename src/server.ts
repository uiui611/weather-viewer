import indexPage from "../web/index.html";
import mapPage from "../web/map.html";
import { getCatalog, getGrid, storageConfig } from "./zarr";

const port = Number(process.env.PORT ?? 3000);
const configuredBase = process.env.APP_BASE_PATH ?? "/weather-viewer";
const base = `/${configuredBase.replace(/^\/+|\/+$/g, "")}`;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
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
          return json({
            datasets: await getCatalog(),
            storage: storageConfig,
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    [`${base}/api/grid`]: {
      async GET(request: Request) {
        try {
          const url = new URL(request.url);
          const dataset = url.searchParams.get("dataset") ?? "";
          const variable = url.searchParams.get("variable") ?? "";
          const time = Number(url.searchParams.get("time") ?? 0);
          const stride = Math.min(8, Math.max(1, Number(url.searchParams.get("stride") ?? 2)));
          if (!Number.isInteger(time) || !Number.isInteger(stride)) {
            return json({ error: "time and stride must be integers" }, 400);
          }
          return json(await getGrid(dataset, variable, time, stride));
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    [`${base}/healthz`]: () => json({ status: "ok" }),
    [`${base}/og.png`]: () =>
      new Response(Bun.file(new URL("../web/og.png", import.meta.url)), {
        headers: { "Cache-Control": "public, max-age=86400", "Content-Type": "image/png" },
      }),
  },
  fetch(request) {
    const url = new URL(request.url);
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Weather Zarr Viewer listening on ${server.url.origin}${base}/`);
