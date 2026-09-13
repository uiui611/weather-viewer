import L, { type LeafletMouseEvent, type Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";
import "./styles.css";

interface VariableInfo {
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

interface DatasetInfo {
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

interface GridData {
  dataset: Pick<DatasetInfo, "id" | "cycle" | "title">;
  variable: VariableInfo;
  time: DatasetInfo["times"][number];
  bounds: { south: number; west: number; north: number; east: number };
  lats: number[];
  lons: number[];
  values: Array<number | null>;
  shape: [number, number];
  stride: number;
}

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const collectionSelect = $<HTMLSelectElement>("#collection-select");
const datasetSelect = $<HTMLSelectElement>("#dataset-select");
const variableSelect = $<HTMLSelectElement>("#variable-select");
const timeRange = $<HTMLInputElement>("#time-range");
const timePrev = $<HTMLButtonElement>("#time-prev");
const timeNext = $<HTMLButtonElement>("#time-next");
const loading = $("#loading");
const errorCard = $("#error");
const basePath = window.location.pathname.replace(/\/map\/?$/, "");

const PALETTES: Record<string, Array<[number, string]>> = {
  temperature: [
    [0, "#2541b2"], [0.17, "#378ce7"], [0.34, "#9ad9ec"], [0.5, "#f7f3c6"],
    [0.66, "#f5ad48"], [0.83, "#df5539"], [1, "#8e1b35"],
  ],
  humidity: [[0, "#f7f4e8"], [0.28, "#c5dec3"], [0.55, "#71b49a"], [0.78, "#287b79"], [1, "#123f58"]],
  cloud: [[0, "#f7f4e8"], [0.3, "#cdd4d1"], [0.6, "#8d9ca0"], [1, "#39494f"]],
  wind: [[0, "#443983"], [0.25, "#3288bd"], [0.5, "#f3f0d1"], [0.75, "#e98b42"], [1, "#b62f3b"]],
  pressure: [
    [0, "#180026"], [0.18, "#253aa8"], [0.42, "#70cbea"], [0.49, "#edf8f5"],
    [0.51, "#fff1a3"], [0.58, "#f29a32"], [0.82, "#d32626"], [1, "#3a0000"],
  ],
  precipitation: [[0, "#edf7e9"], [0.15, "#9adbb4"], [0.35, "#38a6a5"], [0.6, "#2765ad"], [0.8, "#603c9b"], [1, "#ba2f7b"]],
};

let datasets: DatasetInfo[] = [];
let grid: GridData | undefined;
let requestSerial = 0;

const map = L.map("map", {
  center: [36.2, 137.2],
  zoom: 5,
  minZoom: 5,
  maxZoom: 10,
  keyboard: false,
  zoomControl: false,
  attributionControl: false,
  preferCanvas: true,
});

L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", {
  minZoom: 5,
  maxZoom: 18,
  crossOrigin: true,
}).addTo(map);
L.control.zoom({ position: "topright" }).addTo(map);
L.control
  .attribution({ position: "bottomright", prefix: false })
  .addAttribution(
    '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">地理院タイル（国土地理院）</a>',
  )
  .addTo(map);

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function interpolateColor(paletteName: string, normalized: number): string {
  const palette = PALETTES[paletteName] ?? PALETTES.temperature!;
  const value = Math.max(0, Math.min(1, normalized));
  const rightIndex = palette.findIndex(([stop]) => stop >= value);
  if (rightIndex <= 0) return palette[0]![1];
  const [leftStop, leftColor] = palette[rightIndex - 1]!;
  const [rightStop, rightColor] = palette[rightIndex]!;
  const ratio = (value - leftStop) / (rightStop - leftStop || 1);
  const left = hexToRgb(leftColor);
  const right = hexToRgb(rightColor);
  const rgb = left.map((channel, index) => Math.round(channel + (right[index]! - channel) * ratio));
  return `rgb(${rgb.join(",")})`;
}

function normalize(value: number, variable: VariableInfo): number {
  const [min, max] = variable.domain;
  const linear = (value - min) / (max - min);
  if (variable.palette === "pressure") {
    const centered = linear - 0.5;
    return 0.5 + Math.sign(centered) * Math.pow(Math.abs(centered) * 2, 0.55) / 2;
  }
  return variable.palette === "precipitation" ? Math.sqrt(Math.max(0, linear)) : linear;
}

function edges(values: number[]): number[] {
  if (values.length < 2) return values.length ? [values[0]! - 0.125, values[0]! + 0.125] : [];
  const result = [values[0]! + (values[0]! - values[1]!) / 2];
  for (let index = 1; index < values.length; index += 1) {
    result.push((values[index - 1]! + values[index]!) / 2);
  }
  result.push(values.at(-1)! + (values.at(-1)! - values.at(-2)!) / 2);
  return result;
}

class WeatherCanvasLayer extends L.Layer {
  private canvas?: HTMLCanvasElement;
  private map?: LeafletMap;
  private data?: GridData;

  onAdd(mapInstance: LeafletMap): this {
    this.map = mapInstance;
    this.canvas = L.DomUtil.create("canvas", "weather-canvas");
    mapInstance.getPanes().overlayPane.appendChild(this.canvas);
    mapInstance.on("move zoom resize", this.draw, this);
    this.draw();
    return this;
  }

  onRemove(mapInstance: LeafletMap): this {
    this.canvas?.remove();
    mapInstance.off("move zoom resize", this.draw, this);
    return this;
  }

  setData(data: GridData): void {
    this.data = data;
    this.draw();
  }

  sample(lat: number, lon: number): number | null | undefined {
    if (!this.data) return undefined;
    const latIndex = nearestIndex(this.data.lats, lat);
    const lonIndex = nearestIndex(this.data.lons, lon);
    if (latIndex < 0 || lonIndex < 0) return undefined;
    const latStep = Math.abs((this.data.lats[1] ?? lat) - this.data.lats[0]!);
    const lonStep = Math.abs((this.data.lons[1] ?? lon) - this.data.lons[0]!);
    if (Math.abs(this.data.lats[latIndex]! - lat) > latStep || Math.abs(this.data.lons[lonIndex]! - lon) > lonStep) {
      return undefined;
    }
    return this.data.values[latIndex * this.data.shape[1] + lonIndex];
  }

  private draw(): void {
    if (!this.canvas || !this.map) return;
    const size = this.map.getSize();
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = size.x * ratio;
    this.canvas.height = size.y * ratio;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    const topLeft = this.map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, topLeft);
    const context = this.canvas.getContext("2d");
    if (!context || !this.data) return;
    context.scale(ratio, ratio);
    context.globalAlpha = 0.7;
    const latEdges = edges(this.data.lats);
    const lonEdges = edges(this.data.lons);
    const width = this.data.shape[1];
    for (let row = 0; row < this.data.shape[0]; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const value = this.data.values[row * width + column];
        if (value === null || value === undefined) continue;
        const a = this.map.latLngToContainerPoint([latEdges[row]!, lonEdges[column]!]);
        const b = this.map.latLngToContainerPoint([latEdges[row + 1]!, lonEdges[column + 1]!]);
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        context.fillStyle = interpolateColor(this.data.variable.palette, normalize(value, this.data.variable));
        context.fillRect(Math.floor(x), Math.floor(y), Math.ceil(Math.abs(b.x - a.x)) + 1, Math.ceil(Math.abs(b.y - a.y)) + 1);
      }
    }
  }
}

