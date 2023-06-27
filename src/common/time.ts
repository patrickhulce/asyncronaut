import createLogger from 'debug';

const log = createLogger('asyncronaut:timer:verbose');

export interface TimeController {
  /** Returns the current UNIX epoch time in milliseconds. */
  now(): number;
}

export const DEFAULT_TIME_CONTROLLER: TimeController = {
  now: () => Date.now(),
};

export const JEST_TIME_CONTROLLER: TimeController & {now: jest.Mock} = {
  now:
    typeof jest === 'undefined'
      ? ((() => {
          throw new Error(`jest environment not available`);
        }) as any)
      : jest.fn(),
};

export interface TimerEntryOptions {
  id?: string;
  context?: string;
}

export interface TimerEntry extends TimerEntryOptions {
  label: string;
  start: number;
  end?: number;
}

export interface Timer {
  start(label: string, options?: TimerEntryOptions): void;
  end(label: string, options?: TimerEntryOptions): void;
  withContext(context: string): Timer;
  withId(context: string): Timer;
  takeEntries(): TimerEntry[];
}

export interface DefaultTimerOptions {
  /** The maximum number of in-progress timespans to hold in memory before evicting the oldest. Defaults to 500. */
  maxConcurrentSpans?: number;
  /** The maximum number of historical entries to hold in memory before evicting the oldest. Invoke `.takeEntries()` regularly to process timing. Defaults to 1000. */
  maxEntryHistory?: number;
  /** The function used to log start and end events. */
  log?: (entry: {label: string; id?: string; context?: string; event: 'start' | 'end'}) => void;
  /** The object used to determine the current time. */
  time?: TimeController;
}

export class DefaultTimer implements Timer {
  private _options: Required<DefaultTimerOptions>;
  private _pastEntries: Array<TimerEntry> = [];
  private _entriesByKey = new Map<string, TimerEntry>();

  constructor(options?: DefaultTimerOptions) {
    this._options = {
      maxConcurrentSpans: 500,
      maxEntryHistory: 1000,
      time: DEFAULT_TIME_CONTROLLER,
      log: (entry) =>
        log(
          `${entry?.context || 'timer'} ${entry.event} ${DefaultTimer._labelWithId(entry.label, {
            id: entry.id,
          })}`
        ),
      ...options,
    };
  }

  private static _key(label: string, options?: TimerEntryOptions) {
    return `${options?.context || 'default'}@@@${label}@@@${options?.id || ''}`;
  }

  private static _labelWithId(label: string, options?: TimerEntryOptions) {
    if (!options?.id) return label;
    return `${label} (${options.id})`;
  }

  _runGarbageCollection() {
    const numSpansToRemove = this._entriesByKey.size - this._options.maxConcurrentSpans;
    if (numSpansToRemove > 0) {
      const spansToRemove = Array.from(this._entriesByKey.entries())
        .sort((a, b) => a[1].start - b[1].start)
        .slice(0, numSpansToRemove);
      for (const [key] of spansToRemove) {
        this._entriesByKey.delete(key);
      }
    }

    const numEntriesToRemove = this._pastEntries.length - this._options.maxEntryHistory;
    if (numEntriesToRemove > 0) {
      this._pastEntries.splice(0, numEntriesToRemove);
    }
  }

  start(label: string, options?: TimerEntryOptions): void {
    const key = DefaultTimer._key(label, options);
    this._entriesByKey.set(key, {label, start: this._options.time.now(), ...options});
    this._runGarbageCollection();
  }

  end(label: string, options?: TimerEntryOptions): void {
    log(`${options?.context || 'timer'} ended ${DefaultTimer._labelWithId(label, options)}`);
    const key = DefaultTimer._key(label, options);
    const entry = this._entriesByKey.get(key);
    if (!entry) return;

    entry.end = this._options.time.now();
    this._entriesByKey.delete(key);
    this._addEntry(entry);
  }

  _addEntry(entry: TimerEntry): void {
    this._pastEntries.push(entry);
    this._runGarbageCollection();
  }

  withUniqueId(): Timer {
    const id = Math.round(Math.random() ** 32).toString(16);
    return this.withId(id);
  }

  withId(id: string): Timer {
    return {
      start: (label, options) => this.start(label, {...options, id}),
      end: (label, options) => this.end(label, {...options, id}),
      withId: (id) => this.withId(id),
      withContext: (context) => this.withContext(context),
      takeEntries: () => this.takeEntries(),
    };
  }

  withContext(context: string): Timer {
    return {
      start: (label, options) => this.start(label, {...options, context}),
      end: (label, options) => this.end(label, {...options, context}),
      withId: (id) => this.withId(id),
      withContext: (context) => this.withContext(context),
      takeEntries: () => this.takeEntries(),
    };
  }

  takeEntries(): TimerEntry[] {
    const entries = this._pastEntries;
    this._pastEntries = [];
    return entries;
  }
}

export const NOOP_TIMER = new DefaultTimer({maxConcurrentSpans: 0, maxEntryHistory: 0});
