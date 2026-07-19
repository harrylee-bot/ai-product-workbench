export class BoundedLruLedger<T> {
  readonly #capacity: number;
  readonly #entries = new Map<string, T>();

  constructor(capacity = 256) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError("LRU ledger capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  get(key: string): T | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  set(key: string, value: T): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
