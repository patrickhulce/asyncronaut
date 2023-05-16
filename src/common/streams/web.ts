import type {Readable} from 'stream';
import {ReadableStream, TransformStream} from 'stream/web';
import createLogger from 'debug';

const log = createLogger('asyncronaut:streams:verbose');

/** Converts a node Readable stream into a web ReadableStream */
export function fromNode(stream: Readable): ReadableStream {
  return new ReadableStream({
    start(controller) {
      stream.on('data', (chunk) => {
        controller.enqueue(chunk);
      });

      stream.on('end', () => {
        controller.close();
      });

      stream.on('error', (err) => {
        controller.error(err);
      });
    },
    cancel(reason) {
      stream.destroy(reason);
    },
  });
}

/** Converts a web ReadableStream of items into a promise of an array of items. */
export function toDecomposedChunks<T>(stream: ReadableStream<T>): {
  result: Promise<Array<T>>;
  chunks: Array<T>;
} {
  const reader = stream.getReader();
  const chunks: Array<T> = [];

  return {
    chunks,
    result: (async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const {value, done} = await reader.read();
        if (value) chunks.push(value);
        if (done) break;
      }

      return chunks;
    })().finally(() => reader.releaseLock()),
  };
}

export interface IncrementFraction<TIncrement> {
  /** The incremental state itself. */
  increment: TIncrement;
  /** The fraction of overall state that this increment represents, out of 1.  */
  fraction: number;
}

export interface SmoothStreamOptions<TState, TIncrement> {
  /** The function to invoke to fetch the current state of data in the stream. */
  poll(current: TState | undefined): Promise<{state: TState; isDone: boolean}>;
  /** The function to compute the incremental progress between two states. */
  getIncrement(previous: TState | undefined, current: TState): IncrementFraction<TIncrement>;
  /** The function to subdivide an increment into smaller increments for a smoother stream. This function may return fewer than values than `targetIncrements` if that quantity of data is unavailable. */
  getSubIncrements(
    increment: IncrementFraction<TIncrement>,
    targetIncrements: number
  ): Array<IncrementFraction<TIncrement>>;
  /** The function to reassemble incremental states into a complete state. */
  getState(previous: TState | undefined, increments: Array<IncrementFraction<TIncrement>>): TState;

  /** The time to wait between each `poll()` invocation, in milliseconds. This time does not include the time taken to invoke `poll()`. Defaults to 1 second. */
  pollIntervalMs?: number;
  /** The additional time to schedule for an increment to be streamed via subincrements. For example, if the expected time until the next `poll()` invocation returns is 700ms and this value is 200ms, the current increment will be streamed across 900ms. Defaults to 500ms. */
  excessIncrementDurationMs?: number;
  /** The minimum time to wait between increments made available on the stream. Defaults to 17ms (60 fps). */
  minimumIncrementDurationMs?: number;
  /** The time taken to stream the final increment. Defaults to 100ms. */
  finalIncrementDurationMs?: number;
  /** The signal from an abort controller to stop the stream. */
  signal?: AbortSignal;
}

class SmoothStream<TState, TIncrement> extends TransformStream<TIncrement, TIncrement> {
  private lastPollDuration = 0;
  private iterationDurationMs = 0;
  private isDonePolling = false;
  private previousState: TState | undefined = undefined;
  private currentState: TState | undefined = undefined;
  private writer: WritableStreamDefaultWriter | undefined = undefined;

  private nextIncrementTimeout: NodeJS.Timeout | undefined = undefined;
  private processedIncrements: Array<IncrementFraction<TIncrement>> = [];
  private incrementsToProcess: Array<IncrementFraction<TIncrement>> = [];

  public constructor(private options: SmoothStreamOptions<TState, TIncrement>) {
    super();
    this._emitIncrement = this._emitIncrement.bind(this);
  }

  private _close() {
    if (!this.writer) return;
    log('closing writer');
    this.writer.close().catch((error) => {
      log('closing writer failed', error);
    });
  }

