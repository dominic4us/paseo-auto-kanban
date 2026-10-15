/**
 * REQ-78: the workspace listing's timing, without React or the SDK — how long one listing may take, and how long
 * to wait before reading it again after it failed (2 s, 4 s, 8 s … up to a minute). Tests shorten the values.
 */
export const DIRECTORY_TIMING = { timeoutMs: 20_000, retryFirstMs: 2_000, retryMaxMs: 60_000 };
export function retryPause(attempt: number, timing = DIRECTORY_TIMING): number {
  return Math.min(timing.retryMaxMs, timing.retryFirstMs * 2 ** Math.max(0, attempt));
}
/** Rejects with "<what> timed out" when the listing takes longer than `timeoutMs`; a late answer is ignored. */
export function withTimeout<T>(promise: Promise<T>, what: string, timing = DIRECTORY_TIMING): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what + ' timed out')), timing.timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}
/** Runs `retry` once after the pause for `attempt`; the returned function cancels it. */
export function scheduleRetry(retry: () => void, attempt: number, timing = DIRECTORY_TIMING): () => void {
  const timer = setTimeout(retry, retryPause(attempt, timing));
  return () => clearTimeout(timer);
}
