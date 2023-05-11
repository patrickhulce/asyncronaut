import type {Readable} from 'stream';

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Array<Buffer> = [];

  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
