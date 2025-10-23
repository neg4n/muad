export type PromiseTask<T> = () => Promise<T>;

export async function runPromisePool<T>(
  tasks: PromiseTask<T>[],
  concurrency: number,
): Promise<T[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }

  if (tasks.length === 0) {
    return [];
  }

  const results: T[] = new Array(tasks.length);
  let taskIndex = 0;

  const worker = async () => {
    while (true) {
      const currentIndex = taskIndex++;
      if (currentIndex >= tasks.length) {
        break;
      }

      const task = tasks[currentIndex];
      if (!task) {
        continue;
      }
      results[currentIndex] = await task();
    }
  };

  const poolSize = Math.min(concurrency, tasks.length);
  const workers = Array.from({ length: poolSize }, () => worker());

  await Promise.all(workers);

  return results;
}
