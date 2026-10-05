// Immutable entries stay until LRU eviction. Concurrent requests share work;
// failed entries are removed so a transient storage error can be retried.
export class AsyncCache<T> {
  private entries = new Map<string, Promise<T>>();
  constructor(private readonly limit: number) {}

  get(key: string, create: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const promise = Promise.resolve().then(create);
    this.entries.set(key, promise);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    void promise.catch(() => {
      if (this.entries.get(key) === promise) this.entries.delete(key);
    });
    return promise;
  }
}

// Distinct cold PNG requests must not multiply the decoder's working memory.
// Rejections release the queue too; cached requests bypass it entirely.
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(create: () => Promise<T>): Promise<T> {
    const result = this.tail.then(create);
    this.tail = result.catch(() => {});
    return result;
  }
}
