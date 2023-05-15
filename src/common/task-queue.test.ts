import {flushAllMicrotasks} from './promises';
import {TaskQueue, TaskState} from './task-queue';

describe(TaskQueue, () => {
  let taskQueue: TaskQueue<number, string>;
  let taskHandler: jest.Mock;

  beforeEach(() => {
    taskHandler = jest.fn();
    taskQueue = new TaskQueue<number, string>({onTask: taskHandler});
  });

  describe('enqueue()', () => {
    it('adds a task to the queue and returns a TaskRef', () => {
      const taskRef = taskQueue.enqueue(1);
      expect(taskRef).toMatchObject({
        id: expect.stringContaining('-4'),
        state: TaskState.NOT_STARTED,
        request: {input: 1},
        completed: expect.any(Promise),
        abortController: expect.any(AbortController),
      });
    });
  });

  describe('start()', () => {
    it('processes enqueued tasks', async () => {
      taskHandler.mockResolvedValue('success');

      const taskRef = taskQueue.enqueue(1);
      taskQueue.enqueue(2);
      taskQueue.enqueue(3);
      taskQueue.start();

      expect(taskHandler).toHaveBeenCalledTimes(1);
      expect(taskRef).toMatchObject({state: TaskState.IN_PROGRESS});

      await flushAllMicrotasks();

      expect(taskRef).toMatchObject({state: TaskState.COMPLETED});
      expect(taskHandler).toHaveBeenCalledTimes(3);
    });
  });

  describe('pause()', () => {
    it('stops processing new tasks', async () => {
      taskHandler.mockResolvedValue('success');

      taskQueue.start();
      taskQueue.enqueue(1);
      taskQueue.pause();
      const taskRef2 = taskQueue.enqueue(2);

      expect(taskHandler).toHaveBeenCalledTimes(1);

      await flushAllMicrotasks();

      expect(taskHandler).toHaveBeenCalledTimes(1);
      expect(taskRef2).toMatchObject({state: TaskState.NOT_STARTED});
    });
  });

  describe('drain()', () => {
    it.skip('stops processing new tasks and allows running tasks to complete', async () => {
      taskHandler.mockResolvedValue('success');

      const taskRef1 = taskQueue.enqueue(1);
      const taskRef2 = taskQueue.enqueue(2);

      taskQueue.start();
      await taskQueue.drain();

      expect(taskRef1.state).toBe(TaskState.COMPLETED);
      expect(taskRef2.state).toBe(TaskState.NOT_STARTED);
    });
  });

  describe('waitForCompletion()', () => {
    it('waits for all tasks to complete', async () => {
      taskHandler.mockResolvedValue('success');
      const taskQueue = new TaskQueue<number, string>({
        maxConcurrentTasks: 1,
        onTask: taskHandler,
      });

      const taskRef1 = taskQueue.enqueue(1);
      const taskRef2 = taskQueue.enqueue(2);
      taskQueue.start();

      await taskQueue.waitForCompletion();

      expect(taskRef1.state).toBe(TaskState.COMPLETED);
      expect(taskRef2.state).toBe(TaskState.COMPLETED);
    });
  });
});
