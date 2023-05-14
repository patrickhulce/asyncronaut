export class TimeoutError extends Error {}
export class AbortError extends Error {}
export class TimeoutSourceLateRejectionError extends Error {
  constructor(public originalRejection: unknown) {
    super();
  }
}

export interface InspectablePromise<T> extends Promise<T> {
  isDone(): boolean;
  getDebugValues(): {resolvedValue: unknown; rejectionError: Error | undefined};
}

export interface DecomposedPromise<T> {
  /** A function to resolve the attached promise. */
  resolve(value: T): void;
  /** A function to reject the attached promise. */
  reject(err: Error): void;
  /** The promise controlled by the resolve and reject methods. */
  promise: Promise<T>;
}

export interface PromiseTimeoutOptions<T> {
  /** The elapsed time in milliseconds before the promise will reject. Values of infinity will return the original promise. */
  timeoutMs: number;
  /** The custom error message to use when the timeout is reached. */
  timeoutErrorMessage?: string;
  /** The custom error message to use when the promise is aborted. */
  abortErrorMessage?: string;
  /** The abort controller to both listen for changes to abort early, and to invoke abort when timeout is reached. */
  abortController?: AbortController;
  /** The function to invoke if the promise eventually resolves with a value. */
  cleanupOnLateResolve?(value: T): void;
  /** The function to invoke if the promise eventually rejects with a value. */
  cleanupOnLateReject?(error: Error): void;
}

/** Creates the a promise with resolve and reject methods exposed. */
export function createDecomposedPromise<T>(): DecomposedPromise<T> {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  let resolve = (value: T) => {};
  let reject = (err: Error) => {};
  /* eslint-enable @typescript-eslint/no-unused-vars */

  const promise = new Promise<T>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });

  return {resolve, reject, promise};
}

/** Adds timeout management to an existing promise, including abortController notification, and */
export function withTimeout<T>(
  sourcePromise: Promise<T>,
  options: PromiseTimeoutOptions<T>
): Promise<T> {
  if (!Number.isFinite(options.timeoutMs)) return sourcePromise;

  const {resolve, reject, promise} = createDecomposedPromise<T>();

  let hasCancelled = false;
  const timeout = setTimeout(() => {
    hasCancelled = true;
    const errorMessage =
      options.timeoutErrorMessage || `Operation exceeded ${options.timeoutMs}ms timeout`;
    const error = new TimeoutError(errorMessage);

    reject(error);
    if (options?.abortController) options.abortController.abort(error);
  }, options.timeoutMs);

  if (options.abortController) {
    options.abortController.signal.addEventListener('abort', () => {
      if (hasCancelled) return;

      hasCancelled = true;
      const errorMessage = options.abortErrorMessage || `Operation aborted`;
      reject(new AbortError(errorMessage));
    });
  }

  sourcePromise
    .then((value) => {
      resolve(value);
      clearTimeout(timeout);

      if (hasCancelled && options.cleanupOnLateResolve) options.cleanupOnLateResolve(value);
    })
    .catch((rejection) => {
      reject(rejection);
      clearTimeout(timeout);
      const error =
        rejection instanceof Error ? rejection : new TimeoutSourceLateRejectionError(rejection);

      if (hasCancelled && options.cleanupOnLateReject) options.cleanupOnLateReject(error);
    });

  return promise;
}

/** A function to retry an action on failure with optional cleanup. */
export async function withRetry<T>(
  actionToRetry: () => Promise<T>,
  options: {
    /** The number of times to retry the action before failing. */
    retries: number;
    /** The optional async cleanup to perform after each failure, the result of cleanup will be awaited before retrying. */
    cleanup?: () => Promise<void>;
  }
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= options.retries; i++) {
    try {
      const result = await actionToRetry();
      return result;
    } catch (err) {
      lastError = err;
      if (options.cleanup) await options.cleanup();
    }
  }

  throw lastError;
}

/**
 * Flushes all pending microtasks (and microtasks that _they_ enqueue) from the queue.
 * @see https://gist.github.com/patrickhulce/0c4c7b6b05937b6854b048a20b7ddb6c
 * @returns void
 */
export async function flushAllMicrotasks() {
  // 1000 is not significant, any number high enough to ensure all trampolined microtasks are
  // executed will do.
  for (let i = 0; i < 1000; i++) {
    await Promise.resolve();
  }
}

/**
 * Augments a promise to enable synchronous inspection of whether it has settled.
 *
 * @param promise The promise to make inspectable.
 * @returns The inspectable promise.
 */
export function withInspection<T>(promise: Promise<T>): InspectablePromise<T> {
  let hasSettled = false;
  let resolvedValue: T | undefined = undefined;
  let rejectionError: Error | undefined = undefined;

  const inspectablePromise = promise
    .then((value) => {
      hasSettled = true;
      resolvedValue = value;
      return value;
    })
    .catch((err) => {
      hasSettled = true;
      rejectionError = err;
      throw err;
    });

  return Object.assign(inspectablePromise, {
    isDone() {
      return hasSettled;
    },
    getDebugValues() {
      return {resolvedValue, rejectionError};
    },
  });
}
