import {EventEmitter} from 'events';
import {DecomposedPromise, createDecomposedPromise, withTimeout} from './promises';

export interface QueueOptions<TInput, TOutput, TProgress> {
  /** The maximum number of tasks that can be active at once, defaults to 1. */
  maxConcurrentTasks: number;
  /** The maximum number of completed tasks that should be saved for diagnostic purposes, defaults to 100. */
  maxCompletedTaskMemory: number;
  /** The function to process tasks in the queue. */
  onTask(
    ref: Pick<TaskRef<TInput, TOutput, TProgress>, 'id' | 'request' | 'signal' | 'emit'>
  ): Promise<TOutput>;
  /** The function to use to acquire the current UNIX timestamp. */
  dateNow(): number;
}

export interface TaskRef<TInput, TOutput, TProgress = ProgressUpdate> {
  /** A unique identifier for the task. */
  id: string;
  /** The current state of this task in the execution lifecycle. */
  state: TaskState;
  /** UNIX timestamp for the time at which this task was enqueued. */
  queuedAt: number;
  /** UNIX timestamp for the time at which this task was completed. */
  completedAt: number | undefined;
  /** The options used when requesting the task, including input arguments. */
  request: TaskRequest<TInput>;
  /** The task's result, only set when the task has completed successfully. */
  output: TOutput | undefined;
  /** The task failure error with which the task was rejected, only set when the task has completed unsuccessfully. */
  error: TaskFailureError | undefined;
  /** A promise representing when the task has settled (either resolved or rejected). */
  completed: Promise<void>;
  /** A signal communicating the requested cancellation of this task. */
  signal: AbortSignal;
  /** A function that aborts the task's execution. */
  abort(reason?: unknown): void;
  /** A function that emits progress events to consumers. */
  emit(name: 'progress', event: TProgress): void;
  /** A function that adds an event listener for progress events. */
  on(name: 'progress', listener: (event: TProgress) => void): void;
  /** A function that removes an event listener for progress events. */
  off(name: 'progress', listener: (event: TProgress) => void): void;
}

export interface TaskOptions {
  signal?: AbortSignal;
}

export enum QueueState {
  RUNNING = 'running',
  PAUSED = 'paused',
  DRAINING = 'draining',
  DRAINED = 'drained',
}

export enum TaskState {
  QUEUED = 'queued',
  ACTIVE = 'active',
  CANCELLED = 'cancelled',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

export interface QueueDiagnostics<TInput, TOutput, TProgress> {
  state: QueueState;
  tasks: Record<TaskState, Array<TaskRef<TInput, TOutput, TProgress>>>;
}

interface TaskRequest<TInput> extends TaskOptions {
  input: TInput;
}

interface InternalTaskRef<TInput, TOutput, TProgress> extends TaskRef<TInput, TOutput, TProgress> {
  /** The underlying decomposed promise for the `completed` property. */
  completedPromiseDecomposed: DecomposedPromise<void>;
  /** The underlying event emitter that powers progress updates. */
  eventEmitter: EventEmitter;
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    ((Math.random() * 16) | 0).toString(16)
  );
}

export class TaskFailureError extends Error {
  constructor(public taskRef: TaskRef<unknown, unknown, unknown>, public reason: unknown) {
    super();

    this.taskRef = {...this.taskRef, error: undefined};
    if (reason instanceof Error) {
      this.message = `(${reason.name}) ${reason.message}`;
      this.stack = reason.stack;
    }
  }
}

export interface ProgressUpdate {
  completedItems: number;
  totalItems: number;
}

export class TaskQueue<TInput, TOutput, TProgress = ProgressUpdate> extends EventEmitter {
  private _state = QueueState.PAUSED;
  private _options: QueueOptions<TInput, TOutput, TProgress>;
  private _tasks: Record<TaskState, Array<InternalTaskRef<TInput, TOutput, TProgress>>> = {
    [TaskState.QUEUED]: [],
    [TaskState.ACTIVE]: [],
    [TaskState.CANCELLED]: [],
    [TaskState.FAILED]: [],
    [TaskState.SUCCEEDED]: [],
  };

