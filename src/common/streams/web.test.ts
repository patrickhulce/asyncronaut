import {Readable} from 'stream';
import {ReadableStream, TransformStream} from 'stream/web';
// @ts-expect-error - the types are close enough
global.TransformStream = TransformStream;
// @ts-expect-error - the types are close enough
global.ReadableStream = ReadableStream;

import {
  CHARACTER_SMOOTH_STREAM_OPTIONS,
  SmoothStreamOptions,
  createSmoothStreamViaPoll,
  fromChunks,
  fromNode,
  toPromise,
} from './web';
import {flushAllMicrotasks, withInspection} from '../promises';

import '../../test/jest';

describe(fromNode, () => {
  it('converts a node Readable stream to a web ReadableStream', async () => {
    const input = 'This is a test string.';
    const nodeStream = Readable.from(Buffer.from(input, 'utf-8'));
    const webStream = fromNode(nodeStream);

    expect(webStream).toBeInstanceOf(ReadableStream);

    const reader = webStream.getReader();
    const decoder = new TextDecoder();
    let receivedData = '';

    let result;
    while (!(result = await reader.read()).done) {
      receivedData += decoder.decode(result.value, {stream: true});
    }

    expect(receivedData).toBe(input);
  });

  it('handles stream errors', async () => {
    const nodeStream = new Readable({
      read() {
        this.emit('error', new Error('Test error'));
      },
    });

    const webStream = fromNode(nodeStream);

    const reader = webStream.getReader();

    try {
      await reader.read();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('Test error');
    }
  });

  it('handles abort signal', async () => {
    const nodeStream = new Readable({
      read() {},
    });

    const webStream = fromNode(nodeStream);

    const abortController = new AbortController();
    const {readable, writable} = new TransformStream();
    const pipePromise = webStream.pipeTo(writable, {signal: abortController.signal});
    const reader = readable.getReader();
    const inspectablePromise = withInspection(reader.closed);

    const expectationsPromise = Promise.all([
      expect(pipePromise).rejects.toThrow(/abort/),
      expect(inspectablePromise).rejects.toThrow(/abort/),
    ]);

    const destroySpy = jest.spyOn(nodeStream, 'destroy');
    abortController.abort();

    await flushAllMicrotasks();

    expect(destroySpy).toHaveBeenCalled();
    expect(inspectablePromise).toBeDone();
    await expectationsPromise;
  });
});

describe(fromChunks, () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('delivers each chunk with the specified delay', async () => {
    const chunks = ['chunk1', 'chunk2', 'chunk3'];
    const chunkGapInMs = 1_000; // 1 second
    const reader = fromChunks(chunks, {chunkGapInMs}).getReader();

    // Read the first chunk.
    await jest.advanceTimersByTimeAsync(chunkGapInMs + 1);
    let result = await reader.read();
    expect(result.value).toBe('chunk1');
    expect(result.done).toBeFalsy();

    // Move ahead in time and read the second chunk.
    await jest.advanceTimersByTimeAsync(chunkGapInMs);
    result = await reader.read();
    expect(result.value).toBe('chunk2');
    expect(result.done).toBeFalsy();

    // Move ahead in time and read the third chunk.
    await jest.advanceTimersByTimeAsync(chunkGapInMs);
    result = await reader.read();
    expect(result.value).toBe('chunk3');
    expect(result.done).toBeFalsy();

    // Move ahead in time and check if the reader is done.
    await jest.advanceTimersByTimeAsync(chunkGapInMs);
    result = await reader.read();
    expect(result.done).toBeTruthy();
  });

  it('works with no options', async () => {
    const chunks = ['chunk1', 'chunk2', 'chunk3'];
    const reader = fromChunks(chunks).getReader();

    // Read all chunks
    await jest.advanceTimersByTimeAsync(1_000);
    let result = await reader.read();
    expect(result.value).toBe('chunk1');
    expect(result.done).toBeFalsy();

    result = await reader.read();
    expect(result.value).toBe('chunk2');
    expect(result.done).toBeFalsy();

    result = await reader.read();
    expect(result.value).toBe('chunk3');
    expect(result.done).toBeFalsy();

    result = await reader.read();
    expect(result.done).toBeTruthy();
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

  async function readUntilDone(reader: ReadableStreamDefaultReader<string>): Promise<string[]> {
    const chunks: string[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await reader.read();
      if (result.done) return Promise.resolve(chunks);
      chunks.push(result.value);
    }
  }

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
    const chunkPromise = withInspection(toPromise(stream));

    await flushAllTimersAndMicrotasks();

    expect(chunkPromise).toBeDone();
    const chunks = await chunkPromise;
    expect(chunks.join('')).toEqual('Hello, World!');
  });

  it('streams the complete state in a single increment if done after first poll', async () => {
    const pollFn = jest.fn().mockResolvedValueOnce({state: 'Hello, World!', isDone: true});

    const stream = createStream({poll: pollFn});
    const chunkPromise = withInspection(toPromise(stream));

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
    const chunkPromise = withInspection(toPromise(stream));

    await flushAllTimersAndMicrotasks();

    expect(chunkPromise).toBeDone();
    const chunks = await chunkPromise;
    expect(chunks.join('')).toEqual('Hello, World!');
  });

  it('handles poll rejection', async () => {
    const error = new Error('Polling failed!');
    const pollFn = jest.fn().mockRejectedValue(error);

    const stream = createStream({poll: pollFn});
    const reader = stream.getReader();
    await expect(reader.read()).rejects.toThrow(error);
    await reader.releaseLock();
  });

  it('resolves gracefully on an abort signal', async () => {
    const abortController = new AbortController();
    const pollFn = jest
      .fn()
      .mockResolvedValueOnce({state: 'Hello,', isDone: false})
      .mockResolvedValueOnce({state: 'Hello, World!', isDone: true});

    const stream = createStream({poll: pollFn, signal: abortController.signal});
    const chunkPromise = withInspection(toPromise(stream));

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
    const promise = toPromise(stream);
    const chunks = promise.chunks;
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

  it('respects minimumIncrementDurationMs', async () => {
    const pollFn = jest.fn().mockResolvedValueOnce({state: 'ABCD', isDone: true});

    const stream = createStream({
      poll: pollFn,
      minimumIncrementDurationMs: 20,
      finalIncrementDurationMs: 30,
    });
    const promise = toPromise(stream);
    const chunks = promise.chunks;
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
    const promise = toPromise(stream);
    const chunks = promise.chunks;
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
    const promise = toPromise(stream);
    const chunks = promise.chunks;
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

  it('flushes all queued increments on drain', async () => {
    const pollFn = jest.fn().mockResolvedValueOnce({state: 'ABCD', isDone: false});

    const stream = createStream({
      poll: pollFn,
      pollIntervalMs: 10_000,
      excessIncrementDurationMs: 0,
    });
    const reader = await stream.getReader();

    // Schedules first character immediately.
    const firstReadPromise = withInspection(reader.read());
    await flushAllMicrotasks();
    expect(firstReadPromise).toBeDone();
    expect(await firstReadPromise).toEqual({value: 'A', done: false});

    // Cancel the stream before any other characters are written.
    jest.advanceTimersByTime(250);
    const readPromise = withInspection(readUntilDone(reader));

    await stream.drain();

    // Ensure we closed the stream gracefully.
    await flushAllMicrotasks();
    expect(readPromise).toBeDone();

    // Ensure we got the rest of the characters.
    expect(await readPromise).toEqual(['B', 'C', 'D']);

    await reader.releaseLock();
    await stream.cancel();
  });
});
