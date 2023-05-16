/* eslint-env jest */

import {InspectablePromise} from '../common/promises';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      /**
       * Asserts that an inspectable promise created by makePromiseInspectable is currently resolved or rejected.
       * Useful over `.rejects` and `.resolves` for two reasons:
       *
       *    - Provide a mechanism for asserting that something is NOT done.
       *    - Prevent all of your tests from failing with "Failed to complete in Xms" when tests fail.
       *      `.toBeDone` asserts that the promise settled and a followup assertion asserts _how_ it was
       *      settled. If you just use `.rejects` and the promise never resolves, you just get a timeout
       *      30s later without a helpful error message.
       */
      toBeDone: (failureMessage?: string) => R;
    }
  }
}

expect.extend({
  /**
   * Helper for asserting whether a promise has settled.
   *
   * @param received The inspectable promise that was passed to `expect()`
   * @param failureMessage The more specific error message passed to `toBeDone()`
   * @returns The jest expectation result.
   */
  toBeDone(received: InspectablePromise<unknown>, failureMessage: unknown) {
    const pass: boolean = this.isNot ? !received.isDone() : received.isDone();
    const toBe = this.isNot ? 'not to be' : 'to be';

    const message = () =>
      [
        `${this.utils.matcherHint('.toBeDone', undefined, this.isNot ? 'false' : 'true')}\n`,
        `Expected promise ${toBe} settled: ${this.utils.printExpected(failureMessage)}`,
        `  ${this.utils.printReceived(received.getDebugValues())}`,
      ].join('\n');

    return {message, pass};
  },
});
