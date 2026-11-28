// Short-lived in-process cache with single-flight for expensive whole-table figures (counts over ~14M companies take 30-60 s on
// the live server). Concurrent page loads share ONE query instead of each starting their own, and the figure is reused for `ttlMs`.
// A stale value is served while a refresh runs in the background, so only the very first load after start-up waits.
type Entry<T> = { value?: T; at: number; inflight?: Promise<T> };
const store = new Map<string, Entry<unknown>>();

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const e = (store.get(key) as Entry<T> | undefined) ?? { at: 0 };
  store.set(key, e);
  const fresh = e.value !== undefined && Date.now() - e.at < ttlMs;
  if (fresh) return e.value as T;
  e.inflight ??= load()
    .then((v) => {
      e.value = v;
      e.at = Date.now();
      return v;
    })
    .finally(() => {
      e.inflight = undefined;
    });
  if (e.value !== undefined) {
    e.inflight.catch(() => {});
    return e.value; // stale-while-revalidate
  }
  return e.inflight;
}
