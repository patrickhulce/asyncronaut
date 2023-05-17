import {createServer} from 'http';
import express from 'express';
import {createDecomposedPromise} from '../common/promises';

export enum ResponseDeliveryType {
  COMPLETE = 'complete',
}

export type ResponseDefinition = {deliveryType: ResponseDeliveryType.COMPLETE; body: unknown};

export interface RouteDefinition {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  response: ResponseDefinition;
}

export interface ServerDefinition {
  routes: Array<RouteDefinition>;
}

export interface ServerRef {
  baseURL: string;
  port: number;
  server: import('http').Server;
  definition: ServerDefinition;
  close(): Promise<void>;
}

const FUNCTION_FOR_METHOD: Record<RouteDefinition['method'], 'get' | 'post' | 'put' | 'delete'> = {
  GET: 'get',
  POST: 'post',
  PUT: 'put',
  DELETE: 'delete',
};

function createRouteHandler(route: RouteDefinition): express.RequestHandler {
  const {body} = route.response;
  return async (req, res, next) => {
    try {
      if (typeof body === 'string') res.end(body);
      else if (Buffer.isBuffer(body)) res.end(body);
      else res.json(body);
    } catch (err) {
      next(err);
    }
  };
}

export async function createTestServer(definition: ServerDefinition): Promise<ServerRef> {
  const app = express();
  for (const route of definition.routes) {
    app[FUNCTION_FOR_METHOD[route.method]](route.path, createRouteHandler(route));
  }

  const {resolve, reject, promise} = createDecomposedPromise<void>();

  const server = createServer(app);
  server.on('error', (error) => reject(error));
  server.listen(0, resolve);
  await promise;

  const address = server.address();
  if (typeof address === 'string' || !address)
    throw new Error(`Invalid server address: ${address}`);
  const port = address.port;

  return {
    baseURL: `http://localhost:${port}`,
    port,
    server,
    definition,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