function nearestIndex(values: number[], target: number): number {
  let nearest = -1;
  let distance = Number.POSITIVE_INFINITY;
  values.forEach((value, index) => {
    const candidate = Math.abs(value - target);
    if (candidate < distance) {
      nearest = index;
      distance = candidate;
    }
  });
  return nearest;
}

const weatherLayer = new WeatherCanvasLayer().addTo(map);

function formatCycle(value: string): string {
  const date = new Date(value);
  return `${new Intl.DateTimeFormat("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, timeZone: "UTC" }).format(date)} UTC`;
}

function formatValidTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

function selectedDataset(): DatasetInfo {
  const dataset = datasets.find((entry) => entry.id === datasetSelect.value);
  if (!dataset) throw new Error("データセットが選択されていません");
  return dataset;
}

function populateDatasets(): void {
  const previousCycle = datasets.find((entry) => entry.id === datasetSelect.value)?.cycle;
  const collectionDatasets = datasets.filter(
    (dataset) => dataset.collection === collectionSelect.value,
  );
  datasetSelect.replaceChildren(
    ...collectionDatasets.map(
      (dataset) =>
        new Option(
          `${formatCycle(dataset.cycle)} · ${(dataset.bytes / 1_000_000).toFixed(1)} MB`,
          dataset.id,
        ),
    ),
  );
  const matchingCycle = collectionDatasets.find((dataset) => dataset.cycle === previousCycle);
  if (matchingCycle) datasetSelect.value = matchingCycle.id;
  datasetSelect.disabled = collectionDatasets.length === 0;
}

function populateVariables(): void {
  const dataset = selectedDataset();
  const previous = variableSelect.value;
  variableSelect.replaceChildren(
    ...dataset.variables.map((variable) => new Option(variable.label, variable.id)),
  );
  if (dataset.variables.some((variable) => variable.id === previous)) variableSelect.value = previous;
  variableSelect.disabled = false;
  timeRange.max = String(Math.max(0, dataset.times.length - 1));
  timeRange.value = "0";
  timeRange.disabled = false;
  timePrev.disabled = false;
  timeNext.disabled = false;
  updateTimeLabels();
}

