import {EventEmitter} from 'events';
import {DecomposedPromise, createDecomposedPromise, withTimeout} from './promises';

export interface QueueOptions<TInput, TOutput> {
  maxConcurrentTasks: number;
  onTask(ref: TaskRef<TInput, TOutput>): Promise<TOutput>;
}

export interface TaskRef<TInput, TOutput> {
  id: string;
  state: TaskState;
  request: TaskRequest<TInput>;
  output: TOutput | undefined;
  error: TaskFailureError | undefined;
  completed: Promise<void>;
  abortController: AbortController;
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

interface TaskRequest<TInput> extends TaskOptions {
  input: TInput;
}

interface InternalTaskRef<TInput, TOutput> extends TaskRef<TInput, TOutput> {
  completionPromiseDecomposed: DecomposedPromise<void>;
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    ((Math.random() * 16) | 0).toString(16)
  );
}

export class TaskFailureError extends Error {
  constructor(public taskRef: TaskRef<unknown, unknown>, public originalError: unknown) {
    super();

    this.taskRef = {...this.taskRef, error: undefined};
    if (originalError instanceof Error) {
      this.message = `(${originalError.name}) ${originalError.message}`;
      this.stack = originalError.stack;
    }
  }
}

export class TaskQueue<TInput, TOutput> extends EventEmitter {
  private _state = QueueState.PAUSED;
  private _options: QueueOptions<TInput, TOutput>;
  private _tasks: Record<TaskState, Array<InternalTaskRef<TInput, TOutput>>> = {
    [TaskState.QUEUED]: [],
    [TaskState.ACTIVE]: [],
    [TaskState.CANCELLED]: [],
    [TaskState.FAILED]: [],
    [TaskState.SUCCEEDED]: [],
  };

  constructor(options?: Partial<QueueOptions<TInput, TOutput>>) {
    super();
    this._options = {
      maxConcurrentTasks: 1,
      onTask() {
        throw new Error('`onTask` left unimplemented in TaskQueue constructor');
      },
      ...options,
    };
  }

  enqueue(input: TInput, options?: TaskOptions): TaskRef<TInput, TOutput> {
    if (this._state === QueueState.DRAINING || this._state === QueueState.DRAINED) {
      throw new Error(`Cannot enqueue tasks to drained queue`);
    }

    const completionPromiseDecomposed = createDecomposedPromise<void>();
    const abortController = new AbortController();

    const signal = options?.signal;
    if (signal) signal.addEventListener('abort', () => abortController.abort(signal.reason));

    const taskRef: InternalTaskRef<TInput, TOutput> = {
      id: uuid(),
      state: TaskState.QUEUED,
      request: {input, ...options},
      output: undefined,
      error: undefined,
      completed: completionPromiseDecomposed.promise,
      completionPromiseDecomposed,
      abortController,
    };

    // Handle removal from the queue when task is aborted.
    // All other flows go through the `withTimeout` handling in `_process`
    abortController.signal.addEventListener('abort', () => {
      if (taskRef.state !== TaskState.QUEUED) return;

      this._tasks[TaskState.CANCELLED].push(taskRef);
      this._tasks[TaskState.QUEUED] = this._tasks[TaskState.QUEUED].filter(
        (ref) => ref !== taskRef
      );
      taskRef.state = TaskState.CANCELLED;
      taskRef.error = new TaskFailureError(taskRef, abortController.signal.reason);
      taskRef.completionPromiseDecomposed.resolve();
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
    for (const taskRef of this._tasks[TaskState.QUEUED]) taskRef.abortController.abort(error);
    for (const taskRef of this._tasks[TaskState.ACTIVE]) taskRef.abortController.abort(error);

    await taskCompletionPromise;
    this._state = QueueState.DRAINED;
  }

  async waitForCompletion(): Promise<void> {
    await this._getPromiseOfAllTasks();
    if (this._tasks[TaskState.QUEUED].length || this._tasks[TaskState.ACTIVE].length) {
      return this.waitForCompletion();
    }
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

  private _processNext() {
    const taskRef = this._tasks[TaskState.QUEUED].shift();
    if (!taskRef) throw new Error('No task queued');

    this._process(taskRef).catch((error) => this.emit('error', error));
  }

  private async _process(taskRef: InternalTaskRef<TInput, TOutput>): Promise<void> {
    taskRef.state = TaskState.ACTIVE;
    this._tasks[TaskState.ACTIVE].push(taskRef);
    await withTimeout(this._options.onTask(taskRef), {
      timeoutMs: 60_000,
      abortController: taskRef.abortController,
    })
      .then((result) => this._processTaskSuccess(taskRef, result))
      .catch((error) => this._processTaskFailure(taskRef, error));

    this._tasks[TaskState.ACTIVE] = this._tasks[TaskState.ACTIVE].filter((ref) => ref !== taskRef);
    this._tasks[taskRef.state].push(taskRef);
    this._startNextIfPossible();
  }

  private _processTaskSuccess(taskRef: InternalTaskRef<TInput, TOutput>, result: TOutput) {
    if (taskRef.state !== TaskState.ACTIVE) return;

    taskRef.state = TaskState.SUCCEEDED;
    taskRef.output = result;

    taskRef.completionPromiseDecomposed.resolve();
  }

  private _processTaskFailure(taskRef: InternalTaskRef<TInput, TOutput>, originalError: unknown) {
    if (originalError instanceof TaskFailureError) return;
    if (taskRef.state !== TaskState.ACTIVE) return;

    const error = new TaskFailureError(taskRef, originalError);
    taskRef.state = TaskState.FAILED;
    taskRef.error = error;
    this.emit('error', error);

    taskRef.completionPromiseDecomposed.resolve();
  }
}
