import type {Readable} from 'stream';

/** Converts a stream of bytes into a promise of the complete buffer. */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Array<Buffer> = [];

  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
