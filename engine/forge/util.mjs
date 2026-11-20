/** Helpers shared by the forge adapters and the CLIs. */

/** Process items with bounded concurrency (a weekly run handles dozens of changes: neither serial nor a rate-limit burst). */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** The latest time among the arguments (ISO strings), or null. */
export function latestTime(...times) {
  const valid = times.filter((x) => Number.isFinite(Date.parse(x ?? "")));
  return valid.length ? valid.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
}
