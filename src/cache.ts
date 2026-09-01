import type { ResolvedTikTok } from "./tiktok";

export const DEFAULT_CACHE_MAX_ENTRIES = 1_000;

export interface CachedResult extends ResolvedTikTok {
  expiresAt: number;
}

export class TtlCache {
  private readonly entries = new Map<string, CachedResult>();
  private readonly maxEntries: number;

  public constructor(private readonly ttlMs: number, maxEntries = DEFAULT_CACHE_MAX_ENTRIES) {
    this.maxEntries =
      Number.isFinite(maxEntries) && maxEntries >= 0
        ? Math.floor(maxEntries)
        : DEFAULT_CACHE_MAX_ENTRIES;
  }

  public get(key: string, now = Date.now()): CachedResult | undefined {
    const cached = this.entries.get(key);
    if (!cached) {
      return undefined;
    }

    if (cached.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, cached);
    return cached;
  }

  public set(key: string, result: ResolvedTikTok, now = Date.now()): CachedResult {
    const cached: CachedResult = {
      ...result,
      expiresAt: now + Math.max(0, this.ttlMs),
    };

    this.entries.delete(key);
    this.entries.set(key, cached);
    this.prune(now);

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }

      this.entries.delete(oldest.value);
    }

    return cached;
  }

  public clear(): void {
    this.entries.clear();
  }

  public get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, value] of this.entries) {
      if (value.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
