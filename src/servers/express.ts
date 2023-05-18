import {createServer} from 'http';
import express from 'express';
import {createDecomposedPromise, delay} from '../common/promises';

export enum ResponseDeliveryType {
  COMPLETE = 'complete',
  STREAM = 'stream',
  SERVER_SENT_EVENTS = 'sse',
  CUSTOM = 'custom',
}

interface ResponseCommonProperties {
  body?: unknown;
  fetchBody?(req: import('express').Request): Promise<unknown>;
  delayMs?: number;
}

interface ResponseCompleteDefinition extends ResponseCommonProperties {
  deliveryType: ResponseDeliveryType.COMPLETE;
}

interface ResponseStreamDefinition extends ResponseCommonProperties {
  deliveryType: ResponseDeliveryType.STREAM;
  chunkSizeInBytes?: number;
  chunkGapInMs?: number;
}

interface ResponseServerSentEventsDefinition {
  deliveryType: ResponseDeliveryType.SERVER_SENT_EVENTS;
  events: Iterable<unknown>;
  delayMs?: number;
  chunkGapInMs?: number;
}

interface ResponseCustomDefinition {
  deliveryType: ResponseDeliveryType.CUSTOM;
  handler: import('express').RequestHandler;
  delayMs?: number;
}

export type ResponseDefinition =
  | ResponseCompleteDefinition
  | ResponseStreamDefinition
  | ResponseServerSentEventsDefinition
  | ResponseCustomDefinition;

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

function coerceToBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value)
    ? value
    : typeof value === 'string'
    ? Buffer.from(value)
    : Buffer.from(JSON.stringify(value));
}

function createRouteHandler(route: RouteDefinition): express.RequestHandler {
  const {response} = route;
  return async (req, res, next) => {
    try {
      if (response.delayMs) await delay(response.delayMs);

      if (response.deliveryType === ResponseDeliveryType.CUSTOM) {
        await response.handler(req, res, next);
        return;
      }

      if (response.deliveryType === ResponseDeliveryType.SERVER_SENT_EVENTS) {
        for (const event of response.events) {
          res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n`);
          if (response.chunkGapInMs) await delay(response.chunkGapInMs);
        }
        res.end();
        return;
      }

      let {body = '', fetchBody} = response;
      if (fetchBody) body = await fetchBody(req);
      const buffer = coerceToBuffer(body);

      if (response.deliveryType === ResponseDeliveryType.COMPLETE) {
        res.end(buffer);
      } else if (response.deliveryType === ResponseDeliveryType.STREAM) {
        const {chunkSizeInBytes = 8096} = response;
        for (let i = 0; i < buffer.byteLength; i += chunkSizeInBytes) {
          const chunk = buffer.subarray(i, i + chunkSizeInBytes);
          res.write(chunk);
          if (response.chunkGapInMs) await delay(response.chunkGapInMs);
        }

        res.end();
      }
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