  constructor(options?: Partial<QueueOptions<TInput, TOutput, TProgress>>) {
    super();
    this._options = {
      maxConcurrentTasks: 1,
      maxCompletedTaskMemory: 100,
      onTask() {
        throw new Error('`onTask` left unimplemented in TaskQueue constructor');
      },
      dateNow: Date.now,
      ...options,
    };
  }

  enqueue(input: TInput, options?: TaskOptions): TaskRef<TInput, TOutput, TProgress> {
    if (this._state === QueueState.DRAINING || this._state === QueueState.DRAINED) {
      throw new Error(`Cannot enqueue tasks to drained queue`);
    }

    const completedPromiseDecomposed = createDecomposedPromise<void>();
    const abortController = new AbortController();
    const eventEmitter = new EventEmitter();

    const signal = options?.signal;
    if (signal) signal.addEventListener('abort', () => abortController.abort(signal.reason));

    const taskRef: InternalTaskRef<TInput, TOutput, TProgress> = {
      id: uuid(),
      state: TaskState.QUEUED,
      request: {input, ...options},
      queuedAt: this._options.dateNow(),
      completedAt: undefined,
      output: undefined,
      error: undefined,
      completed: completedPromiseDecomposed.promise,
      signal: abortController.signal,
      abort: abortController.abort.bind(abortController),
      emit: eventEmitter.emit.bind(eventEmitter),
      on: eventEmitter.on.bind(eventEmitter),
      off: eventEmitter.off.bind(eventEmitter),

      completedPromiseDecomposed,
      eventEmitter,
    };

    // Handle removal from the queue when task is aborted.
    // All other flows go through the `withTimeout` handling in `_process`
    taskRef.signal.addEventListener('abort', () => {
      this._processTaskCancellation(taskRef);
    });

    this._tasks[TaskState.QUEUED].push(taskRef);
    this._startNextIfPossible();
    return taskRef;
  }

  start(): void {
    if (this._state === QueueState.RUNNING) return;

    if (this._state !== QueueState.PAUSED) {
      throw new Error(`Queue cannot move to started from "${this._state}"`);
    }

    this._state = QueueState.RUNNING;
    this._startNextIfPossible();
  }

  pause(): void {
    if (this._state === QueueState.PAUSED) return;

    if (this._state !== QueueState.RUNNING) {
      throw new Error(`Queue cannot move to started from "${this._state}"`);
    }

    this._state = QueueState.PAUSED;
  }

  async drain(): Promise<void> {
    this._state = QueueState.DRAINING;
    const taskCompletionPromise = this.waitForCompletion();

    const error = new Error('Task queue drained');
    for (const taskRef of this._tasks[TaskState.QUEUED]) taskRef.abort(error);
    for (const taskRef of this._tasks[TaskState.ACTIVE]) taskRef.abort(error);

    await taskCompletionPromise;
    this._state = QueueState.DRAINED;
  }

  async waitForCompletion(): Promise<void> {
    await this._getPromiseOfAllTasks();
    if (this._tasks[TaskState.QUEUED].length || this._tasks[TaskState.ACTIVE].length) {
      return this.waitForCompletion();
    }
  }

  getDiagnostics(): QueueDiagnostics<TInput, TOutput, TProgress> {
    return {
      state: this._state,
      tasks: {
        [TaskState.QUEUED]: this._tasks[TaskState.QUEUED].slice(),
        [TaskState.ACTIVE]: this._tasks[TaskState.ACTIVE].slice(),
        [TaskState.CANCELLED]: this._tasks[TaskState.CANCELLED].slice(),
        [TaskState.FAILED]: this._tasks[TaskState.FAILED].slice(),
        [TaskState.SUCCEEDED]: this._tasks[TaskState.SUCCEEDED].slice(),
      },
    };
  }

  private async _getPromiseOfAllTasks(): Promise<void> {
    const queuedPromises = this._tasks[TaskState.QUEUED].map((ref) => ref.completed);
    const activePromises = this._tasks[TaskState.ACTIVE].map((ref) => ref.completed);
    await Promise.all([...queuedPromises, ...activePromises]);
  }

