// Generic "fast cached read + background regeneration" primitive — the
// reusable infrastructure half of the Services -> Canonical Structured
// Data -> Renderers pattern (see the architecture plan this implements).
// GET /morning is the first consumer; a future page with the same "must
// render instantly, but data may go stale" need should wire through this
// instead of re-deriving its own staleness/in-flight-guard logic.

export interface CachedPageOptions<T extends { generatedAt: string }> {
  /** Reads the persisted value, or null if nothing has been generated yet. */
  read: () => T | null;
  /** Persists a freshly generated value. */
  write: (value: T) => void;
  /** Regenerates the value from scratch — expected to be slow (LLM/API calls). */
  generate: () => Promise<T>;
  /** Whether a given cached value is old enough to warrant background regeneration. */
  isStale: (value: T) => boolean;
}

export interface CachedPage<T extends { generatedAt: string }> {
  ensureFresh(): Promise<T>;
  refreshInBackgroundIfStale(cached: T): void;
  status(): { generatedAt: string | null; regenerating: boolean };
}

/**
 * One cache slot, one in-flight guard. Deliberately module-scoped, in-memory
 * state (matches this codebase's existing single-process, no-lock local-tool
 * model — see founder-server.ts) — not meant to coordinate across multiple
 * server processes.
 */
export function createCachedPage<T extends { generatedAt: string }>(opts: CachedPageOptions<T>): CachedPage<T> {
  let regenerationInFlight = false;

  async function ensureFresh(): Promise<T> {
    const cached = opts.read();
    if (cached) return cached;

    if (regenerationInFlight) {
      // Rare race on the very first request after a cold start — no cached
      // value to fall back to yet, so wait for the in-flight generation.
      while (regenerationInFlight) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const nowCached = opts.read();
      if (nowCached) return nowCached;
    }

    regenerationInFlight = true;
    try {
      const fresh = await opts.generate();
      opts.write(fresh);
      return fresh;
    } finally {
      regenerationInFlight = false;
    }
  }

  function refreshInBackgroundIfStale(cached: T): void {
    if (regenerationInFlight || !opts.isStale(cached)) return;
    regenerationInFlight = true;
    opts
      .generate()
      .then((fresh) => opts.write(fresh))
      .catch((err) => console.error('[cached-page] background regeneration failed:', err))
      .finally(() => {
        regenerationInFlight = false;
      });
  }

  function status(): { generatedAt: string | null; regenerating: boolean } {
    const cached = opts.read();
    return { generatedAt: cached?.generatedAt ?? null, regenerating: regenerationInFlight };
  }

  return { ensureFresh, refreshInBackgroundIfStale, status };
}
