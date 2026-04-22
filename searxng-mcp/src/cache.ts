export interface CacheEntry {
  value: string;
  expiresAt: number;
}

export class LruCache {
  private cache: Map<string, CacheEntry>;
  private maxSize: number;
  private ttlMs: number;

  constructor(options: { maxSize?: number; ttlMinutes?: number } = {}) {
    this.maxSize = options.maxSize || 50;
    this.ttlMs = (options.ttlMinutes || 15) * 60 * 1000;
    this.cache = new Map();
  }

  private key(url: string, maxTokens: number): string {
    return `${url}:${maxTokens}`;
  }

  get(url: string, maxTokens: number): string | null {
    const k = this.key(url, maxTokens);
    const entry = this.cache.get(k);

    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(k);
      return null;
    }

    return entry.value;
  }

  set(url: string, maxTokens: number, value: string): void {
    const k = this.key(url, maxTokens);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(k, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.cache.clear();
  }
}
