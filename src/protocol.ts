// Versioned transport contract shared by the API and browser (no server imports).
export const TRANSPORT_VERSION = 1;
export const MISSING_VALUE = 255;
export const IMMUTABLE_CACHE_CONTROL = "private, max-age=31536000, immutable";
export const CATALOG_CACHE_CONTROL = "private, max-age=300";

export interface Encoding {
  offset: number;
  min: number;
  max: number;
  step: 1;
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
  encoding: Encoding;
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

export type CatalogDataset = Omit<DatasetInfo, "variables" | "root"> & { variableIds: string[] };

export interface SourceMetadata {
  version: 1;
  collection: string;
  format: "png-grayscale-8";
  missingValue: 255;
  rounding: "floor";
  grid: { shape: [number, number]; lats: number[]; lons: number[] };
  variables: VariableInfo[];
}

export interface Catalog {
  version: 1;
  sources: Array<{ collection: string; revision: string }>;
  datasets: CatalogDataset[];
}

export const VARIABLE_PRESENTATION: Record<
  string,
  Pick<VariableInfo, "displayUnits" | "palette" | "domain" | "encoding">
> = {
  air_temperature_2m: {
    displayUnits: "°C", palette: "temperature", domain: [-20, 40],
    encoding: { offset: -80, min: -80, max: 60, step: 1 },
  },
  cloud_area_fraction: {
    displayUnits: "%", palette: "cloud", domain: [0, 100],
    encoding: { offset: 0, min: 0, max: 100, step: 1 },
  },
  eastward_wind_10m: {
    displayUnits: "m/s", palette: "wind", domain: [-30, 30],
    encoding: { offset: -127, min: -127, max: 127, step: 1 },
  },
  mean_sea_level_pressure: {
    displayUnits: "hPa", palette: "pressure", domain: [990, 1020],
    encoding: { offset: 850, min: 850, max: 1104, step: 1 },
  },
  northward_wind_10m: {
    displayUnits: "m/s", palette: "wind", domain: [-30, 30],
    encoding: { offset: -127, min: -127, max: 127, step: 1 },
  },
  precipitation_amount: {
    displayUnits: "mm", palette: "precipitation", domain: [0, 50],
    encoding: { offset: 0, min: 0, max: 254, step: 1 },
  },
  relative_humidity_2m: {
    displayUnits: "%", palette: "humidity", domain: [0, 100],
    encoding: { offset: 0, min: 0, max: 100, step: 1 },
  },
};

export function quantize(value: number | null, encoding: Encoding): number {
  if (value === null || !Number.isFinite(value)) return MISSING_VALUE;
  return Math.min(encoding.max, Math.max(encoding.min, Math.floor(value))) - encoding.offset;
}

export function validateGrid(grid: SourceMetadata["grid"]): void {
  if (!grid || !Array.isArray(grid.shape) || grid.shape.length !== 2 ||
      grid.shape[0] !== 121 || grid.shape[1] !== 149 ||
      !Array.isArray(grid.lats) || !Array.isArray(grid.lons) ||
      grid.lats.length !== 121 || grid.lons.length !== 149 ||
      !grid.lats.every((lat, i) => lat === 50 - i * 0.25) ||
      !grid.lons.every((lon, i) => lon === 118 + i * 0.25)) {
    throw new Error("Unsupported grid: expected north-to-south GFS 0.25° Japan grid (121×149)");
  }
}

export function parseSourceMetadata(value: unknown, collection: string): SourceMetadata {
  if (!value || typeof value !== "object") throw new Error("Unsupported source metadata");
  const data = value as SourceMetadata;
  if (data.version !== TRANSPORT_VERSION || data.collection !== collection ||
      data.format !== "png-grayscale-8" || data.missingValue !== MISSING_VALUE ||
      data.rounding !== "floor" || !Array.isArray(data.variables) || !data.variables.length) {
    throw new Error("Unsupported source metadata");
  }
  validateGrid(data.grid);
  const ids = new Set<string>();
  for (const variable of data.variables) {
    const expected = variable && Object.hasOwn(VARIABLE_PRESENTATION, variable.id)
      ? VARIABLE_PRESENTATION[variable.id] : undefined;
    if (!expected || ids.has(variable.id) ||
        ![variable.label, variable.longName, variable.sourceUnits, variable.displayUnits,
          variable.level, variable.statistic].every((v) => typeof v === "string") ||
        variable.displayUnits !== expected.displayUnits || variable.palette !== expected.palette ||
        !Array.isArray(variable.domain) || variable.domain.length !== 2 ||
        variable.domain[0] !== expected.domain[0] || variable.domain[1] !== expected.domain[1] ||
        !variable.encoding || variable.encoding.step !== 1 ||
        variable.encoding.offset !== expected.encoding.offset ||
        variable.encoding.min !== expected.encoding.min || variable.encoding.max !== expected.encoding.max) {
      throw new Error("Unsupported variable metadata");
    }
    ids.add(variable.id);
  }
  return data;
}
