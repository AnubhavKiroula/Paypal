export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

/** Resolves after `ms`, or rejects with AbortedError as soon as `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export class AbortedError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortedError';
  }
}

export const systemClock: Clock = { now: () => Date.now() };

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
