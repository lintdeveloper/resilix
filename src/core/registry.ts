import { systemClock } from "./clock.ts";
import type { Clock } from "./types.ts";

export interface KeyRegistryOptions<T> {
  /** Build the value for a key not yet seen. */
  factory: (key: string) => T;
  /** Hard cap on tracked keys. Least-recently-used beyond this are dropped. Default 1_000. */
  maxKeys?: number;
  /** Drop a key untouched for this long. Default 600_000 (10 min). */
  ttlMs?: number;
  clock?: Clock;
}

/**
 * One policy set per key (host, tenant, endpoint), with bounded growth.
 *
 * The bound matters. Keying a breaker by host and storing it in a plain `Map` is a slow
 * leak the moment keys are attacker- or tenant-influenced — a URL with a random subdomain
 * per request grows the map forever. Both a TTL and a hard cap are enforced, and the sweep
 * is lazy so there is no timer (which would also break on edge runtimes).
 */
export class KeyRegistry<T> {
  private readonly entries = new Map<string, { value: T; touchedAt: number }>();
  private readonly factory: (key: string) => T;
  private readonly maxKeys: number;
  private readonly ttlMs: number;
  private readonly clock: Clock;

  constructor(options: KeyRegistryOptions<T>) {
    this.factory = options.factory;
    this.maxKeys = options.maxKeys ?? 1_000;
    this.ttlMs = options.ttlMs ?? 600_000;
    this.clock = options.clock ?? systemClock;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): T {
    const now = this.clock.now();
    const existing = this.entries.get(key);

    if (existing) {
      if (now - existing.touchedAt <= this.ttlMs) {
        // Re-insert to keep Map iteration order = LRU order.
        this.entries.delete(key);
        existing.touchedAt = now;
        this.entries.set(key, existing);
        return existing.value;
      }
      this.entries.delete(key);
    }

    this.sweep(now);

    const value = this.factory(key);
    this.entries.set(key, { value, touchedAt: now });

    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }

    return value;
  }

  /** Drop expired keys. Map preserves insertion order, so we can stop at the first live one. */
  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.touchedAt <= this.ttlMs) break;
      this.entries.delete(key);
    }
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  clear(): void {
    this.entries.clear();
  }
}