  private _emitIncrement() {
    if (!this.writer) throw new Error(`SmoothStream not yet started`);
    if (this.options.signal?.aborted) return;

    log(`emitIncrement invoked`);

    const incrementFraction = this.incrementsToProcess.shift();
    if (!incrementFraction) {
      if (this.isDonePolling) this._close();
      return;
    }

    this.writer.write(incrementFraction.increment);
    this.processedIncrements.push(incrementFraction);

    if (!this.incrementsToProcess.length && this.isDonePolling) return this._close();
    log(`emitIncrement scheduled in ${this.iterationDurationMs}ms`);
    this.nextIncrementTimeout = setTimeout(this._emitIncrement, this.iterationDurationMs);
  }

  private async _scheduleIncrements() {
    if (this.nextIncrementTimeout) clearTimeout(this.nextIncrementTimeout);
    if (this.options.signal?.aborted) return;

    this._emitIncrement();
  }

  private _calculateIncrementsToProcess(state: TState) {
    const {
      getIncrement,
      getSubIncrements,
      getState,
      pollIntervalMs = 1000,
      excessIncrementDurationMs = 500,
      finalIncrementDurationMs = 100,
    } = this.options;

    const minimumIncrementDurationMs = Math.max(this.options.minimumIncrementDurationMs ?? 17, 1);

    this.previousState = getState(this.previousState, this.processedIncrements);
    this.currentState = state;
    this.processedIncrements = [];

    const increment = getIncrement(this.previousState, this.currentState);
    const totalDurationMs = this.isDonePolling
      ? finalIncrementDurationMs
      : pollIntervalMs + this.lastPollDuration + excessIncrementDurationMs;
    const targetIncrements = Math.ceil(totalDurationMs / minimumIncrementDurationMs);
    this.incrementsToProcess = getSubIncrements(increment, targetIncrements);
    this.iterationDurationMs = Math.ceil(totalDurationMs / this.incrementsToProcess.length);
    log(`calculated ${this.incrementsToProcess} increments to process`);
  }

  async start() {
    if (this.writer) throw new Error(`SmoothStream already started`);
    const writer = (this.writer = await this.writable.getWriter());

    const {signal, poll, pollIntervalMs = 1000} = this.options;
    if (signal) {
      signal.addEventListener('abort', () => {
        for (const {increment} of this.incrementsToProcess) writer.write(increment);
        writer.close();
      });
    }

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pollStartMs = Date.now();
        log(`start poll`);
        const {state, isDone} = await poll(this.currentState);
        log('poll complete', {isDone});

        this.isDonePolling = isDone;
        this.lastPollDuration = Date.now() - pollStartMs;

        if (signal?.aborted) return;

        this._calculateIncrementsToProcess(state);
        this._scheduleIncrements();

        if (isDone) break;
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } catch (error) {
      writer.abort(error);
    }
  }
}

/** Converts a poll-based state fetcher into a continuous stream of smaller increments. */
export function createSmoothStreamViaPoll<TState, TIncrement>(
  options: SmoothStreamOptions<TState, TIncrement>
): ReadableStream<TIncrement> {
  const smoothStream = new SmoothStream(options);
  smoothStream.start().catch((error) => {
    log('smooth stream start failed', error);
    smoothStream.writable.abort(error);
  });
  return smoothStream.readable;
}

export const CHARACTER_SMOOTH_STREAM_OPTIONS: Pick<
  SmoothStreamOptions<string, string>,
  'getIncrement' | 'getSubIncrements' | 'getState'
> = {
  getIncrement: (previous = '', current = '') => ({
    increment: current.slice(previous.length),
    fraction: (current.length - previous.length) / current.length,
  }),
  getSubIncrements: (incrementFraction, targetIncrements) => {
    const {increment, fraction} = incrementFraction;
    targetIncrements = Math.min(targetIncrements, increment.length);
    const incrementLength = Math.ceil(increment.length / targetIncrements);
    return Array.from({length: targetIncrements}).map((_, index) => ({
      increment: increment.slice(index * incrementLength, (index + 1) * incrementLength),
      fraction: fraction / targetIncrements,
    }));
  },
  getState: (previous = '', increments = []) => {
    return previous + increments.map((increment) => increment.increment).join('');
  },
};
