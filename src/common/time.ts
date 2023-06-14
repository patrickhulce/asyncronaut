export interface TimeController {
  /** Returns the current UNIX epoch time in milliseconds. */
  now(): number;
}

export const DEFAULT_TIME_CONTROLLER: TimeController = {
  now: () => Date.now(),
};

export const JEST_TIME_CONTROLLER: TimeController & {now: jest.Mock} = {
  now:
    typeof jest === 'undefined'
      ? ((() => {
          throw new Error(`jest environment not available`);
        }) as any)
      : jest.fn(),
};