  private _startNextIfPossible() {
    if (this._state !== QueueState.RUNNING) return;
    if (this._tasks[TaskState.ACTIVE].length >= this._options.maxConcurrentTasks) return;
    if (!this._tasks[TaskState.QUEUED].length) return;

    this._processNext();
  }

  private _garbageCollectCompletedTasks() {
    const completedTasks = [
      ...this._tasks[TaskState.SUCCEEDED],
      ...this._tasks[TaskState.FAILED],
      ...this._tasks[TaskState.CANCELLED],
    ].sort((a, b) => (a.completedAt || Infinity) - (b.completedAt || Infinity));

    const numTasksToGc = Math.max(0, completedTasks.length - this._options.maxCompletedTaskMemory);
    const taskRefsToGc = completedTasks.slice(0, numTasksToGc);
    for (const taskRef of taskRefsToGc) {
      taskRef.eventEmitter.removeAllListeners();
      this._tasks[taskRef.state] = this._tasks[taskRef.state].filter((ref) => taskRef !== ref);
    }
  }

  private _processNext() {
    const taskRef = this._tasks[TaskState.QUEUED].shift();
    if (!taskRef) throw new Error('No task queued');

    this._process(taskRef).catch((error) => this.emit('error', error));
  }

  private async _process(taskRef: InternalTaskRef<TInput, TOutput, TProgress>): Promise<void> {
    taskRef.state = TaskState.ACTIVE;
    this._tasks[TaskState.ACTIVE].push(taskRef);
    await withTimeout(this._options.onTask(taskRef), {
      timeoutMs: 60_000,
      abortController: taskRef,
    })
      .then((result) => this._processTaskSuccess(taskRef, result))
      .catch((error) => this._processTaskFailure(taskRef, error));

    this._startNextIfPossible();
  }

  private _processTaskCancellation(taskRef: InternalTaskRef<TInput, TOutput, TProgress>) {
    if (taskRef.state !== TaskState.QUEUED) return;

    taskRef.state = TaskState.CANCELLED;
    taskRef.error = new TaskFailureError(taskRef, taskRef.signal.reason);
    taskRef.completedAt = this._options.dateNow();

    this._tasks[TaskState.QUEUED] = this._tasks[TaskState.QUEUED].filter((ref) => ref !== taskRef);
    this._tasks[TaskState.CANCELLED].push(taskRef);
    this._garbageCollectCompletedTasks();

    taskRef.completedPromiseDecomposed.resolve();
  }

  private _processTaskSuccess(
    taskRef: InternalTaskRef<TInput, TOutput, TProgress>,
    result: TOutput
  ) {
    if (taskRef.state !== TaskState.ACTIVE) return;

    taskRef.state = TaskState.SUCCEEDED;
    taskRef.output = result;
    taskRef.completedAt = this._options.dateNow();

    this._tasks[TaskState.ACTIVE] = this._tasks[TaskState.ACTIVE].filter((ref) => ref !== taskRef);
    this._tasks[TaskState.SUCCEEDED].push(taskRef);
    this._garbageCollectCompletedTasks();

    taskRef.completedPromiseDecomposed.resolve();
  }

  private _processTaskFailure(
    taskRef: InternalTaskRef<TInput, TOutput, TProgress>,
    originalError: unknown
  ) {
    if (originalError instanceof TaskFailureError) return;
    if (taskRef.state !== TaskState.ACTIVE) return;

    const error = new TaskFailureError(taskRef, originalError);
    taskRef.state = TaskState.FAILED;
    taskRef.error = error;
    taskRef.completedAt = this._options.dateNow();

    this._tasks[TaskState.ACTIVE] = this._tasks[TaskState.ACTIVE].filter((ref) => ref !== taskRef);
    this._tasks[TaskState.FAILED].push(taskRef);
    this._garbageCollectCompletedTasks();

    this.emit('error', error);
    taskRef.completedPromiseDecomposed.resolve();
  }
}
