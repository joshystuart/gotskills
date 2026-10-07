/**
 * In-process async mutex. Serialises mirror-mutating (sync) and mirror-reading
 * (install) work without blocking the event loop (012).
 */
export function createAsyncMutex(): {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
} {
  let tail: Promise<unknown> = Promise.resolve()

  return {
    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(
        () => fn(),
        () => fn()
      )
      tail = run.then(
        () => undefined,
        () => undefined
      )
      return run
    },
  }
}
