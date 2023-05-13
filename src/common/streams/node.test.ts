import {Readable} from 'stream';
import {streamToBuffer} from './node';

describe(streamToBuffer, () => {
  it('converts a stream to a buffer', async () => {
    const input = Buffer.from('This is a test');
    const readableStream = Readable.from(input);

    const output = await streamToBuffer(readableStream);
    expect(output).toBeInstanceOf(Buffer);
    expect(output.toString()).toBe(input.toString());
  });

  it('handles empty streams', async () => {
    const readableStream = Readable.from([]);

    const output = await streamToBuffer(readableStream);
    expect(output).toBeInstanceOf(Buffer);
    expect(output.length).toBe(0);
  });

  it('rejects on stream error', async () => {
    const readableStream = new Readable({
      read() {
        this.emit('error', new Error('Stream error'));
      },
    });

    await expect(streamToBuffer(readableStream)).rejects.toThrow('Stream error');
  });
});
