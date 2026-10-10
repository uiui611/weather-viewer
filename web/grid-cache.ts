/** Least recently used cache bounded by retained numeric payload bytes and count. */
export class ByteLruCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;

  constructor(
    readonly maxBytes: number,
    readonly maxEntries: number,
    private readonly sizeOf: (value: T) => number,
  ) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0 ||
        !Number.isInteger(maxEntries) || maxEntries < 0) throw new Error("Invalid cache limits");
  }

  get byteLength(): number { return this.bytes; }
  get size(): number { return this.entries.size; }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    const bytes = this.sizeOf(value);
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error("Invalid cache entry size");
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.bytes -= previous.bytes;
    }
    // Oversized grids can still be displayed, but are never retained in the cache.
    if (bytes > this.maxBytes || this.maxEntries === 0) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }
}
