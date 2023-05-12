import {Readable} from 'stream';
import {
  CHARACTER_SMOOTH_STREAM_OPTIONS,
  SmoothStreamOptions,
  createSmoothStreamViaPoll,
  streamToBuffer,
  streamToDecomposedChunks,
} from './streams';
import {flushAllMicrotasks, withInspection} from './promises';

import '../test/jest';

describe(streamToBuffer, () => {
  it('converts a stream to a buffer', async () => {
    const input = Buffer.from('This is a test');
    const readableStream = Readable.from(input);

    const output = await streamToBuffer(readableStream);
    expect(output).toBeInstanceOf(Buffer);
    expect(output.toString()).toBe(input.toString());
  });

  it('handles empty streams', async () => {
    const readableStream = Readable.from([]);

    const output = await streamToBuffer(readableStream);
    expect(output).toBeInstanceOf(Buffer);
    expect(output.length).toBe(0);
  });

  it('rejects on stream error', async () => {
    const readableStream = new Readable({
      read() {
        this.emit('error', new Error('Stream error'));
      },
    });

    await expect(streamToBuffer(readableStream)).rejects.toThrow('Stream error');
  });
});

describe(createSmoothStreamViaPoll, () => {
  const createStream = (
    options: Omit<
      SmoothStreamOptions<string, string>,
      'getIncrement' | 'getSubIncrements' | 'getState'
    >
  ) => {
    return createSmoothStreamViaPoll({
      ...CHARACTER_SMOOTH_STREAM_OPTIONS,
      ...options,
    });
  };

  const flushAllTimersAndMicrotasks = async () => {
    for (let i = 0; i < 100; i++) {
      jest.advanceTimersByTime(500);
      await flushAllMicrotasks();
    }
  };

  beforeEach(() => {
    jest.useFakeTimers();
    Date.now = jest.fn().mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('streams the complete state in increments', async () => {
    const pollFn = jest
      .fn()
      .mockResolvedValueOnce({state: 'Hello,', isDone: false})
      .mockResolvedValueOnce({state: 'Hello, World!', isDone: true});

    const stream = createStream({poll: pollFn});
    const chunkPromise = withInspection(streamToDecomposedChunks(stream).result);

    await flushAllTimersAndMicrotasks();

    expect(chunkPromise).toBeDone();
    const chunks = await chunkPromise;
    expect(chunks.join('')).toEqual('Hello, World!');
  });

  it('streams the complete state in a single increment if done after first poll', async () => {
    const pollFn = jest.fn().mockResolvedValueOnce({state: 'Hello, World!', isDone: true});

    const stream = createStream({poll: pollFn});
    const chunkPromise = withInspection(streamToDecomposedChunks(stream).result);

    await flushAllTimersAndMicrotasks();

    expect(chunkPromise).toBeDone();
    const chunks = await chunkPromise;
    expect(chunks.join('')).toEqual('Hello, World!');
  });

  it('handles an empty initial state', async () => {
    const pollFn = jest
      .fn()
      .mockResolvedValueOnce({state: '', isDone: false})
      .mockResolvedValueOnce({state: 'Hello, World!', isDone: true});

    const stream = createStream({poll: pollFn});
    const chunkPromise = withInspection(streamToDecomposedChunks(stream).result);

    await flushAllTimersAndMicrotasks();

    expect(chunkPromise).toBeDone();
    const chunks = await chunkPromise;
    expect(chunks.join('')).toEqual('Hello, World!');
  });

  it('resolves gracefully on an abort signal', async () => {
    const abortController = new AbortController();
    const pollFn = jest
      .fn()
      .mockResolvedValueOnce({state: 'Hello,', isDone: false})
      .mockResolvedValueOnce({state: 'Hello, World!', isDone: true});

    const stream = createStream({poll: pollFn, signal: abortController.signal});
    const chunkPromise = withInspection(streamToDecomposedChunks(stream).result);

    setTimeout(() => abortController.abort(), 900);
    jest.advanceTimersByTime(800);
    await flushAllMicrotasks();

    expect(chunkPromise).not.toBeDone();

    jest.advanceTimersByTime(101);
    await flushAllMicrotasks();

    expect(chunkPromise).toBeDone();
    const chunks = await chunkPromise;
    expect(chunks.join('')).toEqual('Hello,');
  });

  it('streams at a custom poll interval', async () => {
    const pollFn = jest
      .fn()
      .mockResolvedValueOnce({state: 'A', isDone: false})
      .mockResolvedValueOnce({state: 'AB', isDone: false})
      .mockResolvedValueOnce({state: 'ABC', isDone: false})
      .mockResolvedValueOnce({state: 'ABCD', isDone: true});

    const stream = createStream({poll: pollFn, pollIntervalMs: 60_000});
    const {result: promise, chunks} = streamToDecomposedChunks(stream);
    const chunkPromise = withInspection(promise);

    await flushAllMicrotasks();
    expect(chunkPromise).not.toBeDone();
    expect(chunks.join('')).toEqual('A');

    jest.advanceTimersByTime(60_000);
    await flushAllMicrotasks();
    expect(chunkPromise).not.toBeDone();
    expect(chunks.join('')).toEqual('AB');

    jest.advanceTimersByTime(60_000);
    await flushAllMicrotasks();
    expect(chunkPromise).not.toBeDone();
    expect(chunks.join('')).toEqual('ABC');

    await jest.advanceTimersByTimeAsync(60_000); // Skip to last poll.
    await flushAllMicrotasks();
    expect(chunks.join('')).toEqual('ABCD');
    expect(chunkPromise).toBeDone();
  });

  it('streams at a custom poll interval', async () => {
    const pollFn = jest.fn().mockResolvedValueOnce({state: 'ABCD', isDone: true});

    const stream = createStream({
      poll: pollFn,
      minimumIncrementDurationMs: 20,
      finalIncrementDurationMs: 30,
    });
    const {result: promise, chunks} = streamToDecomposedChunks(stream);
    const chunkPromise = withInspection(promise);

    await flushAllMicrotasks();
    expect(chunkPromise).not.toBeDone();
    expect(chunks.join('')).toEqual('AB');

    jest.advanceTimersByTime(20);
    await flushAllMicrotasks();
    expect(chunkPromise).toBeDone();
    expect(chunks.join('')).toEqual('ABCD');
  });

  it('respects excessIncrementDurationMs', async () => {
    // We expect A-B-C-D to be scheduled 10s apart.
    // But the process should finish at the poll 20s in.
    const pollFn = jest
      .fn()
      .mockResolvedValueOnce({state: 'ABCD', isDone: false})
      .mockResolvedValueOnce({state: 'ABCDEFGH', isDone: true});

    const stream = createStream({
      poll: pollFn,
      pollIntervalMs: 20_000,
      excessIncrementDurationMs: 20_000,
    });
    const {result: promise, chunks} = streamToDecomposedChunks(stream);
    const chunkPromise = withInspection(promise);

    // Schedules first character immediately.
    await flushAllMicrotasks();
    expect(chunkPromise).not.toBeDone();
    expect(chunks.join('')).toEqual('A');

    // Schedules second character 10s later.
    jest.advanceTimersByTime(10_000);
    await flushAllMicrotasks();
    expect(chunkPromise).not.toBeDone();
    expect(chunks.join('')).toEqual('AB');

    // The rest comes in all at once as a result of the poll at 20s (in 10s) + 100ms for final set.
    await jest.advanceTimersByTimeAsync(10_100);
    expect(chunkPromise).toBeDone();
    expect(chunks.join('')).toEqual('ABCDEFGH');
  });

  it('respects finalIncrementDurationMs', async () => {
    const pollFn = jest
      .fn()
      .mockResolvedValueOnce({state: 'ABCD', isDone: false})
      .mockResolvedValueOnce({state: 'ABCDEFGH', isDone: true});

    const stream = createStream({
      poll: pollFn,
      pollIntervalMs: 1_000,
      excessIncrementDurationMs: 0,
      finalIncrementDurationMs: 40_000,
    });
    const {result: promise, chunks} = streamToDecomposedChunks(stream);
    const chunkPromise = withInspection(promise);

    // Schedules first character immediately.
    await flushAllMicrotasks();
    expect(chunkPromise).not.toBeDone();
    expect(chunks.join('')).toEqual('A');

    // Schedules second character 250ms later.
    jest.advanceTimersByTime(250);
    await flushAllMicrotasks();
    expect(chunkPromise).not.toBeDone();
    expect(chunks.join('')).toEqual('AB');

    // The first batch is finished by the next poll.
    await jest.advanceTimersByTimeAsync(700);
    await flushAllMicrotasks();
    expect(chunkPromise).not.toBeDone();
    expect(chunks.join('')).toEqual('ABCD');

    // The rest come in very slowly.
    await jest.advanceTimersByTimeAsync(5_000);
    await flushAllMicrotasks();
    expect(chunkPromise).not.toBeDone();
    expect(chunks.join('')).toEqual('ABCDE');

    // But should all be finished by 40s.
    await jest.advanceTimersByTimeAsync(40_000);
    await flushAllMicrotasks();
    expect(chunkPromise).toBeDone();
    expect(chunks.join('')).toEqual('ABCDEFGH');
  });
});
