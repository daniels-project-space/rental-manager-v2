/** Read at most two inputs concurrently, consuming results in input order.
 * Settling rejections immediately prevents a later failure from becoming an
 * unhandled rejection while an earlier read is still pending. The caller
 * retains its existing error handling and ordered state updates. */
export async function* prefetchInOrder<T, R>(
  inputs: readonly T[],
  read: (input: T) => Promise<R>,
): AsyncGenerator<{ input: T; result: PromiseSettledResult<R> }> {
  const start = (input: T): Promise<PromiseSettledResult<R>> =>
    Promise.resolve().then(() => read(input)).then(
      value => ({ status: "fulfilled" as const, value }),
      reason => ({ status: "rejected" as const, reason }),
    );
  const pending: Array<Promise<PromiseSettledResult<R>>> = [];
  let next = 0;
  while (next < Math.min(2, inputs.length)) pending.push(start(inputs[next++]));
  for (const input of inputs) {
    const result = await pending.shift()!;
    if (next < inputs.length) pending.push(start(inputs[next++]));
    yield { input, result };
  }
}
