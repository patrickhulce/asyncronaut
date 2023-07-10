import {DefaultTimer, JEST_TIME_CONTROLLER} from './time';

describe('RootTimer()', () => {
  afterEach(() => {
    JEST_TIME_CONTROLLER.now.mockReset();
  });

  it('tracks duration of an entry', () => {
    const timer = new DefaultTimer({time: JEST_TIME_CONTROLLER});

    JEST_TIME_CONTROLLER.now.mockReturnValueOnce(1000);
    timer.start('example');

    JEST_TIME_CONTROLLER.now.mockReturnValueOnce(2500);
    timer.end('example');

    const entries = timer.takeEntries();
    expect(entries).toEqual([{label: 'example', start: 1000, end: 2500}]);
  });

  it('manually adds an entry', () => {
    const timer = new DefaultTimer({time: JEST_TIME_CONTROLLER});

    timer._addEntry({start: 0, end: 1000, label: 'example'});

    const entries = timer.takeEntries();
    expect(entries).toEqual([{start: 0, end: 1000, label: 'example'}]);
  });

  it('subsets by context', () => {
    const timer = new DefaultTimer({time: JEST_TIME_CONTROLLER});
    const subtimer = timer.withContext('subtimer');

    JEST_TIME_CONTROLLER.now.mockReturnValueOnce(1000);
    timer.start('example');

    JEST_TIME_CONTROLLER.now.mockReturnValueOnce(1500);
    subtimer.start('example');

    JEST_TIME_CONTROLLER.now.mockReturnValueOnce(2000);
    timer.end('example');

    JEST_TIME_CONTROLLER.now.mockReturnValueOnce(2500);
    subtimer.end('example');

    const entries = timer.takeEntries();
    expect(entries).toEqual([
      {start: 1000, end: 2000, label: 'example'},
      {start: 1500, end: 2500, label: 'example', context: 'subtimer'},
    ]);
  });

  it('subsets by context', () => {
    const timer = new DefaultTimer({time: JEST_TIME_CONTROLLER});
    const subtimer = timer.withContext('subtimer');

    JEST_TIME_CONTROLLER.now.mockReturnValueOnce(1000);
    timer.start('example');

    JEST_TIME_CONTROLLER.now.mockReturnValueOnce(1500);
    subtimer.start('example');

    JEST_TIME_CONTROLLER.now.mockReturnValueOnce(2000);
    timer.end('example');

    JEST_TIME_CONTROLLER.now.mockReturnValueOnce(2500);
    subtimer.end('example');

    const entries = timer.takeEntries();
    expect(entries).toEqual([
      {start: 1000, end: 2000, label: 'example'},
      {start: 1500, end: 2500, label: 'example', context: 'subtimer'},
    ]);
  });

  it('limits concurrent spans', () => {
    const timer = new DefaultTimer({maxConcurrentSpans: 500});

    let count = 0;
    JEST_TIME_CONTROLLER.now.mockImplementation(() => count++);

    for (let i = 0; i < 10_000; i++) timer.start(`example-${i}`);
    for (let i = 0; i < 10_000; i++) timer.end(`example-${i}`);

    const entries = timer.takeEntries();
    expect(entries).toHaveLength(500);
    expect(entries[0]).toMatchObject({label: `example-9500`});
  });

  it('limits historical entries', () => {
    const timer = new DefaultTimer({maxEntryHistory: 500});

    let count = 0;
    JEST_TIME_CONTROLLER.now.mockImplementation(() => count++);

    for (let i = 0; i < 10_000; i++) {
      timer.start(`example-${i}`);
      timer.end(`example-${i}`);
    }

    const entries = timer.takeEntries();
    expect(entries).toHaveLength(500);
    expect(entries[0]).toMatchObject({label: `example-9500`});
  });

  it('prevents memory leaks by default', () => {
    const timer = new DefaultTimer({time: JEST_TIME_CONTROLLER});

    for (let i = 0; i < 10_000; i++) timer.start(`example-${i}`);
    for (let i = 0; i < 10_000; i++) timer.end(`example-${i}`);

    expect(timer.takeEntries().length).toBeLessThan(10_000);
  });

  it('generates unique identifiers', () => {
    const timer = new DefaultTimer({time: JEST_TIME_CONTROLLER});
    const uniqueEntries = new Set<string | undefined>();

    for (let i = 0; i < 10_000; i++) {
      const subtimer = timer.withUniqueId();
      subtimer.start('example');
      subtimer.end('example');
      const id = subtimer.takeEntries()[0].id;
      expect(id).toMatch(/^[a-f0-9]{8}$/);
      uniqueEntries.add(id);
    }

    expect(uniqueEntries.size).toBeGreaterThan(2);
  });

  it('uses default options', () => {
    const timer = new DefaultTimer({
      time: JEST_TIME_CONTROLLER,
      defaultOptions: {context: 'example', id: '1234'},
    });

    timer.start('example', {context: 'other'});
    timer.start('example', {id: '123'});
    timer.end('example', {context: 'other'});
    timer.end('example', {id: '123'});

    expect(timer.takeEntries()).toMatchObject([
      {label: 'example', context: 'other', id: '1234'},
      {label: 'example', context: 'example', id: '123'},
    ]);
  });

  it('notifies loggers', () => {
    const log = jest.fn();
    const timer = new DefaultTimer({time: JEST_TIME_CONTROLLER, log});

    JEST_TIME_CONTROLLER.now.mockReturnValueOnce(1000);
    timer.start('example', {id: '123'});
    JEST_TIME_CONTROLLER.now.mockReturnValueOnce(2000);
    timer.end('example', {id: '123'});

    expect(log).toHaveBeenCalledWith({
      label: 'example',
      id: '123',
      event: 'start',
      timestamp: 1000,
    });

    expect(log).toHaveBeenCalledWith({
      label: 'example',
      id: '123',
      event: 'end',
      timestamp: 2000,
      duration: 1000,
    });
  });
});