function updateTimeLabels(): void {
  const dataset = selectedDataset();
  const index = Number(timeRange.value);
  const time = dataset.times[index];
  if (!time) return;
  $("#forecast-hour").textContent = `＋${time.forecastHour}h`;
  $("#valid-time").textContent = `有効時刻 ${formatValidTime(time.validTime)} JST`;
  timePrev.disabled = index <= 0;
  timeNext.disabled = index >= dataset.times.length - 1;
}

function stepForecastTime(offset: number): void {
  const current = Number(timeRange.value);
  const next = Math.min(Number(timeRange.max), Math.max(0, current + offset));
  if (next === current) return;
  timeRange.value = String(next);
  void loadGrid();
}

function stepModelCycle(offset: number): void {
  const collectionDatasets = datasets.filter(
    (dataset) => dataset.collection === collectionSelect.value,
  );
  const current = collectionDatasets.findIndex((dataset) => dataset.id === datasetSelect.value);
  const next = Math.min(collectionDatasets.length - 1, Math.max(0, current + offset));
  if (current < 0 || next === current) return;
  datasetSelect.value = collectionDatasets[next]!.id;
  populateVariables();
  void loadGrid();
}

function updateLegend(variable: VariableInfo): void {
  $("#variable-label").textContent = variable.label;
  $("#variable-level").textContent = `${variable.level} · ${variable.statistic}`;
  $("#legend-unit").textContent = variable.displayUnits;
  $("#legend-min").textContent = String(variable.domain[0]);
  $("#legend-max").textContent = String(variable.domain[1]);
  $("#cursor-unit").textContent = variable.displayUnits;
  const palette = PALETTES[variable.palette] ?? PALETTES.temperature!;
  $("#legend-gradient").style.background = `linear-gradient(90deg, ${palette.map(([stop, color]) => `${color} ${stop * 100}%`).join(", ")})`;
}

async function loadGrid(): Promise<void> {
  const serial = ++requestSerial;
  const dataset = selectedDataset();
  const variable = dataset.variables.find((entry) => entry.id === variableSelect.value);
  if (!variable) return;
  updateTimeLabels();
  updateLegend(variable);
  loading.hidden = false;
  errorCard.hidden = true;
  try {
    const params = new URLSearchParams({
      dataset: dataset.id,
      variable: variable.id,
      time: timeRange.value,
      stride: "2",
    });
    const response = await fetch(`${basePath}/api/grid?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    if (serial !== requestSerial) return;
    grid = payload as GridData;
    weatherLayer.setData(grid);
  } catch (error) {
    if (serial !== requestSerial) return;
    errorCard.textContent = error instanceof Error ? error.message : "データを表示できませんでした";
    errorCard.hidden = false;
  } finally {
    if (serial === requestSerial) loading.hidden = true;
  }
}

async function initialize(): Promise<void> {
  try {
    const response = await fetch(`${basePath}/api/catalog`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    datasets = payload.datasets as DatasetInfo[];
    if (!datasets.length) throw new Error("表示できる Zarr データがありません");
    const collections = [...new Set(datasets.map((dataset) => dataset.collection))];
    collectionSelect.replaceChildren(
      ...collections.map((collection) => new Option(collection, collection)),
    );
    collectionSelect.disabled = false;
    populateDatasets();
    $("#connection-label").textContent = `RustFS · ${collections.length} 系列 · ${datasets.length} cycles`;
    populateVariables();
    await loadGrid();
  } catch (error) {
    loading.hidden = true;
    errorCard.textContent = error instanceof Error ? error.message : "初期化に失敗しました";
    errorCard.hidden = false;
    $("#connection-label").textContent = "RustFS 接続エラー";
  }
}

collectionSelect.addEventListener("change", () => {
  populateDatasets();
  populateVariables();
  void loadGrid();
});
datasetSelect.addEventListener("change", () => {
  populateVariables();
  void loadGrid();
});
variableSelect.addEventListener("change", () => void loadGrid());
timeRange.addEventListener("input", updateTimeLabels);
timeRange.addEventListener("change", () => void loadGrid());
timePrev.addEventListener("click", () => stepForecastTime(-1));
timeNext.addEventListener("click", () => stepForecastTime(1));

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  const offsets: Partial<Record<string, () => void>> = {
    ArrowLeft: () => stepForecastTime(-1),
    ArrowRight: () => stepForecastTime(1),
    ArrowUp: () => stepModelCycle(-1),
    ArrowDown: () => stepModelCycle(1),
  };
  const action = offsets[event.key];
  if (!action) return;
  event.preventDefault();
  action();
});

map.on("mousemove", (event: LeafletMouseEvent) => {
  $("#cursor-position").textContent = `${event.latlng.lat.toFixed(2)}°N, ${event.latlng.lng.toFixed(2)}°E`;
  const value = weatherLayer.sample(event.latlng.lat, event.latlng.lng);
  $("#cursor-value").textContent = value === undefined || value === null ? "—" : value.toFixed(1);
});
map.on("mouseout", () => {
  $("#cursor-position").textContent = "地図上にカーソルを移動";
  $("#cursor-value").textContent = "—";
});

void initialize();
