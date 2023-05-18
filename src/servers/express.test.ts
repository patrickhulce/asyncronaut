import fetch from 'node-fetch';
import {createTestServer, ServerDefinition, ResponseDeliveryType, RouteDefinition} from './express';
import {flushAllMicrotasks} from '../common/promises';

type RecursivePartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? RecursivePartial<U>[]
    : T[P] extends object
    ? RecursivePartial<T[P]>
    : T[P];
};

import '../test/jest';

describe(createTestServer, () => {
  let server;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }

    jest.useRealTimers();
  });

  function createDefinition(route: RecursivePartial<RouteDefinition>): ServerDefinition {
    return {
      routes: [
        {
          path: '/test',
          method: 'GET',
          ...route,
          // @ts-expect-error - deliveryType is narrower than we can generate, if tests pass, we're happy
          response: {
            deliveryType: ResponseDeliveryType.COMPLETE,
            body: 'Hello, World!',
            delayMs: 0,
            ...route.response,
          },
        },
      ],
    };
  }

  it('creates a server with a single GET route', async () => {
    const serverDefinition = createDefinition({response: {body: 'Hello, World!'}});

    server = await createTestServer(serverDefinition);
    const response = await fetch(`${server.baseURL}/test`);
    const text = await response.text();

    expect(response.status).toEqual(200);
    expect(text).toEqual('Hello, World!');
  });

  it('delays response by specified milliseconds', async () => {
    jest.useRealTimers();
    const serverDefinition = createDefinition({response: {delayMs: 54}});

    server = await createTestServer(serverDefinition);
    const startTime = Date.now();
    const response = await fetch(`${server.baseURL}/test`);
    const endTime = Date.now();
    const text = await response.text();

    expect(text).toEqual('Hello, World!');
    expect(endTime - startTime).toBeGreaterThanOrEqual(54);
  });

  it('creates a server that 404s for undefined routes', async () => {
    const serverDefinition = createDefinition({});

    server = await createTestServer(serverDefinition);
    const response = await fetch(`${server.baseURL}/missing`, {method: 'GET'});

    expect(response.status).toEqual(404);
  });

  it('creates a server with a single POST route', async () => {
    const serverDefinition = createDefinition({
      method: 'POST',
      response: {
        body: {message: 'Post request received'},
      },
    });

    server = await createTestServer(serverDefinition);
    const response = await fetch(`${server.baseURL}/test`, {method: 'POST'});
    const json = await response.json();

    expect(response.status).toEqual(200);
    expect(json).toEqual({message: 'Post request received'});
  });

  it('creates a server with a single route that returns a JSON object', async () => {
    const serverDefinition = createDefinition({response: {body: {foo: 'bar'}}});

    server = await createTestServer(serverDefinition);
    const response = await fetch(`${server.baseURL}/test`);
    const json = await response.json();

    expect(response.status).toEqual(200);
    expect(json).toEqual({foo: 'bar'});
  });

  it('creates a server with a single route that returns a Buffer', async () => {
    const serverDefinition = createDefinition({response: {body: Buffer.from('Hello, World!')}});

    server = await createTestServer(serverDefinition);
    const response = await fetch(`${server.baseURL}/test`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    expect(response.status).toEqual(200);
    expect(buffer.toString()).toEqual('Hello, World!');
  });

  it('supports streams', async () => {
    const serverDefinition = createDefinition({
      response: {
        deliveryType: ResponseDeliveryType.STREAM,
        body: Buffer.from([0xff, 0x66, 0xff, 0x66]),
        chunkGapInMs: 1_000,
        chunkSizeInBytes: 1,
      },
    });

    server = await createTestServer(serverDefinition);
    const response = await fetch(`${server.baseURL}/test`);

    expect(response.status).toEqual(200);

    const stream = response.body;
    const data: Buffer[] = [];
    stream.on('data', (chunk) => data.push(chunk));

    let isClosed = false;
    stream.on('close', () => (isClosed = true));

    await jest.advanceTimersByTimeAsync(50);
    await flushAllMicrotasks();

    expect(data).toEqual([Buffer.from([0xff])]);

    await jest.advanceTimersByTimeAsync(1_000);
    await flushAllMicrotasks();

    expect(Buffer.concat(data)).toEqual(Buffer.from([0xff, 0x66]));

    await jest.advanceTimersByTimeAsync(10_000);
    await flushAllMicrotasks();

    expect(Buffer.concat(data)).toEqual(Buffer.from([0xff, 0x66, 0xff, 0x66]));
    expect(isClosed).toBe(true);
  });

  it('supports custom handlers', async () => {
    const serverDefinition = createDefinition({
      response: {
        deliveryType: ResponseDeliveryType.CUSTOM,
        handler(req, res) {
          res.json({it: 'works', header: req.headers['x-custom']});
        },
      },
    });

    server = await createTestServer(serverDefinition);
    const response = await fetch(`${server.baseURL}/test`, {headers: {'x-custom': '1234'}});
    const json = await response.json();

    expect(response.status).toEqual(200);
    expect(json).toEqual({it: 'works', header: '1234'});
  });
});
