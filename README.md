# asyncronaut

Asyncronaut is a hodgepodge of utilities to make working with common asynchronous tasks in JavaScript easier. It provides interfaces to effectively manage promises, task queues, pools, and streams, with advanced features like signal-based cancellation and discrete poll smoothing, retry, inspection and more.

For detailed usage and configuration options, please refer to the [official `asyncronaut` documentation](https://patrickhulce.github.io/asyncronaut/).

## Installation

```bash
npm i asyncronaut
```

## Usage

### Promises

```typescript
import {
  delay,
  withTimeout,
  withRetry,
  withInspection,
  createDecomposedPromise,
  flushAllMicrotasks,
} from 'asyncronaut';
```

#### Delay

Defers execution of the subsequent microtask for a specified duration.

```typescript
await delay(2000);
console.log('This message will be printed after a delay of 2 seconds');
```

#### CreateDecomposedPromise

Creates a promise with exposed resolve and reject methods.

```typescript
const {promise, resolve, reject} = createDecomposedPromise();
stream.on('error', reject);
stream.on('close', resolve);
return promise;
```

#### WithTimeout

Adds timeout management to an existing promise that respects existing abortController signals.

```typescript
import {AbortController} from 'abort-controller';
import {withTimeout, AbortError} from 'asyncronaut/promises';

// Create an AbortController
const abortController = new AbortController();

// Create a promise that resolves in 5 seconds
const promise = new Promise((resolve) => setTimeout(resolve, 5000));

// Add a timeout and abort controller to the promise
const promiseWithTimeout = withTimeout(promise, {
  timeoutMs: 3000,
  abortController: abortController,
});

// Abort the promise after 2 seconds
setTimeout(() => abortController.abort(), 2000);

promiseWithTimeout.catch((error) => {
  if (error instanceof AbortError) {
    console.log('Promise was aborted before timeout');
  } else {
    console.log('Promise timed out');
  }
});
```

#### WithRetry

Retries a promise-returning function in case of failure.

```typescript
const action = () => fetch('https://api.mysite.com/data');
const actionWithRetry = withRetry(action, {
  retries: 3,
  cleanup: () => fetch('https://api.mysite.com/reset'),
});
```

#### FlushAllMicrotasks

Flushes all pending microtasks from the queue.

Use case: In testing scenarios, we can ensure all microtasks are completed before asserting the test outcomes.

```typescript
test('all microtasks are flushed', async () => {
  // trigger some microtasks
  Promise.resolve().then(() => console.log('Microtask completed'));
  // flush all microtasks
  await flushAllMicrotasks();
  // Now we can assert the outcomes
});
```

#### WithInspection

Augments a promise to enable synchronous inspection of its state.

```typescript
const promise = fetch('https://api.mysite.com/data');
const inspectablePromise = withInspection(promise);

await delay(1_000);

if (!inspectablePromise.isDone()) {
  // Fetch is still pending after 1 second.
}
```

### Task Queue

```typescript
import {TaskQueue} from 'asyncronaut';
```

#### TaskQueue

Creates a task queue with configurable concurrency and lifecycle events.

```typescript
const taskQueue = new TaskQueue({
  maxConcurrentTasks: 5,
  onTask: (taskRef) => processTask(taskRef.request.input),
});

taskQueue.enqueue({input: taskData});
```

### Streams

```typescript
import {
  fromNode,
  createSmoothStreamViaPoll,
  CHARACTER_SMOOTH_STREAM_OPTIONS,
} from 'asyncronaut/streams/web';
```

#### FromNode

Converts a Node.js readable stream to a web readable stream.

```typescript
const nodeStream = fs.createReadStream('/path/to/file');
const webStream = fromNode(nodeStream);
```

#### CreateSmoothStreamViaPoll

Creates a smooth stream of data fetched from a poll-based fetcher.

Use case: Continuously fetching state updates from a remote server and streaming them to the client. This could be used to create a real-time dashboard or live-updating visual display.

```typescript
import {createSmoothStreamViaPoll, CHARACTER_SMOOTH_STREAM_OPTIONS} from 'asyncronaut/streams/web';

const options = {
  ...CHARACTER_SMOOTH_STREAM_OPTIONS,
  poll: async () => {
    // Fetch some text from a server
    const response = await fetch('https://api.mysite.com/text');
    const text = await response.text();
    return {
      state: text,
      isDone: false, // or some condition to indicate completion
    };
  },
};

const textStream = createSmoothStreamViaPoll(options);

// Use smoothStream in a context expecting a web ReadableStream
```

## License

Asyncronaut is [MIT licensed](#).

# Contributing to Asyncronaut

We welcome contributions from everyone. This section will guide you through the initial setup and the contribution process.

## Prerequisites

You should have Node.js and npm installed on your system. We cross-publish our packages in CommonJS and ES Modules formats. Please note that we do not use ESM for Express dependencies due to compatibility issues.

## Getting Started

1. Clone the repository:

   ```bash
   git clone https://github.com/asyncronaut/asyncronaut.git
   cd asyncronaut
   ```

2. Install the dependencies:

   ```bash
   npm install
   ```

3. Build the project:

   ```bash
   npm run build
   ```

   This will generate the TypeScript declaration files and build the project.

## Coding Style

We enforce a consistent coding style using ESLint for TypeScript, along with Prettier for code formatting. We strongly recommend you install these tools in your code editor before you begin. Our configuration will automatically apply our coding standards.

## Running Tests

We use Jest for unit testing. To run the tests:

```bash
npm test
```

This command will lint the code, check types, and then run all unit tests. If you prefer, you can run Jest in watch mode:

```bash
npm run test:watch
```

## Submitting Changes

Before submitting your changes, please ensure your code passes all tests and adheres to our coding style. Once you're ready, you can submit a pull request (PR) to the main repository.

We use GitHub Actions for continuous integration (CI). Whenever a PR is created, the CI checks will automatically run.

## Release Process

We use Semantic Release for automatic versioning and publishing of our packages. This tool uses the commit messages to determine the type of changes in the codebase and performs a release accordingly. Therefore, we require all commit messages to follow the [Conventional Commits specification](https://www.conventionalcommits.org/).

## Conclusion

Thank you for your interest in contributing to Asyncronaut! Please feel free to open an issue if you have any questions or run into any issues. We look forward to your contributions!

## Roadmap

- Exports with generate-export-aliases
- Semantic release
- promises
  - `fromEvent`
- streams
  - node stream destroy
- browsers / e2e
  - browserPool
  - pagePool
  - renderPipeline
  - test helpers
- taskQueue
  - postMessage / distributed support
