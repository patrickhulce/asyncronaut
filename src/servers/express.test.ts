import fetch from 'node-fetch';
import {createTestServer, ServerDefinition, ResponseDeliveryType, RouteDefinition} from './express';

describe(createTestServer, () => {
  let server;

  afterEach(async () => {
    if (server) {
      await server.close();
    }
  });

  function createDefinition(route: Partial<RouteDefinition>): ServerDefinition {
    return {
      routes: [
        {
          path: '/test',
          method: 'GET',
          response: {deliveryType: ResponseDeliveryType.COMPLETE, body: 'Hello, World!'},
          ...route,
        },
      ],
    };
  }

  it('creates a server with a single GET route', async () => {
    const serverDefinition = createDefinition({
      response: {deliveryType: ResponseDeliveryType.COMPLETE, body: 'Hello, World!'},
    });

    server = await createTestServer(serverDefinition);
    const response = await fetch(`${server.baseURL}/test`);
    const text = await response.text();

    expect(response.status).toEqual(200);
    expect(text).toEqual('Hello, World!');
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
        deliveryType: ResponseDeliveryType.COMPLETE,
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
    const serverDefinition = createDefinition({
      response: {deliveryType: ResponseDeliveryType.COMPLETE, body: {foo: 'bar'}},
    });

    server = await createTestServer(serverDefinition);
    const response = await fetch(`${server.baseURL}/test`);
    const json = await response.json();

    expect(response.status).toEqual(200);
    expect(json).toEqual({foo: 'bar'});
  });

  it('creates a server with a single route that returns a Buffer', async () => {
    const serverDefinition = createDefinition({
      response: {deliveryType: ResponseDeliveryType.COMPLETE, body: Buffer.from('Hello, World!')},
    });

    server = await createTestServer(serverDefinition);
    const response = await fetch(`${server.baseURL}/test`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    expect(response.status).toEqual(200);
    expect(buffer.toString()).toEqual('Hello, World!');
  });
});
