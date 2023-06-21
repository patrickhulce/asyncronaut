import {createDecomposedPromise, flushAllMicrotasks, delay, withInspection} from './promises';
import {
  ProgressUpdate,
  QueueState,
  TaskFailureError,
  TaskQueue,
  TaskRef,
  TaskState,
} from './task-queue';

import '../test/jest';

function onTaskMock(
  intent: 'abort-respecting'
): (taskRef: TaskRef<number, string>) => Promise<string> {
  if (intent === 'abort-respecting') {
    return async (taskRef) => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        taskRef.signal.throwIfAborted();
        await delay(100);
      }
    };
  }

  throw new Error(`Unrecognized intent "${intent}"`);
}

describe(TaskQueue, () => {
  let taskQueue: TaskQueue<number, string>;
  let taskHandler: jest.Mock;
  let dateNowFn: jest.Mock;

  beforeEach(() => {
    let dateNowValue = 1_000;
    dateNowFn = jest.fn().mockImplementation(() => dateNowValue++);
    taskHandler = jest.fn();
    taskQueue = new TaskQueue<number, string>({onTask: taskHandler, now: dateNowFn});

    jest.useFakeTimers();
  });

  afterEach(async () => {
    // Catch any floating errors that may be lingering.
    await jest.advanceTimersByTimeAsync(600_000);
    await flushAllMicrotasks();

    // Go back to real timers to cleanup.
    jest.useRealTimers();
    dateNowFn.mockRestore();
  });

  describe('enqueue()', () => {
    it('adds a task to the queue and returns a TaskRef', () => {
      const taskRef = taskQueue.enqueue(1);
      expect(taskRef).toMatchObject({
        id: expect.stringContaining('-4'),
        state: TaskState.QUEUED,
        request: {input: 1},
        completed: expect.any(Promise),
        signal: expect.anything(),
        abort: expect.anything(),
      });
    });

    it('starts the task when there is available capacity', async () => {
      taskHandler.mockResolvedValue('');
      taskQueue.start();

      const taskRef1 = taskQueue.enqueue(1);
      expect(taskRef1.state).toEqual(TaskState.ACTIVE);
    });

    it('only processes the number of tasks specified in maxConcurrentTasks', async () => {
      taskHandler.mockResolvedValue('');
      taskQueue = new TaskQueue({maxConcurrentTasks: 2, onTask: taskHandler});
      taskQueue.start();

      const taskRef1 = taskQueue.enqueue(1);
      const taskRef2 = taskQueue.enqueue(2);
      const taskRef3 = taskQueue.enqueue(3);

      expect(taskRef1.state).toEqual(TaskState.ACTIVE);
      expect(taskRef2.state).toEqual(TaskState.ACTIVE);
      expect(taskRef3.state).toEqual(TaskState.QUEUED);
    });

    it('successfully resolves the output of onTask', async () => {
      taskHandler.mockResolvedValue('success');
      taskQueue.start();

      const taskRef = taskQueue.enqueue(1);
      const completedPromise = withInspection(taskRef.completed);

      await flushAllMicrotasks();

      expect(completedPromise).toBeDone();
      expect(taskRef.output).toEqual('success');
    });

    it('starts the next task when the previous one finishes successfully', async () => {
      const onTaskDecomposed = createDecomposedPromise<void>();
      taskHandler.mockResolvedValueOnce('success').mockReturnValueOnce(onTaskDecomposed.promise);
      taskQueue.start();

      const taskRef1 = taskQueue.enqueue(1);
      const taskRef2 = taskQueue.enqueue(2);
      const completedPromise = withInspection(taskRef2.completed);

      await flushAllMicrotasks();

      expect(taskRef1.state).toEqual(TaskState.SUCCEEDED);
      expect(taskRef2.state).toEqual(TaskState.ACTIVE);
      expect(completedPromise).not.toBeDone();

      onTaskDecomposed.resolve();
      await flushAllMicrotasks();

      expect(taskRef2.state).toEqual(TaskState.SUCCEEDED);
      expect(completedPromise).toBeDone();
    });

    it('starts the next task when the previous one finishes in error', async () => {
      const onErrorFn = jest.fn();
      taskQueue.on('error', onErrorFn);

      const onTaskDecomposed = createDecomposedPromise<void>();
      taskHandler
        .mockRejectedValueOnce(new Error('Task failed'))
        .mockReturnValueOnce(onTaskDecomposed.promise);
      taskQueue.start();

      const taskRef1 = taskQueue.enqueue(1);
      const taskRef2 = taskQueue.enqueue(2);
      const completedPromise = withInspection(taskRef2.completed);

      await flushAllMicrotasks();

      expect(taskRef1.state).toEqual(TaskState.FAILED);
      expect(taskRef2.state).toEqual(TaskState.ACTIVE);
      expect(completedPromise).not.toBeDone();
      expect(onErrorFn).toHaveBeenCalled();

      onTaskDecomposed.resolve();
      await flushAllMicrotasks();

      expect(taskRef2.state).toEqual(TaskState.SUCCEEDED);
      expect(completedPromise).toBeDone();
    });

    it('starts the next task when the previous one finishes via cancellation', async () => {
      const onTaskDecomposed = createDecomposedPromise<void>();
      taskHandler.mockResolvedValueOnce('success').mockResolvedValueOnce(onTaskDecomposed.promise);
      taskQueue.start();

      taskQueue.enqueue(1);
      const taskRef2 = taskQueue.enqueue(2);
      const taskRef3 = taskQueue.enqueue(2);

      taskRef2.abort();
      await flushAllMicrotasks();

      expect(taskRef2.state).toEqual(TaskState.CANCELLED);
      expect(taskRef3.state).toEqual(TaskState.ACTIVE);

      onTaskDecomposed.resolve();
    });

    it('emits progress updates', async () => {
      taskHandler.mockImplementation(async (taskRef: TaskRef<number, string>) => {
        await delay(1_000);
        taskRef.emit('progress', {completedItems: 1, totalItems: 3});
        await delay(1_000);
        taskRef.emit('progress', {completedItems: 2, totalItems: 3});
        await delay(1_000);
        return 'success';
      });

      const updates: Array<ProgressUpdate> = [];
      const taskRef = taskQueue.enqueue(1);
      taskRef.on('progress', (update) => updates.push(update));
      taskQueue.start();

      await jest.advanceTimersByTimeAsync(1_000);
      expect(updates).toMatchObject([{completedItems: 1, totalItems: 3}]);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(updates).toMatchObject([{}, {completedItems: 2, totalItems: 3}]);
    });

    it('does not set output when task is aborted but onTask resolves', async () => {
      const onErrorFn = jest.fn();
      taskQueue.on('error', onErrorFn);

      const onTaskDecomposed = createDecomposedPromise<void>();
      taskHandler.mockResolvedValueOnce(onTaskDecomposed.promise);
      taskQueue.start();

      const taskRef = taskQueue.enqueue(1);
      const completedPromise = withInspection(taskRef.completed);

      await flushAllMicrotasks();
      taskRef.abort();
      await flushAllMicrotasks();

      expect(completedPromise).toBeDone();
      expect(taskRef.state).toEqual(TaskState.CANCELLED);
      expect(taskRef.error).toBeInstanceOf(TaskFailureError);
      expect(taskRef.output).toBeUndefined();
      expect(onErrorFn).not.toHaveBeenCalled();

      onTaskDecomposed.resolve();
      await flushAllMicrotasks();

      expect(completedPromise).toBeDone();
      expect(taskRef.state).toEqual(TaskState.CANCELLED);
      expect(taskRef.error).toBeInstanceOf(TaskFailureError);
      expect(taskRef.output).toBeUndefined();
    });

    it('does not override error when task is aborted but onTask rejects', async () => {
      const onErrorFn = jest.fn();
      taskQueue.on('error', onErrorFn);

      const onTaskDecomposed = createDecomposedPromise<void>();
      taskHandler.mockResolvedValueOnce(onTaskDecomposed.promise);
      taskQueue.start();

      const taskRef = taskQueue.enqueue(1);
      const completedPromise = withInspection(taskRef.completed);

      await flushAllMicrotasks();
      taskRef.abort();
      await flushAllMicrotasks();

      expect(completedPromise).toBeDone();
      expect(taskRef.state).toEqual(TaskState.CANCELLED);
      expect(taskRef.error).toBeInstanceOf(TaskFailureError);

      const firstError = taskRef.error;
      const originalError = firstError?.reason;
      const rejectError = new Error('onTask rejects');
      onTaskDecomposed.reject(rejectError);
      await flushAllMicrotasks();

      expect(taskRef.error).toBe(firstError);
      expect(taskRef.error).toHaveProperty('reason', originalError);
      expect(taskRef.error).not.toHaveProperty('reason', rejectError);
    });

    it('fails the task when handler rejects', async () => {
      const error = new Error('HANDLER_FAILURE');
      taskHandler.mockRejectedValue(error);

      const onErrorFn = jest.fn();
      taskQueue.on('error', onErrorFn);
      taskQueue.start();

      const taskRef = taskQueue.enqueue(1);
      const completedPromise = withInspection(taskRef.completed);

      await flushAllMicrotasks();

      expect(completedPromise).toBeDone();
      expect(taskRef.state).toEqual(TaskState.FAILED);
      expect(taskRef.error).toBeInstanceOf(TaskFailureError);
      expect(taskRef.error?.reason).toBe(error);
      expect(onErrorFn).toHaveBeenCalledWith(taskRef.error);
    });

    describe('maxQueuedTasks', () => {
      it('throws when queue is running and limit is exceeded', async () => {
        taskHandler.mockResolvedValue('');
        taskQueue = new TaskQueue({maxQueuedTasks: 0, maxConcurrentTasks: 2, onTask: taskHandler});
        taskQueue.start();

        const taskRef1 = taskQueue.enqueue(1);
        const taskRef2 = taskQueue.enqueue(2);

        expect(taskRef1.state).toEqual(TaskState.ACTIVE);
        expect(taskRef2.state).toEqual(TaskState.ACTIVE);

        expect(() => taskQueue.enqueue(3)).toThrow();
      });

      it('throws when queue is paused and limit is exceeded', async () => {
        taskHandler.mockResolvedValue('');
        taskQueue = new TaskQueue({maxQueuedTasks: 2, onTask: taskHandler});
        taskQueue.pause();

        taskQueue.enqueue(1);
        taskQueue.enqueue(2);

        expect(() => taskQueue.enqueue(3)).toThrow();
      });
    });
  });

  describe('start()', () => {
    it('processes enqueued tasks', async () => {
      taskHandler.mockResolvedValue('success');

      const taskRef1 = taskQueue.enqueue(1);
      const taskRef2 = taskQueue.enqueue(2);
      const taskRef3 = taskQueue.enqueue(3);
      taskQueue.start();

      expect(taskHandler).toHaveBeenCalledTimes(1);
      expect(taskRef1).toMatchObject({state: TaskState.ACTIVE});

      await flushAllMicrotasks();

      expect(taskRef1).toMatchObject({state: TaskState.SUCCEEDED});
      expect(taskRef2).toMatchObject({state: TaskState.SUCCEEDED});
      expect(taskRef3).toMatchObject({state: TaskState.SUCCEEDED});
      expect(taskHandler).toHaveBeenCalledTimes(3);
    });

    it('cancels the task when passed signal aborts', async () => {
      taskHandler.mockResolvedValue('');
      const onErrorFn = jest.fn();
      taskQueue.on('error', onErrorFn);
      taskQueue.start();

      const abortController = new AbortController();
      const taskRef = taskQueue.enqueue(1, {signal: abortController.signal});

      abortController.abort();
      await flushAllMicrotasks();

      expect(taskRef.state).toEqual(TaskState.CANCELLED);
      expect(taskRef.error).toBeInstanceOf(TaskFailureError);
      expect(onErrorFn).not.toHaveBeenCalled();
    });

    it('cancels the task when returned abortController is aborted', async () => {
      taskHandler.mockResolvedValue('');
      const onErrorFn = jest.fn();
      taskQueue.on('error', onErrorFn);
      taskQueue.start();

      const taskRef = taskQueue.enqueue(1);
      taskRef.abort();
      await flushAllMicrotasks();

      expect(taskRef.state).toEqual(TaskState.CANCELLED);
      expect(taskRef.error).toBeInstanceOf(TaskFailureError);
      expect(onErrorFn).not.toHaveBeenCalled();
    });

    it('throws when called on drained queue', async () => {
      taskHandler.mockResolvedValue('success');

      await taskQueue.drain();
      expect(() => taskQueue.start()).toThrow();
    });
  });

  describe('pause()', () => {
    it('stops processing new tasks and allows existing to finish', async () => {
      taskHandler.mockResolvedValue('success');

      taskQueue.start();
      const taskRef1 = taskQueue.enqueue(1);
      taskQueue.pause();
      const taskRef2 = taskQueue.enqueue(2);

      expect(taskHandler).toHaveBeenCalledTimes(1);

      await flushAllMicrotasks();

      expect(taskHandler).toHaveBeenCalledTimes(1);
      expect(taskRef1).toMatchObject({state: TaskState.SUCCEEDED});
      expect(taskRef2).toMatchObject({state: TaskState.QUEUED});
    });

    it('can be resumed', async () => {
      taskHandler.mockResolvedValue('success');

      taskQueue.start();
      taskQueue.enqueue(1);
      taskQueue.pause();
      const taskRef2 = taskQueue.enqueue(2);

      await flushAllMicrotasks();
      expect(taskRef2).toMatchObject({state: TaskState.QUEUED});

      taskQueue.start();
      expect(taskRef2).toMatchObject({state: TaskState.ACTIVE});
      await flushAllMicrotasks();
      expect(taskRef2).toMatchObject({state: TaskState.SUCCEEDED});
    });

    it('throws when called on drained queue', async () => {
      taskHandler.mockResolvedValue('success');

      await taskQueue.drain();
      expect(() => taskQueue.pause()).toThrow();
    });
  });

  describe('drain()', () => {
    it('stops processing new tasks', async () => {
      taskHandler.mockResolvedValue('success');
      taskQueue.start();
      const drainPromise = withInspection(taskQueue.drain());

      expect(() => taskQueue.enqueue(1)).toThrow();

      await flushAllMicrotasks();
      expect(drainPromise).toBeDone();
    });

    it('cancels queued tasks', async () => {
      const onErrorFn = jest.fn();
      taskQueue.on('error', onErrorFn);

      const onTaskDecomposed = createDecomposedPromise<void>();
      taskHandler.mockResolvedValue(onTaskDecomposed.promise);
      taskQueue.start();

      const taskRef1 = taskQueue.enqueue(1);
      const taskRef2 = taskQueue.enqueue(2);
      const completedPromise1 = withInspection(taskRef1.completed);
      const completedPromise2 = withInspection(taskRef2.completed);
      const drainPromise = withInspection(taskQueue.drain());

      await flushAllMicrotasks();

      expect(taskRef1.state).toEqual(TaskState.CANCELLED);
      expect(taskRef2.state).toEqual(TaskState.CANCELLED);
      expect(completedPromise1).toBeDone();
      expect(completedPromise2).toBeDone();
      expect(drainPromise).toBeDone();
      expect(onErrorFn).toHaveBeenCalledTimes(0);
    });

    it('aborts active tasks', async () => {
      const onErrorFn = jest.fn();
      taskQueue.on('error', onErrorFn);

      const onTaskDecomposed = createDecomposedPromise<void>();
      taskHandler.mockResolvedValue(onTaskDecomposed.promise);
      taskQueue.start();

      const taskRef = taskQueue.enqueue(1);
      const abortFn = jest.spyOn(taskRef, 'abort');
      const signalPromise = withInspection(
        new Promise((resolve) => taskRef.signal.addEventListener('abort', resolve))
      );
      const drainPromise = withInspection(taskQueue.drain());

      expect(abortFn).toHaveBeenCalled();
      expect(taskRef.state).toEqual(TaskState.ACTIVE);

      onTaskDecomposed.resolve();
      await flushAllMicrotasks();

      expect(drainPromise).toBeDone();
      expect(signalPromise).toBeDone();
      expect(taskRef.state).toEqual(TaskState.CANCELLED);
    });
  });

  describe('waitForCompletion()', () => {
    it('waits for all tasks to complete', async () => {
      taskHandler.mockResolvedValue('success');

      const taskRef1 = taskQueue.enqueue(1);
      const taskRef2 = taskQueue.enqueue(2);
      taskQueue.start();

      expect(taskRef1).toMatchObject({state: TaskState.ACTIVE});
      expect(taskRef2).toMatchObject({state: TaskState.QUEUED});

      await taskQueue.waitForCompletion();

      expect(taskRef1).toMatchObject({state: TaskState.SUCCEEDED});
      expect(taskRef2).toMatchObject({state: TaskState.SUCCEEDED});
    });
  });

  describe('getDiagnostics()', () => {
    it('returns the queue state', async () => {
      expect(taskQueue.getDiagnostics()).toMatchObject({state: QueueState.PAUSED});
      taskQueue.start();
      expect(taskQueue.getDiagnostics()).toMatchObject({state: QueueState.RUNNING});
      const drainPromise = withInspection(taskQueue.drain());
      expect(taskQueue.getDiagnostics()).toMatchObject({state: QueueState.DRAINING});
      await flushAllMicrotasks();
      expect(drainPromise).toBeDone();
      expect(taskQueue.getDiagnostics()).toMatchObject({state: QueueState.DRAINED});
    });

    it('returns tasks in each state', async () => {
      const onErrorFn = jest.fn();
      taskQueue.on('error', onErrorFn);

      const onTaskDecomposed = createDecomposedPromise<void>();
      taskHandler
        .mockResolvedValueOnce('success')
        .mockRejectedValueOnce(new Error('Task failure'))
        .mockResolvedValueOnce(onTaskDecomposed.promise)
        .mockResolvedValueOnce('success');

      const taskRef1 = taskQueue.enqueue(1);
      const taskRef2 = taskQueue.enqueue(2);
      const taskRef3 = taskQueue.enqueue(3);
      const taskRef4 = taskQueue.enqueue(4);
      const taskRef5 = taskQueue.enqueue(5);

      taskRef3.abort();
      await flushAllMicrotasks();

      taskQueue.start();
      await jest.advanceTimersByTimeAsync(1_000);
      await flushAllMicrotasks();

      expect(taskRef1).toMatchObject({state: TaskState.SUCCEEDED});
      expect(taskRef2).toMatchObject({state: TaskState.FAILED});
      expect(taskRef3).toMatchObject({state: TaskState.CANCELLED});
      expect(taskRef4).toMatchObject({state: TaskState.ACTIVE});
      expect(taskRef5).toMatchObject({state: TaskState.QUEUED});

      expect(taskQueue.getDiagnostics()).toMatchObject({
        tasks: {
          [TaskState.QUEUED]: [taskRef5],
          [TaskState.ACTIVE]: [taskRef4],
          [TaskState.CANCELLED]: [taskRef3],
          [TaskState.FAILED]: [taskRef2],
          [TaskState.SUCCEEDED]: [taskRef1],
        },
      });

      onTaskDecomposed.resolve();
    });

    it('limits diagnostics to maxCompletedTaskMemory', async () => {
      taskHandler.mockImplementation((taskRef: TaskRef<number, string>) =>
        taskRef.request.input % 3 === 0
          ? Promise.resolve('success')
          : Promise.reject(new Error(`Task failure #${taskRef.request.input}`))
      );

      taskQueue = new TaskQueue({
        maxCompletedTaskMemory: 30,
        onTask: taskHandler,
        now: dateNowFn,
      });
      taskQueue.on('error', jest.fn());
      taskQueue.start();

      // Create 60 tasks that will have the following states repeating SUCCEEDED,FAILED,CANCELLED
      const tasks: TaskRef<number, string>[] = [];
      for (let i = 0; i < 60; i++) {
        const taskRef = taskQueue.enqueue(i);
        tasks.push(taskRef);
        if (i % 3 === 2) taskRef.abort();
      }

      await flushAllMicrotasks();

      for (let i = 0; i < 60; i++) {
        if (i % 3 === 0) expect(tasks[i]).toMatchObject({state: TaskState.SUCCEEDED});
        if (i % 3 === 1) expect(tasks[i]).toMatchObject({state: TaskState.FAILED});
        if (i % 3 === 2) expect(tasks[i]).toMatchObject({state: TaskState.CANCELLED});
      }

      const diagnostics = taskQueue.getDiagnostics();
      expect(diagnostics.tasks[TaskState.SUCCEEDED]).toHaveLength(15);
      expect(diagnostics.tasks[TaskState.FAILED]).toHaveLength(15);
      expect(diagnostics.tasks[TaskState.CANCELLED]).toHaveLength(0);
    });
  });

  it('emits TaskFailureError when the onTask function rejects', async () => {
    const onErrorFn = jest.fn();
    taskQueue.on('error', onErrorFn);
    taskHandler.mockRejectedValue(new Error('onTask rejected'));
    taskQueue.start();

    const taskRef = taskQueue.enqueue(1);
    const completedPromise = withInspection(taskRef.completed);

    await flushAllMicrotasks();

    expect(completedPromise).toBeDone();
    expect(taskRef.error).toBeInstanceOf(TaskFailureError);
  });

  it('emits TaskFailureError when the taskRef is aborted', async () => {
    const onErrorFn = jest.fn();
    taskQueue.on('error', onErrorFn);
    taskHandler.mockImplementation(onTaskMock('abort-respecting'));
    taskQueue.start();

    const taskRef = taskQueue.enqueue(1);
    const completedPromise = withInspection(taskRef.completed);
    taskRef.abort();

    await flushAllMicrotasks();

    expect(completedPromise).toBeDone();
    expect(taskRef.error).toBeInstanceOf(TaskFailureError);
  });

  it('emits TaskFailureError when the taskRef times out', async () => {
    const onErrorFn = jest.fn();
    taskQueue.on('error', onErrorFn);
    taskHandler.mockReturnValue(new Promise(() => {}));
    taskQueue.start();

    const taskRef = taskQueue.enqueue(1);
    const completedPromise = withInspection(taskRef.completed);

    await jest.advanceTimersByTimeAsync(60_001);
    await flushAllMicrotasks();

    expect(completedPromise).toBeDone();
    expect(taskRef.error).toBeInstanceOf(TaskFailureError);
  });
});
