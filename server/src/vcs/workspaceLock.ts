const workspaceLocks = new Map<string, Promise<void>>();

/** Serialize clone/checkout initialization for each cache, including background prewarm. */
export async function withWorkspaceLock<T>(
  path: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const previous = workspaceLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => turn);
  workspaceLocks.set(path, tail);
  try {
    signal?.throwIfAborted();
    if (signal) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        void previous.then(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        });
      });
    } else {
      await previous;
    }
    signal?.throwIfAborted();
    return await operation();
  } finally {
    release();
    void tail.then(() => {
      if (workspaceLocks.get(path) === tail) workspaceLocks.delete(path);
    });
  }
}
