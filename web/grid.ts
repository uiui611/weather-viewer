import { MISSING_VALUE, TRANSPORT_VERSION, type Catalog, type Encoding } from "../src/protocol";

export function parseCatalog(value: unknown): Catalog {
  if (!value || typeof value !== "object") throw new Error("Unsupported catalog");
  const data = value as Catalog;
  if (data.version !== TRANSPORT_VERSION || !Array.isArray(data.sources) ||
      !Array.isArray(data.datasets)) throw new Error("Unsupported catalog");
  const sources = new Set<string>();
  for (const source of data.sources) {
    if (!source || typeof source.collection !== "string" || !source.collection ||
        !/^[a-f0-9]{64}$/.test(source.revision) || sources.has(source.collection)) {
      throw new Error("Unsupported catalog source");
    }
    sources.add(source.collection);
  }
  const datasets = new Set<string>();
  for (const dataset of data.datasets) {
    if (!dataset || typeof dataset.id !== "string" || datasets.has(dataset.id) ||
        !sources.has(dataset.collection) || typeof dataset.title !== "string" ||
        !Number.isFinite(Date.parse(dataset.cycle)) || !Number.isFinite(dataset.bytes) ||
        !Array.isArray(dataset.variableIds) || !dataset.variableIds.length ||
        !dataset.variableIds.every((id) => typeof id === "string") ||
        new Set(dataset.variableIds).size !== dataset.variableIds.length ||
        !Array.isArray(dataset.times) || !dataset.times.length ||
        !dataset.times.every((time, i) => time && time.index === i &&
          Number.isFinite(time.forecastHour) && Number.isFinite(Date.parse(time.validTime)))) {
      throw new Error("Unsupported catalog dataset");
    }
    datasets.add(dataset.id);
  }
  return data;
}

export async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null);
  return new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
}

export async function decodeGridPng(
  response: Response, shape: [number, number], encoding: Encoding,
): Promise<Uint8Array> {
  if (!response.ok) throw await responseError(response);
  if (response.headers.get("Content-Type")?.split(";")[0] !== "image/png") {
    throw new Error("Unsupported grid response: expected PNG");
  }
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "none",
  });
  try {
    if (bitmap.height !== shape[0] || bitmap.width !== shape[1]) {
      throw new Error("Unsupported PNG grid dimensions");
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvasを利用できません");
    // Decode at native size on an opaque canvas; never resize or blend samples.
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return gridCodesFromRgba(rgba, encoding);
  } finally { bitmap.close(); }
}

/** Retain quantized bytes; restore physical values only when needed. */
export function gridValue(code: number | undefined, offset: number): number | null | undefined {
  return code === undefined ? undefined : code === MISSING_VALUE ? null : code + offset;
}

export function gridCodesFromRgba(rgba: Uint8ClampedArray, encoding: Encoding): Uint8Array {
  if (rgba.length % 4 !== 0) throw new Error("Unsupported PNG grid pixel");
  const codes = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < codes.length; i += 1) {
    const pixel = i * 4;
    const code = rgba[pixel]!;
    if (rgba[pixel + 1] !== code || rgba[pixel + 2] !== code || rgba[pixel + 3] !== 255 ||
        (code !== MISSING_VALUE && (code + encoding.offset < encoding.min ||
          code + encoding.offset > encoding.max))) {
      throw new Error("Unsupported PNG grid pixel");
    }
    codes[i] = code;
  }
  return codes;
}
