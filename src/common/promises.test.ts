import {
  TimeoutError,
  AbortError,
  TimeoutSourceLateRejectionError,
  createDecomposedPromise,
  withTimeout,
  withRetry,
  flushAllMicrotasks,
  withInspection,
} from './promises';

describe(createDecomposedPromise, () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a decomposed promise with exposed resolve and reject methods', () => {
    const {resolve, reject, promise} = createDecomposedPromise();

    expect(typeof resolve).toBe('function');
    expect(typeof reject).toBe('function');
    expect(promise).toBeInstanceOf(Promise);
  });

  it('creates a decomposed promise with exposed resolve and reject methods', () => {
    const {resolve, reject, promise} = createDecomposedPromise();

    expect(typeof resolve).toBe('function');
    expect(typeof reject).toBe('function');
    expect(promise).toBeInstanceOf(Promise);
  });

  it('resolves the promise when the resolve method is called', async () => {
    const {resolve, promise} = createDecomposedPromise();

    setTimeout(() => resolve(42), 100);
    jest.advanceTimersByTime(101);
    await expect(promise).resolves.toBe(42);
  });

  it('rejects the promise when the reject method is called', async () => {
    const {reject, promise} = createDecomposedPromise();

    setTimeout(() => reject(new Error('Oops!')), 100);
    jest.advanceTimersByTime(101);
    await expect(promise).rejects.toThrow('Oops!');
  });

  it('can resolve the promise with any value', async () => {
    const {resolve, promise} = createDecomposedPromise();

    const testData = {key: 'value'};
    setTimeout(() => resolve(testData), 100);
    jest.advanceTimersByTime(101);
    await expect(promise).resolves.toBe(testData);
  });

  it('can reject the promise with any error', async () => {
    const {reject, promise} = createDecomposedPromise();

    const customError = new TypeError('Custom error');
    setTimeout(() => reject(customError), 100);
    jest.advanceTimersByTime(101);
    await expect(promise).rejects.toThrow(customError);
  });
});

