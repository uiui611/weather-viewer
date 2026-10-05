import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";
import { Blosc } from "numcodecs";
import { createHash } from "node:crypto";
import { AsyncCache } from "./cache";
import { encodeGrayscalePng } from "./png";
import {
  TRANSPORT_VERSION, MISSING_VALUE, VARIABLE_PRESENTATION, quantize, validateGrid,
  type VariableInfo, type DatasetInfo, type SourceMetadata, type Catalog,
} from "./protocol";
export type { VariableInfo, DatasetInfo } from "./protocol";

type JsonRecord = Record<string, unknown>;

interface ZarrArrayMetadata {
  chunks: number[];
  compressor: JsonRecord | null;
  dimension_separator?: "." | "/";
  dtype: string;
  fill_value: number | string | null;
  order: "C" | "F";
  shape: number[];
  zarr_format: number;
}

interface ConsolidatedMetadata {
  metadata: Record<string, JsonRecord>;
  zarr_consolidated_format: number;
}

interface GridResponse {
  variable: VariableInfo;
  lats: number[];
  lons: number[];
  values: Array<number | null>;
  shape: [number, number];
}

const BUCKET = process.env.S3_BUCKET ?? "weather";
const PREFIXES = (process.env.S3_PREFIXES ?? process.env.S3_PREFIX ?? "noaa-gfs,forecast")
  .split(",")
  .map((prefix) => prefix.replace(/^\/+|\/+$/g, "").trim())
  .filter((prefix, index, prefixes) => prefix && prefixes.indexOf(prefix) === index);
const ENDPOINT = process.env.S3_ENDPOINT_URL ?? "http://rustfs.default.svc.cluster.local:9000";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const JAPAN_BOUNDS = { south: 20, west: 118, north: 50, east: 155 };

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  forcePathStyle: true,
});

const metadataCache = new Map<string, ConsolidatedMetadata>();
const byteCache = new Map<string, Uint8Array>();
let catalogCache: { expires: number; datasets: DatasetInfo[] } | undefined;

function asArrayMetadata(value: JsonRecord): ZarrArrayMetadata {
  return value as unknown as ZarrArrayMetadata;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

async function objectBytes(key: string, cache = true): Promise<Uint8Array> {
  if (cache && byteCache.has(key)) return byteCache.get(key)!;
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!result.Body) throw new Error(`RustFS object has no body: ${key}`);
  const bytes = await result.Body.transformToByteArray();
  if (cache) {
    byteCache.set(key, bytes);
    while (byteCache.size > 40) byteCache.delete(byteCache.keys().next().value!);
  }
  return bytes;
}

async function jsonObject<T>(key: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await objectBytes(key))) as T;
}

async function metadata(root: string): Promise<ConsolidatedMetadata> {
  if (!metadataCache.has(root)) {
    metadataCache.set(root, await jsonObject<ConsolidatedMetadata>(`${root}/.zmetadata`));
  }
  return metadataCache.get(root)!;
}

async function decodeChunk(root: string, arrayName: string, chunk: number[]): Promise<Uint8Array> {
  const consolidated = await metadata(root);
  const array = asArrayMetadata(consolidated.metadata[`${arrayName}/.zarray`]!);
  const separator = array.dimension_separator ?? ".";
  const key = `${root}/${arrayName}/${chunk.join(separator)}`;
  const encoded = await objectBytes(key);
  if (!array.compressor) return encoded;
  if (array.compressor.id !== "blosc") {
    throw new Error(`Unsupported Zarr compressor: ${String(array.compressor.id)}`);
  }
  return await Blosc.fromConfig(
    array.compressor as unknown as Parameters<typeof Blosc.fromConfig>[0],
  ).decode(encoded);
}

function typedNumbers(bytes: Uint8Array, dtype: string): number[] {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  switch (dtype) {
    case "<f4":
      return Array.from(new Float32Array(buffer));
    case "<f8":
      return Array.from(new Float64Array(buffer));
    case "<i4":
      return Array.from(new Int32Array(buffer));
    case "<i8":
      return Array.from(new BigInt64Array(buffer), Number);
    default:
      throw new Error(`Unsupported Zarr dtype: ${dtype}`);
  }
}

