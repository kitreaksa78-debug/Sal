/**
 * Run an async worker over a list with a bounded number of parallel tasks.
 * Results keep the input order, and a rejection from any worker rejects the whole call.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;

  const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;

  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