describe(withTimeout, () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the original promise if timeoutMs is not finite', async () => {
    const sourcePromise = Promise.resolve(42);
    const result = withTimeout(sourcePromise, {timeoutMs: Infinity});

    expect(result).toBe(sourcePromise);
    await expect(result).resolves.toBe(42);
  });

  it('rejects with a TimeoutError if the operation exceeds the timeout', async () => {
    const sourcePromise = new Promise((resolve) => setTimeout(resolve, 200));
    const result = withTimeout(sourcePromise, {timeoutMs: 100});

    jest.advanceTimersByTime(100);
    await expect(result).rejects.toBeInstanceOf(TimeoutError);
  });

  it('rejects with a custom timeout error message if provided', async () => {
    const sourcePromise = new Promise((resolve) => setTimeout(resolve, 200));
    const result = withTimeout(sourcePromise, {
      timeoutMs: 100,
      timeoutErrorMessage: 'Custom timeout message',
    });

    jest.advanceTimersByTime(100);
    await expect(result).rejects.toThrow('Custom timeout message');
  });

  it('resolves if the operation finishes before the timeout', async () => {
    const sourcePromise = new Promise((resolve) => setTimeout(resolve, 50, 42));
    const result = withTimeout(sourcePromise, {timeoutMs: 100});

    jest.advanceTimersByTime(50);
    await expect(result).resolves.toBe(42);
  });

  it('rejects with an AbortError if the abortController signals abort', async () => {
    const sourcePromise = new Promise((resolve) => setTimeout(resolve, 200));
    const abortController = new AbortController();
    const result = withTimeout(sourcePromise, {
      timeoutMs: 1000,
      abortController,
    });

    jest.advanceTimersByTime(50);
    abortController.abort();
    await expect(result).rejects.toBeInstanceOf(AbortError);
  });

  it('rejects with a custom abort error message if provided', async () => {
    const sourcePromise = new Promise((resolve) => setTimeout(resolve, 200));
    const abortController = new AbortController();
    const result = withTimeout(sourcePromise, {
      timeoutMs: 1000,
      abortController,
      abortErrorMessage: 'Custom abort message',
    });

    jest.advanceTimersByTime(50);
    abortController.abort();
    await expect(result).rejects.toThrow('Custom abort message');
  });

  it('invokes abort on the provided abortController when the operation times out', async () => {
    const sourcePromise = new Promise((resolve) => setTimeout(resolve, 200));
    const abortController = new AbortController();
    const spy = jest.spyOn(abortController, 'abort');

    const result = withTimeout(sourcePromise, {
      timeoutMs: 100,
      abortController,
    });

    jest.advanceTimersByTime(101);
    await expect(result).rejects.toBeInstanceOf(TimeoutError);
    expect(spy).toHaveBeenCalled();
  });

  it('calls cleanupOnResolve when the promise resolves after timeout', async () => {
    const sourcePromise = new Promise((resolve) => setTimeout(resolve, 200, 42));
    const cleanupOnResolve = jest.fn();
    const result = withTimeout(sourcePromise, {
      timeoutMs: 100,
      cleanupOnLateResolve: cleanupOnResolve,
    });

    jest.advanceTimersByTime(201);
    await expect(result).rejects.toBeInstanceOf(TimeoutError);
    expect(cleanupOnResolve).toHaveBeenCalledWith(42);
  });

  it('calls cleanupOnReject when the promise rejects after timeout', async () => {
    const error = new Error('Oops!');
    const sourcePromise = new Promise((_, reject) => setTimeout(reject, 200, error));
    const cleanupOnReject = jest.fn();
    const result = withTimeout(sourcePromise, {
      timeoutMs: 100,
      cleanupOnLateReject: cleanupOnReject,
    });

    jest.advanceTimersByTime(201);
    await expect(result).rejects.toBeInstanceOf(TimeoutError);
    expect(cleanupOnReject).toHaveBeenCalledWith(error);
  });

  it('cleanupOnReject handles non-Error reasons', async () => {
    const nonErrorReason = 'error message';
    const sourcePromise = new Promise((_, reject) => setTimeout(reject, 200, nonErrorReason));
    const cleanupOnReject = jest.fn();
    const result = withTimeout(sourcePromise, {
      timeoutMs: 100,
      cleanupOnLateReject: cleanupOnReject,
    });

    jest.advanceTimersByTime(201);
    await expect(result).rejects.toBeInstanceOf(TimeoutError);

    expect(cleanupOnReject).toHaveBeenCalledTimes(1);
    const [error] = cleanupOnReject.mock.calls[0];
    expect(error).toBeInstanceOf(TimeoutSourceLateRejectionError);
    if (!(error instanceof TimeoutSourceLateRejectionError)) throw new Error('Impossible');
    expect(error.originalRejection).toEqual(nonErrorReason);
  });

  it('does not call cleanupOnResolve when the promise resolves before timeout', async () => {
    const sourcePromise = new Promise((resolve) => setTimeout(resolve, 50, 42));
    const cleanupOnResolve = jest.fn();
    const result = withTimeout(sourcePromise, {
      timeoutMs: 100,
      cleanupOnLateResolve: cleanupOnResolve,
    });

    jest.advanceTimersByTime(51);
    await expect(result).resolves.toBe(42);
    jest.advanceTimersByTime(50);
    await flushAllMicrotasks();
    expect(cleanupOnResolve).not.toHaveBeenCalled();
  });

  it('does not call cleanupOnReject when the promise rejects before timeout', async () => {
    const sourcePromise = new Promise((_, reject) => setTimeout(reject, 50, new Error('Oops!')));
    const cleanupOnReject = jest.fn();
    const result = withTimeout(sourcePromise, {
      timeoutMs: 100,
      cleanupOnLateReject: cleanupOnReject,
    });

    jest.advanceTimersByTime(51);
    await expect(result).rejects.toThrow('Oops!');
    jest.advanceTimersByTime(50);
    await flushAllMicrotasks();
    expect(cleanupOnReject).not.toHaveBeenCalled();
  });
});

describe(withRetry, () => {
  it('returns the result if the action succeeds', async () => {
    const actionToRetry = jest.fn(() => Promise.resolve(42));
    const result = await withRetry(actionToRetry, {retries: 2});

    expect(actionToRetry).toHaveBeenCalledTimes(1);
    expect(result).toBe(42);
  });

  it('retries the action the specified number of times on failure', async () => {
    const actionToRetry = jest.fn(() => Promise.reject(new Error('Oops!')));
    await expect(withRetry(actionToRetry, {retries: 2})).rejects.toThrow('Oops!');
    expect(actionToRetry).toHaveBeenCalledTimes(3);
  });

  it('returns the result if the action succeeds after retrying', async () => {
    const actionToRetryFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Oops!'))
      .mockRejectedValueOnce(new Error('Oops!'))
      .mockResolvedValueOnce(42);

    const result = await withRetry(actionToRetryFn, {retries: 2});
    expect(actionToRetryFn).toHaveBeenCalledTimes(3);
    expect(result).toBe(42);
  });

  it('performs cleanup after each failure if provided', async () => {
    const actionToRetryFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Oops!'))
      .mockRejectedValueOnce(new Error('Oops!'))
      .mockResolvedValueOnce(42);

    const cleanup = jest.fn(() => Promise.resolve());
    const result = await withRetry(actionToRetryFn, {retries: 2, cleanup});

    expect(actionToRetryFn).toHaveBeenCalledTimes(3);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(result).toBe(42);
  });

  it('awaits the cleanup before retrying the action', async () => {
    const actionToRetryFn = jest.fn().mockRejectedValue(new Error('Oops!'));
    const cleanupDeferrable = createDecomposedPromise<void>();
    const cleanup = jest.fn(() => cleanupDeferrable.promise);

    const retriedResult = withInspection(withRetry(actionToRetryFn, {retries: 1, cleanup}));

    await flushAllMicrotasks();
    expect(actionToRetryFn).toHaveBeenCalledTimes(1);
    expect(retriedResult.isDone()).toBe(false);

    cleanupDeferrable.resolve();

    await flushAllMicrotasks();
    expect(actionToRetryFn).toHaveBeenCalledTimes(2);
    expect(retriedResult.isDone()).toBe(true);
    await expect(retriedResult).rejects.toThrow('Oops!');
  });
});

