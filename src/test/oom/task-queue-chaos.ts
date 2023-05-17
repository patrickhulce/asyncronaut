import {delay} from '../../common/promises';
import {TaskQueue, TaskState} from '../../common/task-queue';

const SUCCESS_FRACTION = 0.6;
const FAILURE_FRACTION = 0.3;
const FAILURE_CUTOFF = SUCCESS_FRACTION + FAILURE_FRACTION;

async function main() {
  const taskQueue = new TaskQueue<number, string>({
    maxConcurrentTasks: 10,
    maxCompletedTaskMemory: 100,
    async onTask(taskRef) {
      const fate = taskRef.request.input;
      if (fate < SUCCESS_FRACTION) {
        await delay(0);
        let string = '';
        for (let i = 0; i < 1_000_000; i++) string += Math.round(Math.random() * 16).toString(16);
        return string;
      } else if (fate < FAILURE_CUTOFF) {
        await delay(0);
        throw new Error('Task failed!');
      } else {
        // This task will be cancelled!
        await delay(30_000);
        if (!taskRef.signal.reason || (taskRef as any).state !== TaskState.FAILED) {
          console.error('Never should have made it here!', taskRef);
          // eslint-disable-next-line no-process-exit
          process.exit(1);
        }

        throw new Error('Cool it worked');
      }
    },
  });

  taskQueue.on('error', () => {});
  taskQueue.start();

  const counts = {
    [TaskState.QUEUED]: 0,
    [TaskState.ACTIVE]: 0,
    [TaskState.SUCCEEDED]: 0,
    [TaskState.FAILED]: 0,
    [TaskState.CANCELLED]: 0,
  };

  setInterval(() => {
    const usage = process.memoryUsage();
    const inMiB = (x: number) => Math.round((x / 1024 / 1024) * 10) / 10;
    console.log('rss:', inMiB(usage.rss));
    console.log('heapUsed:', inMiB(usage.heapUsed));
    console.log('heapTotal:', inMiB(usage.heapTotal));
    console.log('external:', inMiB(usage.external));
    console.log(counts);
  }, 1_000);

  console.log('Enqueuing tasks...');
  for (let i = 0; i < 10_000; i++) {
    if (i % 1_000 === 0) {
      console.log(`Enqueuing task #${i}...`);
      await delay(0);
      await taskQueue.waitForCompletion();
    }
    const fate = Math.random();
    const taskRef = taskQueue.enqueue(fate);

    taskRef.completed.then(() => {
      counts[taskRef.state]++;
      console.log(`Task #${i} Complete [state=${taskRef.state}]`);
    });

    if (fate >= FAILURE_CUTOFF)
      setTimeout(() => taskRef.abort(), Math.round(30_000 * Math.random()));
  }
}

main();
