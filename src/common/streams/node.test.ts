import {Readable} from 'stream';
import {ReadableStream} from 'stream/web';
import {streamToBuffer, fromWeb} from './node';

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

describe(fromWeb, () => {
  it('converts a web ReadableStream to a node Readable stream', async () => {
    const input = 'This is a test string.';
    const webStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      },
    });

    const nodeStream = fromWeb(webStream);
    expect(nodeStream).toBeInstanceOf(Readable);

    let receivedData = '';
    for await (const chunk of nodeStream) {
      receivedData += chunk.toString();
    }

    expect(receivedData).toBe(input);
  });

  it('handles web stream errors', async () => {
    const webStream = new ReadableStream({
      start(controller) {
        controller.error(new Error('Test error'));
      },
    });

    try {
      for await (const data of fromWeb(webStream)) {
        expect(data).not.toBeDefined();
      }
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('Test error');
    }
  });

  it('handles node stream destroy', async () => {
    const webStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('Test data'));
      },
    });

    const getReaderSpy = jest.spyOn(webStream, 'getReader');

    const nodeStream = fromWeb(webStream);

    const reader: ReadableStreamDefaultReader<unknown> = getReaderSpy.mock.results[0].value;
    const cancelSpy = jest.spyOn(reader, 'cancel');

    nodeStream.destroy();

    try {
      for await (const data of nodeStream) {
        expect(data).not.toBeDefined();
      }
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/asdfasdf/);
      expect(cancelSpy).toHaveBeenCalled();
    }
  });
});
