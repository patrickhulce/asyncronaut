import {
  ConcurrentResourcePool,
  ResourceAllocationMethod,
  PoolOptions,
  wrapConcurrentPoolToHideLease,
} from './concurrent-pool';
import {createDecomposedPromise, withInspection, flushAllMicrotasks} from './promises';

import '../test/jest';

jest.useFakeTimers();

describe(ConcurrentResourcePool, () => {
  function createPool(options?: Partial<PoolOptions<any>>) {
    const createFn = jest.fn().mockImplementation(async () => Math.random());
    const destroyFn = jest.fn().mockImplementation(async () => {});
    const onAcquireFn = jest.fn().mockImplementation(async () => {});
    const onReleaseFn = jest.fn().mockImplementation(async () => {});
    const nowFn = jest.fn().mockImplementation(() => Date.now());
    const pool = new ConcurrentResourcePool({
      create: createFn,
      destroy: destroyFn,
      onAcquire: onAcquireFn,
      onRelease: onReleaseFn,
      wallTime: {now: nowFn},
      ...options,
    });

    return {pool, createFn, destroyFn, onAcquireFn, onReleaseFn, nowFn};
  }

  describe('.acquire()', () => {
    it('provides access to a resource', async () => {
      const {pool} = createPool();

      const lease = await pool.acquire();
      expect(lease).toHaveProperty('resource');
      expect(typeof lease.resource).toBe('number');
      await pool.release(lease);
    });

    it('reuses a resource', async () => {
      const {pool, createFn} = createPool();

      expect(createFn).not.toHaveBeenCalled();

      // Acquire a lease on a resource.
      const leaseA = await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(1);
      await pool.release(leaseA);

      // Acquire a lease on the same resource.
      const leaseB = await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(1);
      await pool.release(leaseB);
    });

    it('creates more than 1 resource', async () => {
      const {pool, createFn} = createPool();

      expect(createFn).not.toHaveBeenCalled();

      // Acquire a lease on two different resources at once.
      const leaseA = await pool.acquire();
      const leaseB = await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(2);
      await pool.release(leaseA);
      await pool.release(leaseB);
    });

    it('waits for onAcquire hooks', async () => {
      const {pool, onAcquireFn} = createPool();

      const {promise: promiseA, resolve: resolveA} = createDecomposedPromise<void>();
      const {promise: promiseB, resolve: resolveB} = createDecomposedPromise<void>();
      onAcquireFn.mockReset();
      onAcquireFn.mockReturnValueOnce(promiseA);
      onAcquireFn.mockReturnValueOnce(promiseB);

      // Acquire a lease on a resource and ensure it's not resolved yet.
      const leasePromiseA = withInspection(pool.acquire());
      await flushAllMicrotasks();
      expect(leasePromiseA).not.toBeDone();

      // Resolve the onAcquire and ensure it resolves.
      resolveA();
      await flushAllMicrotasks();
      expect(leasePromiseA).toBeDone();
      await pool.release(await leasePromiseA);

      // Acquire a lease on that same resource and ensure it's not resolved yet (not just onCreate).
      const leasePromiseB = withInspection(pool.acquire());
      expect(leasePromiseB).not.toBeDone();

      // Resolve onAcquire and ensure it resolves;
      resolveB();
      await flushAllMicrotasks();
      expect(leasePromiseB).toBeDone();

      await pool.release(await leasePromiseB);
    });

    it('throws when creation fails', async () => {
      const {pool, createFn} = createPool();

      createFn.mockReset();
      createFn.mockRejectedValue(new Error('Failed'));

      await expect(pool.acquire()).rejects.toThrowError('Failed');
    });

    it('cleans up dangling leases on failed creation', async () => {
      const {pool, createFn} = createPool();

      createFn.mockReset();
      createFn.mockRejectedValueOnce(new Error('Failed'));

      await expect(pool.acquire()).rejects.toThrowError('Failed');
      expect(pool.getDiagnostics()).toEqual({resources: [], leases: []});
    });

    it('cleans up dangling leases on failed onAcquire', async () => {
      const {pool, onAcquireFn} = createPool();

      onAcquireFn.mockReset();
      onAcquireFn.mockRejectedValueOnce(new Error('Failed'));

      await expect(pool.acquire()).rejects.toThrowError('Failed');
      expect(pool.getDiagnostics()).toEqual({resources: [expect.anything()], leases: []});
    });

    it('prevents future requests from using a failed resource', async () => {
      const {pool, createFn} = createPool({maxConcurrentLeasesPerResource: 2});

      createFn.mockReset();
      createFn.mockRejectedValueOnce(new Error('Failed'));
      createFn.mockResolvedValueOnce({});

      await expect(pool.acquire()).rejects.toThrowError('Failed');
      const lease = await pool.acquire();
      await pool.release(lease);
    });
  });

  describe('.release()', () => {
    it('waits for onRelease', async () => {
      const {pool, onReleaseFn} = createPool();

      const {promise, resolve} = createDecomposedPromise<void>();
      onReleaseFn.mockReset();
      onReleaseFn.mockReturnValue(promise);

      // Acquire/release a lease and ensure it's not resolved yet.
      const lease = await pool.acquire();
      const releasePromise = withInspection(pool.release(lease));
      await flushAllMicrotasks();
      expect(releasePromise).not.toBeDone();

      // Resolve the onRelease and ensure it resolves.
      resolve();
      await flushAllMicrotasks();
      expect(releasePromise).toBeDone();
      await releasePromise;
    });

    it('still releases onRelease failures', async () => {
      const {pool, onReleaseFn} = createPool();

      onReleaseFn.mockReset();
      onReleaseFn.mockRejectedValue(new Error('Failed!'));

      const lease = await pool.acquire();
      await expect(pool.release(lease)).rejects.toThrowError('Failed!');

      expect(pool.getDiagnostics()).toEqual({resources: [expect.anything()], leases: []});
    });
  });

  describe('.retire()', () => {
    it('makes the resource unavailable for future use', async () => {
      const {pool, createFn} = createPool();

      expect(createFn).not.toHaveBeenCalled();

      // Acquire a lease on a resource and retire it.
      const leaseA = await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(1);
      await pool.retire(leaseA);

      // Acquire a lease (should create a new resource).
      const leaseB = await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(2);
      await pool.release(leaseB);
    });
  });

  describe('.drain()', () => {
    it('destroys all resources', async () => {
      const {pool, createFn, destroyFn} = createPool();

      const leases = await Promise.all(Array.from({length: 10}).map(() => pool.acquire()));
      expect(createFn).toHaveBeenCalledTimes(10);
      await pool.drain();
      expect(destroyFn).toHaveBeenCalledTimes(10);
      expect(pool.getDiagnostics()).toEqual({resources: [], leases: []});
      await Promise.all(leases.map((lease) => pool.release(lease)));
    });

    it('waits for resources to be destroyed before resolving', async () => {
      const {pool, createFn, destroyFn} = createPool();

      const {promise, resolve} = createDecomposedPromise<void>();
      destroyFn.mockReset();
      destroyFn.mockReturnValue(promise);

      const lease = await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(1);

      const drainPromise = withInspection(pool.drain());
      await flushAllMicrotasks();
      expect(destroyFn).toHaveBeenCalledTimes(1);
      expect(drainPromise).not.toBeDone();
      expect(pool.getDiagnostics()).toEqual({resources: [], leases: []});

      jest.advanceTimersByTime(5000);
      await flushAllMicrotasks();
      expect(drainPromise).not.toBeDone();

      resolve();
      await flushAllMicrotasks();
      expect(drainPromise).toBeDone();

      await pool.release(lease);
    });

    it('does not create minimum resources while being drained', async () => {
      const {pool, createFn, destroyFn} = createPool({minResources: 10});

      expect(createFn).toHaveBeenCalledTimes(0);
      await pool.initialize();
      expect(createFn).toHaveBeenCalledTimes(10);

      await pool.acquire(); // Acquire a lease to trigger re-evaluation.
      await pool.drain();
      await flushAllMicrotasks();
      expect(createFn).toHaveBeenCalledTimes(10);
      expect(destroyFn).toHaveBeenCalledTimes(10);
      expect(pool.getDiagnostics()).toEqual({resources: [], leases: []});
    });

    it('rejects acquire/initialize', async () => {
      const {pool} = createPool();

      await pool.drain();
      await flushAllMicrotasks();

      await expect(pool.acquire()).rejects.toThrowError(/drain/);
      await expect(pool.initialize()).rejects.toThrowError(/drain/);
    });
  });

  describe('maxConcurrentLeasesPerResource', () => {
    it('leases a resource multiple times', async () => {
      const {pool, createFn} = createPool({maxConcurrentLeasesPerResource: 2});

      // Acquire two leases on the same resource.
      const leaseA = await pool.acquire();
      const leaseB = await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(1);
      expect(leaseA.resource).toEqual(leaseB.resource);

      // Acquire a third on a new resource.
      const leaseC = await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(2);

      // Release all back to pool.
      await pool.release(leaseA);
      await pool.release(leaseB);
      await pool.release(leaseC);
    });
  });

  describe('minResources', () => {
    it('automatically creates that many resources on init', async () => {
      const {pool, createFn} = createPool({minResources: 5});

      expect(createFn).toHaveBeenCalledTimes(0);
      await pool.initialize();
      expect(createFn).toHaveBeenCalledTimes(5);
    });

    it('automatically creates that many resources after destroy', async () => {
      const {pool, createFn} = createPool({minResources: 5, retireResourceAfterUses: 1});

      // Force the initial resources to be created.
      await pool.initialize();

      // None should be in use, yet we should have 5 waiting for us.
      expect(createFn).toHaveBeenCalledTimes(5);

      // Lease does not create a new resource yet.
      const lease = await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(5);

      // When it's returned to the pool it is retired and a new one is available.
      await pool.release(lease);
      expect(createFn).toHaveBeenCalledTimes(6);
    });
  });

  describe('maxResources', () => {
    it('queues additional requests', async () => {
      const {pool} = createPool({maxResources: 2});

      // Request more leases than we have resources (some will be queued).
      const leasePromises = Array.from({length: 5})
        .map(() => pool.acquire())
        .map(withInspection);
      await flushAllMicrotasks();

      // Check that only `maxResources` were resolved.
      expect(leasePromises[0]).toBeDone();
      expect(leasePromises[1]).toBeDone();
      expect(leasePromises[2]).not.toBeDone();
      expect(leasePromises[3]).not.toBeDone();

      // Release one and check that the next lease has been resolved.
      await pool.release(await leasePromises[0]);
      await flushAllMicrotasks();
      expect(leasePromises[2]).toBeDone();
      expect(leasePromises[3]).not.toBeDone();

      // Release another and check that the next lease has been resolved.
      await pool.release(await leasePromises[1]);
      await flushAllMicrotasks();
      expect(leasePromises[2]).toBeDone();
      expect(leasePromises[3]).toBeDone();
    });

    it('considers retired resources part of pool', async () => {
      const {pool} = createPool({
        maxResources: 2,
        maxConcurrentLeasesPerResource: 2,
        retireResourceAfterUses: 2,
      });

      // Acquire 4 resources to max out capacity.
      const leases = await Promise.all(Array.from({length: 4}).map(() => pool.acquire()));

      // Now release one for each resource.
      await pool.release(leases[0]);
      await pool.release(leases[2]);

      // You might _think_ it should have capacity, but we haven't freed up the underlying resources yet.
      // Ensure new lease requests are queued.
      const leasePromiseA = withInspection(pool.acquire());
      const leasePromiseB = withInspection(pool.acquire());
      await flushAllMicrotasks();
      expect(leasePromiseA).not.toBeDone();
      expect(leasePromiseB).not.toBeDone();

      // Once we release a resource, both should be fulfilled.
      await pool.release(leases[1]);
      await flushAllMicrotasks();
      expect(leasePromiseA).toBeDone();
      expect(leasePromiseB).toBeDone();
    });
  });

  describe('maxQueuedAcquireRequests', () => {
    it('throws after max queued requests', async () => {
      const {pool} = createPool({
        maxResources: 2,
        maxQueuedAcquireRequests: 2,
      });

      // Request more leases than we have resources (some will be queued, and some will throw).
      const leasePromises = Array.from({length: 5})
        .map(() => pool.acquire())
        .map(withInspection);
      await flushAllMicrotasks();

      // Check that first two resolved, next two were queued, and last threw.
      expect(leasePromises[0]).toBeDone();
      expect(leasePromises[1]).toBeDone();
      expect(leasePromises[2]).not.toBeDone();
      expect(leasePromises[3]).not.toBeDone();
      expect(leasePromises[4]).toBeDone();
      await expect(leasePromises[4]).rejects.toThrowError(/Max.*queue size/);

      // Check that all future requests throw too.
      for (let i = 0; i < 30; i++) {
        await expect(pool.acquire()).rejects.toThrowError(/Max.*queue size/);
      }

      // Release a resource back to pool and check the queued request resolves successfully.
      await pool.release(await leasePromises[0]);
      await flushAllMicrotasks();
      expect(leasePromises[2]).toBeDone();
      await leasePromises[2];
    });
  });

  describe('retireResourceAfterUses', () => {
    it('retires a resource when it reaches number of uses', async () => {
      const {pool, createFn} = createPool({
        maxConcurrentLeasesPerResource: Infinity,
        retireResourceAfterUses: 5,
      });

      // Ensure that every `retireResourceAfterUses` uses a new resource is created.
      expect(createFn).toHaveBeenCalledTimes(0);
      for (let i = 0; i < 5; i++) await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(2);
      for (let i = 0; i < 5; i++) await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(3);
    });

    it('destroys resources after all leases are done', async () => {
      const {pool, createFn, destroyFn} = createPool({retireResourceAfterUses: 2});

      // Check our preconditions.
      expect(createFn).toHaveBeenCalledTimes(0);
      expect(destroyFn).toHaveBeenCalledTimes(0);

      // Cycle a resource and check we didn't retire anything yet.
      let lease = await pool.acquire();
      await pool.release(lease);
      expect(createFn).toHaveBeenCalledTimes(1);
      expect(destroyFn).toHaveBeenCalledTimes(0);

      // Cycle a 2nd time and check we retired the resource.
      lease = await pool.acquire();
      await pool.release(lease);
      expect(createFn).toHaveBeenCalledTimes(1);
      expect(destroyFn).toHaveBeenCalledTimes(1);

      // Cycle a 3rd time and check we create a new resource.
      lease = await pool.acquire();
      await pool.release(lease);
      expect(createFn).toHaveBeenCalledTimes(2);
      expect(destroyFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('retireResourceAfterSeconds', () => {
    it('retires resources after passage of time', async () => {
      const {pool, createFn, destroyFn, nowFn} = createPool({retireResourceAfterSeconds: 30});
      nowFn.mockReset();

      // Check our preconditions.
      expect(createFn).toHaveBeenCalledTimes(0);
      expect(destroyFn).toHaveBeenCalledTimes(0);

      // Cycle a resource and check we didn't retire anything yet.
      nowFn.mockReturnValue(1_000); // createdAt=1000ms
      let lease = await pool.acquire();
      await pool.release(lease);
      expect(createFn).toHaveBeenCalledTimes(1);
      expect(destroyFn).toHaveBeenCalledTimes(0);

      // Cycle a 2nd time with time advanced and check we didn't retire anything yet.
      nowFn.mockReturnValue(28_000);
      lease = await pool.acquire();
      await pool.release(lease);
      expect(createFn).toHaveBeenCalledTimes(1);
      expect(destroyFn).toHaveBeenCalledTimes(0);

      // Cycle a 3rd time and check we retired the resource.
      nowFn.mockReturnValue(32_000);
      lease = await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(2);
      expect(destroyFn).toHaveBeenCalledTimes(1);
      await pool.release(lease);
    });
  });

  describe('destroyRetiredResourceForciblyAfterSeconds', () => {
    it('destroys resources when they are not released quickly enough', async () => {
      const {pool, createFn, destroyFn, nowFn} = createPool({
        retireResourceAfterUses: 2,
        maxConcurrentLeasesPerResource: 2,
        destroyRetiredResourceForciblyAfterSeconds: 60,
      });

      // Check our preconditions.
      expect(createFn).toHaveBeenCalledTimes(0);
      expect(destroyFn).toHaveBeenCalledTimes(0);

      // Acquire 2 leases on a resource to max out its capacity and trigger retirement.
      nowFn.mockReturnValue(1_000); // createdAt=1s
      const leaseA = await pool.acquire();
      nowFn.mockReturnValue(10_000); // retiredAt=10s
      const leaseB = await pool.acquire();
      expect(createFn).toHaveBeenCalledTimes(1);
      expect(destroyFn).toHaveBeenCalledTimes(0);

      // Release one resource more than 60s later to trigger destroy.
      nowFn.mockReturnValue(80_000);
      await pool.release(leaseA);
      expect(createFn).toHaveBeenCalledTimes(1);
      expect(destroyFn).toHaveBeenCalledTimes(1);

      await pool.release(leaseB);
    });
  });

  describe('createTimeoutMs', () => {
    it('throws on acquire if timeout exceeded', async () => {
      const {pool, createFn} = createPool({createTimeoutMs: 5000});

      const {promise} = createDecomposedPromise<void>();
      createFn.mockReset();
      createFn.mockReturnValue(promise);

      const leasePromise = withInspection(pool.acquire());
      await flushAllMicrotasks();
      expect(leasePromise).not.toBeDone();

      jest.advanceTimersByTime(5001);
      await flushAllMicrotasks();

      expect(leasePromise).toBeDone();
      await expect(leasePromise).rejects.toThrowError(/timeout/i);
    });

    it('cleans up resources if resolves after timeout', async () => {
      const {pool, createFn, destroyFn} = createPool({createTimeoutMs: 5000});

      const {promise, resolve} = createDecomposedPromise<void>();
      createFn.mockReset();
      createFn.mockReturnValue(promise);

      const leasePromise = withInspection(pool.acquire());
      jest.advanceTimersByTime(5001);
      await flushAllMicrotasks();
      await expect(leasePromise).rejects.toThrowError(/timeout/i);

      // Resolve _after_ the timeout and check destroy was called.
      expect(destroyFn).toHaveBeenCalledTimes(0);
      resolve();
      await flushAllMicrotasks();
      expect(destroyFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('destroyTimeoutMs', () => {
    it('throws on destroy if timeout exceeded', async () => {
      const {pool, destroyFn} = createPool({
        destroyTimeoutMs: 5000,
        retireResourceAfterUses: 1,
      });

      const {promise} = createDecomposedPromise<void>();
      destroyFn.mockReset();
      destroyFn.mockReturnValue(promise);

      const lease = await pool.acquire();
      const releasePromise = withInspection(pool.release(lease));
      await flushAllMicrotasks();
      expect(releasePromise).not.toBeDone();

      jest.advanceTimersByTime(5001);
      await flushAllMicrotasks();

      expect(releasePromise).toBeDone();
      await expect(releasePromise).rejects.toThrowError(/timeout/i);
    });
  });

  describe('defaultAcquireTimeout', () => {
    it('throws on acquire if aggregate timeout exceeded', async () => {
      const {pool} = createPool({defaultAcquireTimeoutMs: 5000, maxResources: 1});

      // Acquire a lease to max out capacity.
      const lease = await pool.acquire();
      // Now add a lease to the queue.
      const leasePromise = withInspection(pool.acquire());
      await flushAllMicrotasks();
      expect(leasePromise).not.toBeDone();

      // Advance time beyond the acquire tiemout.
      jest.advanceTimersByTime(5001);
      await flushAllMicrotasks();

      // Ensure that the acquire failed.
      expect(leasePromise).toBeDone();
      await expect(leasePromise).rejects.toThrowError(/timeout/i);

      // Release the original lease, which should dequeue the one that just timed out.
      await pool.release(lease);
      await flushAllMicrotasks();

      // Ensure the lease was cleaned up.
      expect(pool.getDiagnostics()).toMatchObject({leases: []});
    });
  });

  describe('defaultReleaseTimeout', () => {
    it('throws on release if timeout exceeded', async () => {
      const {pool, destroyFn} = createPool({
        defaultReleaseTimeoutMs: 5000,
        destroyTimeoutMs: 6000,
        retireResourceAfterUses: 1,
      });

      const {promise} = createDecomposedPromise<void>();
      destroyFn.mockReset();
      destroyFn.mockReturnValue(promise);

      const lease = await pool.acquire();
      const releasePromise = withInspection(pool.release(lease));
      await flushAllMicrotasks();
      expect(releasePromise).not.toBeDone();

      jest.advanceTimersByTime(5001);
      await flushAllMicrotasks();

      expect(releasePromise).toBeDone();
      await expect(releasePromise).rejects.toThrowError(/timeout/i);
    });
  });

  describe('silenceReleaseErrors', () => {
    it('resolves even if timeout exceeded', async () => {
      const {pool, destroyFn} = createPool({
        silenceReleaseErrors: true,
        destroyTimeoutMs: 5000,
        retireResourceAfterUses: 1,
      });

      const {promise} = createDecomposedPromise<void>();
      destroyFn.mockReset();
      destroyFn.mockReturnValue(promise);

      const lease = await pool.acquire();
      const releasePromise = withInspection(pool.release(lease));
      await flushAllMicrotasks();
      expect(releasePromise).not.toBeDone();

      jest.advanceTimersByTime(5001);
      await flushAllMicrotasks();

      expect(releasePromise).toBeDone();
      await releasePromise; // Ensure it does not reject.
    });
  });

  describe('resourceAllocationMethod', () => {
    describe('LAZY', () => {
      it('reuses resources', async () => {
        const {pool, createFn} = createPool({
          resourceAllocationMethod: ResourceAllocationMethod.LAZY,
          maxConcurrentLeasesPerResource: 2,
          maxResources: 3,
        });

        expect(createFn).not.toHaveBeenCalled();

        // Acquire a lease on a resource.
        const leaseA = await pool.acquire();
        expect(createFn).toHaveBeenCalledTimes(1);
        await pool.release(leaseA);

        // Acquire a lease that same resource.
        const leaseB = await pool.acquire();
        expect(createFn).toHaveBeenCalledTimes(1);
        await pool.release(leaseB);
      });

      it('creates new resources when necessary', async () => {
        const {pool, createFn} = createPool({
          resourceAllocationMethod: ResourceAllocationMethod.LAZY,
          maxConcurrentLeasesPerResource: 2,
          maxResources: 3,
        });

        expect(createFn).not.toHaveBeenCalled();

        // Request more leases than we have available concurrency.
        const leasePromises = Array.from({length: 3})
          .map(() => pool.acquire())
          .map(withInspection);
        await flushAllMicrotasks();

        expect(leasePromises[2]).toBeDone();
        await Promise.all(leasePromises);

        expect(createFn).toHaveBeenCalledTimes(2);
      });
    });

    describe('EAGER', () => {
      it('eagerly creates new resources', async () => {
        const {pool, createFn} = createPool({
          resourceAllocationMethod: ResourceAllocationMethod.EAGER,
          maxConcurrentLeasesPerResource: 2,
          maxResources: 3,
        });

        expect(createFn).not.toHaveBeenCalled();

        // Acquire a lease on a resource.
        const leaseA = await pool.acquire();
        expect(createFn).toHaveBeenCalledTimes(1);
        await pool.release(leaseA);

        // Acquire a lease that _could_ be on the same resource, but won't be under round-robin.
        const leaseB = await pool.acquire();
        expect(createFn).toHaveBeenCalledTimes(2);
        await pool.release(leaseB);
      });

      it('reuses resources when necessary', async () => {
        const {pool, createFn} = createPool({
          resourceAllocationMethod: ResourceAllocationMethod.EAGER,
          maxConcurrentLeasesPerResource: 2,
          maxResources: 3,
        });

        expect(createFn).not.toHaveBeenCalled();

        // Request more leases than we have resources (2 leases per resource).
        const leasePromises = Array.from({length: 6})
          .map(() => pool.acquire())
          .map(withInspection);
        await flushAllMicrotasks();

        expect(leasePromises[3]).toBeDone();
        expect(leasePromises[4]).toBeDone();
        expect(leasePromises[5]).toBeDone();
        await Promise.all(leasePromises);

        expect(createFn).toHaveBeenCalledTimes(3);
      });
    });
  });
});

describe('.wrapConcurrentPoolToHideLease', () => {
  function createWrappedPool() {
    const pool = {
      acquire: jest.fn().mockResolvedValue({resource: 1}),
      release: jest.fn(),
      retire: jest.fn(),
      drain: jest.fn(),
      getDiagnostics: jest.fn(),
    };

    const wrapped = wrapConcurrentPoolToHideLease(pool as any);
    return {pool, wrapped};
  }

  describe('acquire', () => {
    it('delegates acquire', async () => {
      const {pool, wrapped} = createWrappedPool();
      await wrapped.acquire();
      expect(pool.acquire).toHaveBeenCalled();
    });

    it('prevents acquiring the same resource twice', async () => {
      const {pool, wrapped} = createWrappedPool();
      await wrapped.acquire();
      expect(pool.acquire).toHaveBeenCalled();

      await expect(wrapped.acquire()).rejects.toThrowError(/concurrent/);
    });
  });

  describe('release', () => {
    it('delegates release', async () => {
      const {pool, wrapped} = createWrappedPool();
      const lease = await wrapped.acquire();
      await wrapped.release(lease);
      expect(pool.release).toHaveBeenCalled();
    });

    it('cleans up the resource tracking (allows more than 1 acquire)', async () => {
      const {wrapped} = createWrappedPool();
      const lease = await wrapped.acquire();
      await wrapped.release(lease);
      await wrapped.acquire();
    });
  });

  describe('retire', () => {
    it('delegates retire', async () => {
      const {pool, wrapped} = createWrappedPool();
      const lease = await wrapped.acquire();
      await wrapped.retire(lease);
      expect(pool.retire).toHaveBeenCalled();
    });
  });

  describe('drain', () => {
    it('delegates drain', async () => {
      const {pool, wrapped} = createWrappedPool();
      await wrapped.drain();
      expect(pool.drain).toHaveBeenCalled();
    });
  });

  describe('getDiagnostics', () => {
    it('delegates getDiagnostics', async () => {
      const {pool, wrapped} = createWrappedPool();
      await wrapped.getDiagnostics();
      expect(pool.getDiagnostics).toHaveBeenCalled();
    });
  });
});
