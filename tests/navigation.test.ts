import { expect, test } from "bun:test";
import { startApp } from "./fixture";

for (const basePath of ["/weather-viewer", "/custom/weather"]) {
  test(`top entries resolve the map under ${basePath}`, async () => {
    const { app, base } = await startApp("http://127.0.0.1:1", basePath);
    try {
      const redirect = await fetch(`${base}?from=readme`, { redirect: "manual" });
      expect(redirect.status).toBe(308);
      expect(redirect.headers.get("Location")).toBe(`${base}/?from=readme`);
      for (const entry of [base, `${base}/`]) {
        const top = await fetch(entry);
        expect(top.status).toBe(200);
        expect(top.url).toBe(`${base}/`);
        const html = await top.text();
        const href = html.match(/<a\b[^>]*class="map-link"[^>]*href="([^"]+)"/)?.[1];
        expect(href).toBeDefined();
        const map = new URL(href!, top.url);
        expect(map.href).toBe(`${base}/map`);
        const response = await fetch(map);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('id="map"');
      }
    } finally {
      app.kill();
      await app.exited;
    }
  }, 15000);
}