describe(withInspection, () => {
  it('returns the original promise when resolved', async () => {
    const {promise, resolve} = createDecomposedPromise<number>();
    const inspectablePromise = withInspection(promise);
    resolve(42);
    await expect(inspectablePromise).resolves.toBe(42);
  });

  it('returns the original promise when rejected', async () => {
    const {promise, reject} = createDecomposedPromise<number>();

    const inspectablePromise = withInspection(promise);
    const handledPromise = expect(inspectablePromise).rejects.toThrow('Oops!');
    reject(new Error('Oops!'));
    await handledPromise;
  });

  it('indicates if the promise is done when resolved', async () => {
    const {promise, resolve} = createDecomposedPromise<number>();
    const inspectablePromise = withInspection(promise);

    expect(inspectablePromise.isDone()).toBe(false);

    resolve(42);
    await expect(inspectablePromise).resolves.toBe(42);

    expect(inspectablePromise.isDone()).toBe(true);
  });

  it('indicates if the promise is done when rejected', async () => {
    const {promise, reject} = createDecomposedPromise<number>();
    const inspectablePromise = withInspection(promise);

    expect(inspectablePromise.isDone()).toBe(false);

    const handledPromise = expect(inspectablePromise).rejects.toThrow('Oops!');
    reject(new Error('Oops!'));
    await handledPromise;

    expect(inspectablePromise.isDone()).toBe(true);
  });

  it('provides debug values when the promise is resolved', async () => {
    const {promise, resolve} = createDecomposedPromise<number>();
    const inspectablePromise = withInspection(promise);

    resolve(42);
    await expect(inspectablePromise).resolves.toBe(42);

    const {resolvedValue, rejectionError} = inspectablePromise.getDebugValues();
    expect(resolvedValue).toBe(42);
    expect(rejectionError).toBeUndefined();
  });

  it('provides debug values when the promise is rejected', async () => {
    const {promise, reject} = createDecomposedPromise<number>();
    const inspectablePromise = withInspection(promise);

    const error = new Error('Oops!');
    const handledPromise = expect(inspectablePromise).rejects.toThrow('Oops!');
    reject(error);
    await handledPromise;

    const {resolvedValue, rejectionError} = inspectablePromise.getDebugValues();
    expect(resolvedValue).toBeUndefined();
    expect(rejectionError).toBe(error);
  });
});

describe(flushAllMicrotasks, () => {
  it('flushes all pending microtasks', async () => {
    const {promise, resolve} = createDecomposedPromise<number>();

    const onFulfilled = jest.fn();
    promise.then(onFulfilled);

    resolve(42);
    expect(onFulfilled).not.toHaveBeenCalled();

    await flushAllMicrotasks();
    expect(onFulfilled).toHaveBeenCalledTimes(1);
    expect(onFulfilled).toHaveBeenCalledWith(42);
  });

  it('flushes microtasks enqueued by other microtasks', async () => {
    const {promise: firstPromise, resolve: firstResolve} = createDecomposedPromise<number>();
    const {promise: secondPromise, resolve: secondResolve} = createDecomposedPromise<number>();

    firstPromise.then(() => {
      secondResolve(42);
    });

    const onFulfilled = jest.fn();
    secondPromise.then(onFulfilled);

    firstResolve(21);
    expect(onFulfilled).not.toHaveBeenCalled();

    await flushAllMicrotasks();
    expect(onFulfilled).toHaveBeenCalledTimes(1);
    expect(onFulfilled).toHaveBeenCalledWith(42);
  });
});
