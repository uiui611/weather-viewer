import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";
import { Blosc } from "numcodecs";

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

export interface VariableInfo {
  id: string;
  label: string;
  longName: string;
  sourceUnits: string;
  displayUnits: string;
  level: string;
  statistic: string;
  palette: string;
  domain: [number, number];
}

export interface DatasetInfo {
  id: string;
  root: string;
  collection: string;
  cycle: string;
  title: string;
  source: string;
  bytes: number;
  modified: string;
  variables: VariableInfo[];
  times: Array<{ index: number; forecastHour: number; validTime: string }>;
}

export interface GridResponse {
  dataset: Pick<DatasetInfo, "id" | "cycle" | "title">;
  variable: VariableInfo;
  time: DatasetInfo["times"][number];
  bounds: { south: number; west: number; north: number; east: number };
  lats: number[];
  lons: number[];
  values: Array<number | null>;
  shape: [number, number];
  stride: number;
  projection: {
    data: string;
    map: string;
    method: string;
  };
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

const VARIABLE_PRESENTATION: Record<
  string,
  Pick<VariableInfo, "displayUnits" | "palette" | "domain">
> = {
  air_temperature_2m: { displayUnits: "°C", palette: "temperature", domain: [-20, 40] },
  cloud_area_fraction: { displayUnits: "%", palette: "cloud", domain: [0, 100] },
  eastward_wind_10m: { displayUnits: "m/s", palette: "wind", domain: [-30, 30] },
  mean_sea_level_pressure: { displayUnits: "hPa", palette: "pressure", domain: [990, 1020] },
  northward_wind_10m: { displayUnits: "m/s", palette: "wind", domain: [-30, 30] },
  precipitation_amount: { displayUnits: "mm", palette: "precipitation", domain: [0, 50] },
  relative_humidity_2m: { displayUnits: "%", palette: "humidity", domain: [0, 100] },
};

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
  const presentation = VARIABLE_PRESENTATION[name];
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
  catalogCache = { expires: Date.now() + 60_000, datasets };
  return datasets;
}

export async function getGrid(
  datasetId: string,
  variableId: string,
  timeIndex: number,
  stride: number,
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
    .filter(({ value }) => value >= JAPAN_BOUNDS.south && value <= JAPAN_BOUNDS.north)
    .filter((_, index) => index % stride === 0);
  const lonIndices = allLons
    .map((raw, index) => ({ value: raw > 180 ? raw - 360 : raw, index }))
    .filter(({ value }) => value >= JAPAN_BOUNDS.west && value <= JAPAN_BOUNDS.east)
    .filter((_, index) => index % stride === 0);

  const chunks = new Map<string, { values: number[]; shape: number[] }>();
  async function chunkFor(latIndex: number, lonIndex: number) {
    const coords = [
      Math.floor(timeIndex / array.chunks[0]!),
      Math.floor(latIndex / array.chunks[1]!),
      Math.floor(lonIndex / array.chunks[2]!),
    ];
    const key = coords.join(".");
    if (!chunks.has(key)) {
      const shape = coords.map((coord, axis) =>
        Math.min(array.chunks[axis]!, array.shape[axis]! - coord * array.chunks[axis]!),
      );
      chunks.set(key, {
        values: typedNumbers(await decodeChunk(datasetRoot, selectedVariableId, coords), array.dtype),
        shape,
      });
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
      values.push(raw === undefined || Number.isNaN(raw) ? null : transformValue(variable.id, raw));
    }
  }

  return {
    dataset: { id: dataset.id, cycle: dataset.cycle, title: dataset.title },
    variable,
    time,
    bounds: JAPAN_BOUNDS,
    lats: latIndices.map(({ value }) => value),
    lons: lonIndices.map(({ value }) => value),
    values,
    shape: [latIndices.length, lonIndices.length],
    stride,
    projection: {
      data: "Geographic latitude/longitude grid (GFS 0.25 degree)",
      map: "Web Mercator tiles (GSI Maps)",
      method: "Each grid-cell corner is projected from latitude/longitude by Leaflet before drawing.",
    },
  };
}

export const storageConfig = {
  bucket: BUCKET,
  prefixes: PREFIXES,
  bounds: JAPAN_BOUNDS,
};
