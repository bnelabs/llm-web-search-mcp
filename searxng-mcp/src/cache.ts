interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class LruCache<T = string> {
  private cache: Map<string, CacheEntry<T>>;
  private maxSize: number;
  private ttlMs: number;

  constructor(options: { maxSize?: number; ttlMinutes?: number } = {}) {
    this.maxSize = options.maxSize || 50;
    this.ttlMs = (options.ttlMinutes || 15) * 60 * 1000;
    this.cache = new Map();
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    // Touch: re-insert to mark as most-recently-used.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.cache.clear();
  }
}
