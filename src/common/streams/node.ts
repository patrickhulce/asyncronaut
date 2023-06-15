import {Readable} from 'stream';
import type {ReadableStream} from 'stream/web';

/** Converts a stream of bytes into a promise of the complete buffer. */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Array<Buffer> = [];

  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Converts a web ReadableStream into a node Readable stream */
export function fromWeb(stream: ReadableStream): Readable {
  const nodeStream = new Readable({
    async read() {
      // Intentionally left empty as we'll be pushing data from the web ReadableStream asynchronously.
    },
  });

  (async () => {
    const reader = stream.getReader();

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const {done, value} = await reader.read();
        if (done) {
          nodeStream.push(null);
          break;
        } else {
          nodeStream.push(value);
        }
      }
    } catch (err) {
      nodeStream.emit('error', err);
      await reader.cancel();
    }
  })().catch((err) => nodeStream.emit('error', err));

  return nodeStream;
}
