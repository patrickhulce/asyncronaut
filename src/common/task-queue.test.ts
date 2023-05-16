import {createDecomposedPromise, flushAllMicrotasks, waitMs, withInspection} from './promises';
import {TaskFailureError, TaskQueue, TaskRef, TaskState} from './task-queue';

import '../test/jest';

function onTaskMock(
  intent: 'abort-respecting'
): (taskRef: TaskRef<number, string>) => Promise<string> {
  if (intent === 'abort-respecting') {
    return async (taskRef) => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        taskRef.signal.throwIfAborted();
        await waitMs(100);
      }
    };
  }

  throw new Error(`Unrecognized intent "${intent}"`);
}

describe(TaskQueue, () => {
  let taskQueue: TaskQueue<number, string>;
  let taskHandler: jest.Mock;

  beforeEach(() => {
    taskHandler = jest.fn();
    taskQueue = new TaskQueue<number, string>({onTask: taskHandler});
    jest.useFakeTimers();
  });

  afterEach(async () => {
    await jest.advanceTimersByTimeAsync(600_000);
    await flushAllMicrotasks();
    jest.useRealTimers();
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
      expect(taskRef.state).toEqual(TaskState.FAILED);
      expect(taskRef.error).toBeInstanceOf(TaskFailureError);
      expect(taskRef.output).toBeUndefined();

      onTaskDecomposed.resolve();
      await flushAllMicrotasks();

      expect(completedPromise).toBeDone();
      expect(taskRef.state).toEqual(TaskState.FAILED);
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
      expect(taskRef.state).toEqual(TaskState.FAILED);
      expect(taskRef.error).toBeInstanceOf(TaskFailureError);

      const firstError = taskRef.error;
      const originalError = firstError?.originalError;
      const rejectError = new Error('onTask rejects');
      onTaskDecomposed.reject(rejectError);
      await flushAllMicrotasks();

      expect(taskRef.error).toBe(firstError);
      expect(taskRef.error).toHaveProperty('originalError', originalError);
      expect(taskRef.error).not.toHaveProperty('originalError', rejectError);
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

    it('fails the task when passed signal aborts', async () => {
      taskHandler.mockResolvedValue('');
      const onErrorFn = jest.fn();
      taskQueue.on('error', onErrorFn);
      taskQueue.start();

      const abortController = new AbortController();
      const taskRef = taskQueue.enqueue(1, {signal: abortController.signal});

      abortController.abort();
      await flushAllMicrotasks();

      expect(taskRef.state).toEqual(TaskState.FAILED);
      expect(taskRef.error).toBeInstanceOf(TaskFailureError);
      expect(onErrorFn).toHaveBeenCalled();
    });

    it('fails the task when returned abortController is aborted', async () => {
      taskHandler.mockResolvedValue('');
      const onErrorFn = jest.fn();
      taskQueue.on('error', onErrorFn);
      taskQueue.start();

      const taskRef = taskQueue.enqueue(1);
      taskRef.abort();
      await flushAllMicrotasks();

      expect(taskRef.state).toEqual(TaskState.FAILED);
      expect(taskRef.error).toBeInstanceOf(TaskFailureError);
    });

    it('throws when called on drained queue', async () => {
      taskHandler.mockResolvedValue('success');

      await taskQueue.drain();
      expect(() => taskQueue.pause()).toThrow();
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

      expect(taskRef1.state).toEqual(TaskState.FAILED);
      expect(taskRef2.state).toEqual(TaskState.CANCELLED);
      expect(completedPromise1).toBeDone();
      expect(completedPromise2).toBeDone();
      expect(drainPromise).toBeDone();
      expect(onErrorFn).toHaveBeenCalledTimes(1);
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
      expect(taskRef.state).toEqual(TaskState.FAILED);
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