async function readVector(root: string, name: string): Promise<number[]> {
  const consolidated = await metadata(root);
  const array = asArrayMetadata(consolidated.metadata[`${name}/.zarray`]!);
  return typedNumbers(await decodeChunk(root, name, [0]), array.dtype).slice(0, array.shape[0]);
}

function variableInfo(name: string, attrs: JsonRecord): VariableInfo | undefined {
  const presentation = Object.hasOwn(VARIABLE_PRESENTATION, name) ? VARIABLE_PRESENTATION[name] : undefined;
  if (!presentation) return undefined;
  return {
    id: name,
    label: asString(attrs.common_name_ja, name),
    longName: asString(attrs.long_name, name),
    sourceUnits: asString(attrs.units),
    level: asString(attrs.level),
    statistic: asString(attrs.statistic),
    ...presentation,
  };
}

function transformValue(variable: string, value: number): number {
  if (variable === "air_temperature_2m") return value - 273.15;
  if (variable === "mean_sea_level_pressure") return value / 100;
  return value;
}

async function listObjects(): Promise<_Object[]> {
  const objects: _Object[] = [];
  for (const prefix of PREFIXES) {
    let ContinuationToken: string | undefined;
    do {
      const result = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${prefix}/`, ContinuationToken }),
      );
      objects.push(...(result.Contents ?? []));
      ContinuationToken = result.NextContinuationToken;
    } while (ContinuationToken);
  }
  return objects;
}

export async function getCatalog(force = false): Promise<DatasetInfo[]> {
  if (!force && catalogCache && catalogCache.expires > Date.now()) return catalogCache.datasets;
  const objects = await listObjects();
  const roots = objects
    .map((object) => object.Key ?? "")
    .filter((key) => key.endsWith("/.zgroup"))
    .map((key) => key.slice(0, -"/.zgroup".length))
    .filter((root) => objects.some((object) => object.Key === `${root}/_SUCCESS`));

  const datasets = await Promise.all(
    roots.map(async (root): Promise<DatasetInfo> => {
      const consolidated = await metadata(root);
      const groupAttrs = consolidated.metadata[".zattrs"] ?? {};
      const variables = Object.entries(consolidated.metadata)
        .filter(([key]) => key.endsWith("/.zarray"))
        .map(([key]) => {
          const name = key.slice(0, -"/.zarray".length);
          return variableInfo(name, consolidated.metadata[`${name}/.zattrs`] ?? {});
        })
        .filter((value): value is VariableInfo => value !== undefined);
      const [forecastHours, validTimes] = await Promise.all([
        readVector(root, "forecast_hour"),
        readVector(root, "valid_time"),
      ]);
      const rootObjects = objects.filter((object) => object.Key?.startsWith(`${root}/`));
      return {
        id: root,
        root,
        collection: PREFIXES.find((prefix) => root === prefix || root.startsWith(`${prefix}/`)) ?? "",
        cycle: asString(groupAttrs.cycle, asString(groupAttrs.forecast_reference_time)),
        title: asString(groupAttrs.title, "NOAA NCEP GFS"),
        source: asString(groupAttrs.source),
        bytes: rootObjects.reduce((sum, object) => sum + (object.Size ?? 0), 0),
        modified: rootObjects.reduce(
          (latest, object) => Math.max(latest, object.LastModified?.getTime() ?? 0),
          0,
        )
          ? new Date(
              rootObjects.reduce(
                (latest, object) => Math.max(latest, object.LastModified?.getTime() ?? 0),
                0,
              ),
            ).toISOString()
          : "",
        variables,
        times: forecastHours.map((forecastHour, index) => ({
          index,
          forecastHour,
          validTime: new Date((validTimes[index] ?? 0) / 1_000_000).toISOString(),
        })),
      };
    }),
  );
  datasets.sort((a, b) =>
    a.collection.localeCompare(b.collection) || b.cycle.localeCompare(a.cycle),
  );
  catalogCache = { expires: Date.now() + 300_000, datasets };
  return datasets;
}

async function getGrid(
  datasetId: string,
  variableId: string,
  timeIndex: number,
): Promise<GridResponse> {
  const catalog = await getCatalog();
  const dataset = catalog.find((entry) => entry.id === datasetId);
  if (!dataset) throw new Error("Unknown dataset");
  const variable = dataset.variables.find((entry) => entry.id === variableId);
  if (!variable) throw new Error("Unknown variable");
  const time = dataset.times[timeIndex];
  if (!time) throw new Error("Unknown forecast time");
  const datasetRoot = dataset.root;
  const selectedVariableId = variable.id;

  const consolidated = await metadata(datasetRoot);
  const array = asArrayMetadata(consolidated.metadata[`${selectedVariableId}/.zarray`]!);
  const [allLats, allLons] = await Promise.all([
    readVector(datasetRoot, "latitude"),
    readVector(datasetRoot, "longitude"),
  ]);
  const latIndices = allLats
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => value >= JAPAN_BOUNDS.south && value <= JAPAN_BOUNDS.north);
  const lonIndices = allLons
    .map((raw, index) => ({ value: raw > 180 ? raw - 360 : raw, index }))
    .filter(({ value }) => value >= JAPAN_BOUNDS.west && value <= JAPAN_BOUNDS.east);

  if (array.zarr_format !== 2 || array.order !== "C" || array.shape.length !== 3 ||
      array.chunks.length !== 3 || !array.chunks.every((n) => Number.isInteger(n) && n > 0) ||
      array.shape[0] !== dataset.times.length || array.shape[1] !== allLats.length ||
      array.shape[2] !== allLons.length) throw new Error("Unsupported weather array layout");
  validateGrid({
    shape: [latIndices.length, lonIndices.length],
    lats: latIndices.map(({ value }) => value), lons: lonIndices.map(({ value }) => value),
  });
  const chunks = new Map<string, { values: number[]; shape: number[] }>();
  async function chunkFor(latIndex: number, lonIndex: number) {
    const coords = [
      Math.floor(timeIndex / array.chunks[0]!),
      Math.floor(latIndex / array.chunks[1]!),
      Math.floor(lonIndex / array.chunks[2]!),
    ];
    const key = coords.join(".");
    if (!chunks.has(key)) {
      // Zarr v2 edge chunks are padded to the declared chunk shape, not the
      // remaining array extent. Use the declared strides for pixel offsets.
      const values = typedNumbers(await decodeChunk(datasetRoot, selectedVariableId, coords), array.dtype);
      if (values.length !== array.chunks.reduce((a, b) => a * b, 1)) {
        throw new Error("Unsupported weather chunk size");
      }
      chunks.set(key, { values, shape: array.chunks });
    }
    return { chunk: chunks.get(key)!, coords };
  }

  const values: Array<number | null> = [];
  for (const lat of latIndices) {
    for (const lon of lonIndices) {
      const { chunk, coords } = await chunkFor(lat.index, lon.index);
      const localTime = timeIndex - coords[0]! * array.chunks[0]!;
      const localLat = lat.index - coords[1]! * array.chunks[1]!;
      const localLon = lon.index - coords[2]! * array.chunks[2]!;
      const offset = (localTime * chunk.shape[1]! + localLat) * chunk.shape[2]! + localLon;
      const raw = chunk.values[offset];
      const fill = array.fill_value;
      values.push(raw === undefined || !Number.isFinite(raw) ||
        (typeof fill === "number" && raw === fill) ? null : transformValue(variable.id, raw));
    }
  }

  return {
    variable,
    lats: latIndices.map(({ value }) => value),
    lons: lonIndices.map(({ value }) => value),
    values,
    shape: [latIndices.length, lonIndices.length],
  };
}

const sourceCache = new AsyncCache<{ revision: string; metadata: SourceMetadata }>(64);
const sourceDocuments = new Map<string, SourceMetadata>();
const pngCache = new AsyncCache<Buffer>(256);

async function describeSource(collection: string): Promise<{ revision: string; metadata: SourceMetadata }> {
  const catalog = await getCatalog();
  const dataset = catalog.find((entry) => entry.collection === collection);
  if (!dataset) throw new Error("Unknown collection");
  return sourceCache.get(JSON.stringify([collection, dataset.id]), async () => {
    const [allLats, allLons] = await Promise.all([
      readVector(dataset.root, "latitude"), readVector(dataset.root, "longitude"),
    ]);
    const lats = allLats.filter((lat) => lat >= JAPAN_BOUNDS.south && lat <= JAPAN_BOUNDS.north);
    const lons = allLons.map((lon) => lon > 180 ? lon - 360 : lon)
      .filter((lon) => lon >= JAPAN_BOUNDS.west && lon <= JAPAN_BOUNDS.east);
    const metadata: SourceMetadata = {
      version: TRANSPORT_VERSION, collection, format: "png-grayscale-8",
      missingValue: MISSING_VALUE, rounding: "floor",
      grid: { shape: [lats.length, lons.length], lats, lons },
      variables: dataset.variables,
    };
    validateGrid(metadata.grid);
    const revision = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
    sourceDocuments.set(JSON.stringify([collection, revision]), metadata);
    while (sourceDocuments.size > 64) sourceDocuments.delete(sourceDocuments.keys().next().value!);
    return { revision, metadata };
  });
}

export async function getCatalogResponse(): Promise<Catalog> {
  const datasets = await getCatalog();
  const collections = [...new Set(datasets.map((dataset) => dataset.collection))];
  const sources = await Promise.all(collections.map(async (collection) => {
    const { revision, metadata } = await describeSource(collection);
    for (const dataset of datasets.filter((entry) => entry.collection === collection)) {
      for (const variable of dataset.variables) {
        if (JSON.stringify(variable) !== JSON.stringify(metadata.variables.find((entry) => entry.id === variable.id))) {
          throw new Error(`Unsupported variable metadata in ${dataset.id}`);
        }
      }
    }
    return { collection, revision };
  }));
  return {
    version: TRANSPORT_VERSION, sources,
    datasets: datasets.map(({ variables, root: _root, ...dataset }) => ({
      ...dataset, variableIds: variables.map((variable) => variable.id),
    })),
  };
}

export async function getSourceMetadata(collection: string, revision: string): Promise<SourceMetadata> {
  const cached = sourceDocuments.get(JSON.stringify([collection, revision]));
  if (cached) return cached;
  const current = await describeSource(collection);
  if (current.revision !== revision) throw new Error("Unknown metadata revision; reload the catalog");
  return current.metadata;
}

export function getGridPng(
  datasetId: string, variableId: string, timeIndex: number, revision: string,
): Promise<Buffer> {
  return pngCache.get(JSON.stringify([datasetId, variableId, timeIndex, revision]), async () => {
    const dataset = (await getCatalog()).find((entry) => entry.id === datasetId);
    if (!dataset) throw new Error("Unknown dataset");
    const metadata = await getSourceMetadata(dataset.collection, revision);
    const grid = await getGrid(datasetId, variableId, timeIndex);
    const expectedVariable = metadata.variables.find((entry) => entry.id === variableId);
    if (JSON.stringify(grid.variable) !== JSON.stringify(expectedVariable)) {
      throw new Error("Unsupported variable metadata");
    }
    if (JSON.stringify({ shape: grid.shape, lats: grid.lats, lons: grid.lons }) !== JSON.stringify(metadata.grid)) {
      throw new Error("Unsupported dataset grid");
    }
    const pixels = Uint8Array.from(grid.values, (value) => quantize(value, grid.variable.encoding));
    return encodeGrayscalePng(grid.shape[1], grid.shape[0], pixels);
  });
}
