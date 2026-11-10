/**
 * Upstream responses kept in the function instance's memory for a short while. This sits behind
 * the CDN cache: it absorbs requests the CDN can't (cache misses for different URLs in the same
 * window, concurrent misses) and coalesces concurrent loads of the same key. A failed load is
 * dropped, so the next call retries.
 */
export class Memo<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();

  get(key: string, { ttlMs, now }: { ttlMs: number; now: number }, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    const value = load();
    this.entries.set(key, { at: now, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  /** For tests. */
  clear(): void {
    this.entries.clear();
  }
}
