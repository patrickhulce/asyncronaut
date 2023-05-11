import {ActionOptions, GenericPoolDiagnostics, Pool} from './types';
import {withTimeout, createDecomposedPromise, DecomposedPromise} from './promises';
import createLogger from 'debug';

const log = createLogger('async-utils:concurrent-pool:verbose');

/**
 * @fileoverview
 *
 * A generic resource pool implementation that supports concurrent use of a single resource.
 * A resource goes through a number of lifecycle phases in a resource pool.
 *
 *    - Creation started but not yet completed, available. Such a resource has a `resourceRecord` tracked by the pool
 *      and can be leased to a pool consumer (the `.acquire` call will wait for the `.resourceRef` promise to resolve).
 *    - Creation completed, available. Such a resource has a `resourceRecord` with a fully resolved `.resourceRef` and
 *      can be leased to a pool consumer (the `.acquire` call will resolve immediately if available).
 *    - Retirement started, unavailable. Such a resource has hit its maximum lifetime and can no longer
 *      be leased to new pool consumers. The pool will wait for active leases to expire before destroying the resource.
 *    - Destroy started, unavailable. Such a resource has already started to be destroyed, has no
 *      active leases, and cannot be leased to new pool consumers.
 *    - Destroy complete, unavailable. Such a resource is no longer tracked by the resource pool, its `resourceRecord`
 *      is dereferenced, and cannot be leased to new pool consumers.
 */

export enum ResourceAllocationMethod {
  /** Creates resources only when necessary. Prioritizes reuse of existing resources.  */
  LAZY = 'lazy',
  /** Creates resources until `maxResources`. Prioritizes even distribution per resource.  */
  EAGER = 'eager',
}

export interface PoolOptions<TResource> {
  /** The function to create a resource. */
  create(): Promise<TResource>;
  /** The function to destroy a resource. */
  destroy(resource: TResource): Promise<void>;
  /** The function to invoke immediately before a resource is leased. A resource will not be acquired until the promise resolves, subject to the acquire timeout restrictions. If the promise rejects, the resource WILL NOT be acquired. */
  onAcquire?(lease: ResourceLease<TResource>): Promise<void>;
  /** The function to invoke immediately before a resource is released. A resource will not be released until this method completes, subject to the release timeout restrictions. If the promise rejects, the resource WILL STILL be released. */
  onRelease?(lease: ResourceLease<TResource>): Promise<void>;

  /** The method to use for allocating concurrent leases on resources. Defaults to LAZY. */
  resourceAllocationMethod?: ResourceAllocationMethod;
  /** The maximum number of leases to issue for a given resource. Defaults to 1. */
  maxConcurrentLeasesPerResource?: number;
  /** The minimum number of resources to keep alive in the pool at once. Defaults to 0. */
  minResources?: number;
  /** The maximum number of resources to have in the pool at once. Retired resources count towards this limit. Defaults to Infinity. */
  maxResources?: number;
  /** The maximum number of `acquire` requests to allow in the queue before future requests are rejected. Defaults to Infinity. */
  maxQueuedAcquireRequests?: number;
  /** The number of times to lease a specific resource to a requestor before retiring it. Defaults to Infinity. */
  retireResourceAfterUses?: number;
  /** The number of seconds a specific resource should be considered usable before retiring it. Defaults to Infinity. */
  retireResourceAfterSeconds?: number;
  /** The maximum number of seconds after a resource is scheduled to be retired to allow existing leases to complete. Defaults to Infinity. */
  destroyRetiredResourceForciblyAfterSeconds?: number;
  /** The number of milliseconds create should wait to resolve before being considered a failure. Defaults to Infinity. */
  createTimeoutMs?: number;
  /** The number of milliseconds destroy should wait to resolve before being considered a failure. Defaults to Infinity. */
  destroyTimeoutMs?: number;
  /** The default number of milliseconds acquire should wait to resolve before being rejecting. Defaults to Infinity. */
  defaultAcquireTimeoutMs?: number;
  /** The default number of milliseconds release should wait to resolve before being rejecting. Defaults to Infinity. */
  defaultReleaseTimeoutMs?: number;
  /** Automatically catch errors thrown by release. Defaults to false. */
  silenceReleaseErrors?: boolean;

  /** The implementation of wall-time to use. Mostly used for testing. Defaults to `Date` */
  wallTime?: {now: () => number};
}

export type ConcurrentPoolDiagnostics = GenericPoolDiagnostics;

export interface ResourceLease<TResource> {
  id: number;
  resource: TResource;
}

interface ResourceInternalLease<TResource> {
  id: number;
  leasedAt: number;
  resourceRef: Promise<TResource>;
  resourceRecord: ResourceRecord<TResource>;
}

interface ResourceRecord<TResource> {
  id: number;
  resourceRef: Promise<TResource>;
  destroyRef: Promise<{error: Error | undefined}> | undefined;
  createdAt: number;
  retiredAt: number | undefined;
  activeLeases: Array<ResourceInternalLease<TResource>>;
  pastLeases: Array<ResourceInternalLease<TResource>>;
}

export class ConcurrentResourcePool<TResource> {
  private _isDrained: boolean = false;
  private _options: Required<PoolOptions<TResource>>;
  private _nextId: number = 1;
  private _resourceRecords: Array<ResourceRecord<TResource>> = [];
  private _leaseById = new Map<number, ResourceInternalLease<TResource>>();
  private _acquireQueue: Array<DecomposedPromise<void>> = [];

  constructor(options: PoolOptions<TResource>) {
    this._options = {
      async onAcquire() {},
      async onRelease() {},

      maxConcurrentLeasesPerResource: 1,
      minResources: 0,
      maxResources: Infinity,
      maxQueuedAcquireRequests: Infinity,
      retireResourceAfterUses: Infinity,
      retireResourceAfterSeconds: Infinity,
      destroyRetiredResourceForciblyAfterSeconds: Infinity,
      createTimeoutMs: Infinity,
      destroyTimeoutMs: Infinity,
      defaultAcquireTimeoutMs: Infinity,
      defaultReleaseTimeoutMs: Infinity,
      resourceAllocationMethod: ResourceAllocationMethod.LAZY,
      silenceReleaseErrors: false,
      wallTime: Date,
      ...options,
    };
  }

  /**
   * Computes whether the resource pool has the additional capacity to create new resources.
   * Retired resources count towards this limit.
   * Resources that are in the process of being destroyed do NOT count toward this limit.
   * @returns Whether the pool has additional capacity to create new resources.
   */
  private _canCreateNewResource(): boolean {
    return this._resourceRecords.length < this._options.maxResources;
  }

  /**
   * Computes the number of new leases that could be issued if the pool's limits were met.
   * @returns The number of leases that could be immediately issued.
   */
  private _getAvailableCapacity(): number {
    const {maxConcurrentLeasesPerResource, maxResources} = this._options;

    let capacity = 0;

    for (const record of this._resourceRecords) {
      // A retired resource cannot accept new leases.
      if (record.retiredAt) continue;

      // Add the additional concurrent capacity of this individual resource.
      const numActiveLeases = record.activeLeases.length;
      const numAvailableLeases = maxConcurrentLeasesPerResource - numActiveLeases;
      capacity += numAvailableLeases;
    }

    // Add the additional conccurent capacity that could be available by creating new resources.
    const numActiveResources = this._resourceRecords.length;
    const numAdditionalResources = maxResources - numActiveResources;
    const numAdditionalLeases = numAdditionalResources * maxConcurrentLeasesPerResource;
    capacity += numAdditionalLeases;

    return capacity;
  }

  /**
   * Finds a currently available resource that could accept a new lease.
   * @returns The resource record of a resource that could accept a new lease or `undefined`.
   */
  private _findResourceWithCapacity(): ResourceRecord<TResource> | undefined {
    for (const record of this._resourceRecords) {
      // A retired resource cannot accept new leases.
      if (record.retiredAt) continue;

      // A resource at max concurrent capacity cannot accept new leases.
      const numActiveLeases = record.activeLeases.length;
      if (numActiveLeases >= this._options.maxConcurrentLeasesPerResource) continue;

      log(`resource #${record.id} has available capacity`);
      return record;
    }

    log(`no existing resources have available capacity`);
    return undefined;
  }

  /**
   * Creates the record of the resource, adds it to the pool's set of records, and starts (but does
   * not await) its creation.
   * @returns The resource record of the resource.
   */
  private _createResource(): ResourceRecord<TResource> {
    const id = this._nextId;
    this._nextId++;

    log(`creating resource #${id}`);

    const resourceRecord: ResourceRecord<TResource> = {
      id,
      createdAt: this._options.wallTime.now(),
      retiredAt: undefined,
      activeLeases: [],
      pastLeases: [],
      destroyRef: undefined,
      resourceRef: withTimeout(this._options.create(), {
        timeoutMs: this._options.createTimeoutMs,
        timeoutErrorMessage: `Failed to create resource in specified timeout`,
        cleanupOnResolve: (resource: TResource) => {
          log(`create resource #${id} timed out, but eventually resolved, destroying`);
          resourceRecord.resourceRef = Promise.resolve(resource);
          this._destroyResource(resourceRecord);
        },
      }).catch((err) => {
        log(`failed to create resource #${id}, destroying`);
        this._destroyResource(resourceRecord);
        throw err;
      }),
    };
    this._resourceRecords.push(resourceRecord);

    return resourceRecord;
  }

  /**
   * Removes the resource from the pool's set of records, releases all current leases on it, and
   * starts (but does not await) its destruction.
   * @param resourceRecord The record of the resource to destroy.
   * @returns void
   */
  private _destroyResource(resourceRecord: ResourceRecord<TResource>): void {
    log(`destroying resource #${resourceRecord.id}`);

    this._resourceRecords = this._resourceRecords.filter((record) => record !== resourceRecord);

    for (const lease of resourceRecord.activeLeases) {
      this._markResourceAsReleased(lease);
    }

    resourceRecord.destroyRef = withTimeout(
      resourceRecord.resourceRef.then((resource) => this._options.destroy(resource)),
      {timeoutMs: this._options.destroyTimeoutMs}
    )
      .then(() => ({error: undefined}))
      .catch((error) => ({error}));
  }

  /**
   * Creates a new lease on a resource, adds it to the pool's internal state, and triggers an update
   * to revalidate retirement/destruction of resources.
   * @param resourceRecord The record of the resource to lease.
   * @returns The newly created resource lease.
   */
  private _markResourceAsLeased(
    resourceRecord: ResourceRecord<TResource>
  ): ResourceInternalLease<TResource> {
    const id = this._nextId;
    this._nextId++;

    log(`leasing resource #${resourceRecord.id}, creating lease #${id}`);

    const lease: ResourceInternalLease<TResource> = {
      id,
      leasedAt: this._options.wallTime.now(),
      resourceRef: resourceRecord.resourceRef,
      resourceRecord,
    };
    resourceRecord.activeLeases.push(lease);
    this._leaseById.set(lease.id, lease);

    this._updateAvailableResources();
    return lease;
  }

  /**
   * Removes a lease from the resource and pool's internal state, and triggers an update
   * to revalidate retirement/destruction of resources.
   * @param lease The lease to expire.
   * @returns void
   */
  private _markResourceAsReleased(lease: ResourceInternalLease<TResource>): void {
    const record = lease.resourceRecord;

    log(`returning resource #${record.id}, ending lease #${lease.id}`);

    record.activeLeases = record.activeLeases.filter((l) => l !== lease);
    if (!record.pastLeases.includes(lease)) record.pastLeases.push(lease);
    this._leaseById.delete(lease.id);
    this._updateAvailableResources();
  }

  /**
   * Marks a resource as retired in the pool's internal state.
   * The resource will no longer be eligible to lease and will be a candidate for destruction.
   * @param resourceRecord The record of the resource to retire.
   * @returns void
   */
  private _markResourceAsRetired(resourceRecord: ResourceRecord<TResource>): void {
    log(`resource #${resourceRecord.id} retired`);
    resourceRecord.retiredAt = this._options.wallTime.now();
  }

  /**
   * Examines all resource records and marks any necessary candidates for retirement.
   *
   * A candidate for retirement is one that has exceeded its lifetime by number of uses or
   * seconds since creation.
   *
   * @returns void
   */
  private _markResourcesForRetirement(): void {
    const resourcesToRetire = this._resourceRecords.filter((record) => {
      if (record.retiredAt) return false;

      const numTotalLeases = record.activeLeases.length + record.pastLeases.length;
      if (numTotalLeases >= this._options.retireResourceAfterUses) return true;

      const lifetimeInSeconds = (this._options.wallTime.now() - record.createdAt) / 1000;
      if (lifetimeInSeconds >= this._options.retireResourceAfterSeconds) return true;

      return false;
    });

    log(`${resourcesToRetire.length} resources ready for retirement`);
    for (const record of resourcesToRetire) this._markResourceAsRetired(record);
  }

  /**
   * Ensures the minimum number of resources exists its in the pool, creating any necessary additions.
   *
   * @returns void
   */
  private _createMinimumResources(): void {
    if (this._isDrained) return;

    const numResourcesToCreate = this._options.minResources - this._resourceRecords.length;
    for (let i = 0; i < numResourcesToCreate; i++) {
      this._createResource();
    }
  }

  /**
   * Starts (but does not await) the destruction of all retired resources.
   *
   * @returns void
   */
  private _destroyRetiredResources(): void {
    for (const record of this._resourceRecords) {
      // Resource is not retired, do not destroy.
      if (!record.retiredAt) continue;

      // Destroy retired resources that have no more active leases or have been retired for too long.
      const numActiveLeases = record.activeLeases.length;
      const secondsSinceRetirement = this._options.wallTime.now() - record.retiredAt;
      const shouldForciblyClose =
        secondsSinceRetirement >= this._options.destroyRetiredResourceForciblyAfterSeconds;
      if (numActiveLeases === 0 || shouldForciblyClose) {
        this._destroyResource(record);
      }
    }
  }

  /**
   * The heartbeat of the pool that updates all resources to their correct lifecycle state and resolves
   * queued `.acquire` requests.
   * @returns void
   */
  private _updateAvailableResources(): void {
    this._markResourcesForRetirement();
    this._destroyRetiredResources();
    this._createMinimumResources();

    const maxAcquireRequestsToDequeue = this._getAvailableCapacity();
    for (let i = 0; i < maxAcquireRequestsToDequeue && this._acquireQueue.length; i++) {
      const nextRequest = this._acquireQueue.shift();
      nextRequest?.resolve();
    }
  }

  /**
   * Creates a new lease if there is available capacity. This method considers the
   * `resourceAllocationMethod` to determine whether to prefer existing resources or create new.
   * @returns void
   */
  private _acquireInternalLeaseIfAvailable(): ResourceInternalLease<TResource> | undefined {
    if (this._options.resourceAllocationMethod === ResourceAllocationMethod.LAZY) {
      const resourceRecord = this._findResourceWithCapacity();
      if (resourceRecord) return this._markResourceAsLeased(resourceRecord);

      if (this._canCreateNewResource()) {
        const resourceRecord = this._createResource();
        return this._markResourceAsLeased(resourceRecord);
      }
    } else if (this._options.resourceAllocationMethod === ResourceAllocationMethod.EAGER) {
      if (this._canCreateNewResource()) {
        const resourceRecord = this._createResource();
        return this._markResourceAsLeased(resourceRecord);
      }

      const resourceRecord = this._findResourceWithCapacity();
      if (resourceRecord) return this._markResourceAsLeased(resourceRecord);
    }

    return undefined;
  }

  /**
   * Creates the set of minimum resources and awaits their readiness.
   * @returns void
   */
  async initialize(): Promise<void> {
    if (this._isDrained) return Promise.reject(new Error(`Pool has been drained`));

    log(`intializing pool`);

    this._updateAvailableResources();
    await Promise.all(this._resourceRecords.map((record) => record.resourceRef));
  }

  /**
   * Waits for a resource to have capacity and obtains a lease on that resource, creating a resource
   * if necessary.
   *
   * If this operation times out or rejects, the lease is automatically released.
   *
   * @param options The options for this individual `.acquire` invocation.
   * @returns A lease on a pool resouce.
   */
  async acquire(options?: ActionOptions): Promise<ResourceLease<TResource>> {
    if (this._isDrained) return Promise.reject(new Error(`Pool has been drained`));

    const requestId = this._nextId;
    this._nextId++;
    log(`resource lease request #${requestId}`);

    this._updateAvailableResources();

    async function awaitAndReturnExternalLease(
      lease: ResourceInternalLease<TResource>,
      onAcquire: (externalLease: ResourceLease<TResource>) => Promise<void>
    ): Promise<ResourceLease<TResource>> {
      log(`lease #${lease.id} secured for request #${requestId}, awaiting resource ref`);
      const resource = await lease.resourceRef;
      log(`resource available for lease #${lease.id}, processing hook`);
      const externalLease = {id: lease.id, resource};
      await onAcquire(externalLease);
      log(`hook processed for lease #${lease.id}`);
      return externalLease;
    }

    let lease: ResourceInternalLease<TResource> | undefined;
    const abortController = new AbortController();

    return withTimeout(
      (async () => {
        lease = this._acquireInternalLeaseIfAvailable();
        if (lease) return awaitAndReturnExternalLease(lease, this._options.onAcquire);

        log(`no available capacity for request #${requestId}`);

        if (this._acquireQueue.length >= this._options.maxQueuedAcquireRequests) {
          log(`acquire queue size exceeded, rejecting request ${requestId}`);
          throw new Error(`Maximum acquire queue size exceeded`);
        }

        log(`request #${requestId} waiting for capacity, ${this._acquireQueue.length}th position`);

        const decomposedPromise = createDecomposedPromise<void>();
        this._acquireQueue.push(decomposedPromise);
        await decomposedPromise.promise;
        if (abortController.signal.aborted) throw new Error(`Operation aborted`);

        log(`request #${requestId} can be fulfilled`);

        lease = this._acquireInternalLeaseIfAvailable();
        if (!lease) throw new Error(`INVARIANT VIOLATION: No available capacity on dequeue.`);
        return awaitAndReturnExternalLease(lease, this._options.onAcquire);
      })(),
      {
        timeoutMs: options?.timeoutMs || this._options.defaultAcquireTimeoutMs,
        timeoutErrorMessage: `Failed to acquire a lease in specified timeout`,
        abortController,
      }
    ).catch((err) => {
      log(`failed to acquire lease for #${requestId}`);
      if (lease) this._markResourceAsReleased(lease);
      throw err;
    });
  }

  /**
   * Waits for the resource to be cleaned up (if necessary) and returns the lease to the pool.
   *
   * If this operation times out or rejects, the lease is still released.
   *
   * @param externalLease The lease obtained by `.acquire`
   * @param options The options for this individual `.release` invocation.
   * @returns void
   */
  async release(externalLease: ResourceLease<TResource>, options?: ActionOptions): Promise<void> {
    const lease = this._leaseById.get(externalLease.id);

    await withTimeout(
      (async () => {
        log(`lease #${externalLease.id} to be released, processing hooks`);

        await this._options.onRelease(externalLease);

        log(`lease #${externalLease.id} hooks processed, releasing`);

        if (lease) this._markResourceAsReleased(lease);

        const destroyRef = lease?.resourceRecord.destroyRef;
        if (!destroyRef) return;

        log(`lease #${externalLease.id} released, destroying resource`);
        const {error} = await destroyRef;
        if (error) throw error;
      })(),
      {timeoutMs: options?.timeoutMs || this._options.defaultReleaseTimeoutMs}
    ).catch((err) => {
      log(`lease #${externalLease.id} failure during release`);
      if (lease) this._markResourceAsReleased(lease);
      if (this._options.silenceReleaseErrors) return;
      throw err;
    });
  }

  /**
   * Immediately retire the resource associated with a lease and release the lease.
   *
   * @param externalLease The lease obtained by `.acquire`
   * @param options The options for this individual `.retire` invocation.
   * @returns void
   */
  async retire(externalLease: ResourceLease<TResource>, options?: ActionOptions): Promise<void> {
    log(`lease #${externalLease.id} to be retired`);

    const lease = this._leaseById.get(externalLease.id);
    if (!lease) return;

    this._markResourceAsRetired(lease.resourceRecord);
    this._updateAvailableResources();
    await this.release(externalLease, options);
  }

  /**
   * Shutdown the pool.
   * Start (and await) the destruction of all resources. All leases are expired in the process.
   *
   * @returns void
   */
  async drain(): Promise<void> {
    log(`draining pool`);
    this._isDrained = true;
    const resourceRecords = this._resourceRecords.slice();
    for (const record of resourceRecords) this._destroyResource(record);
    await Promise.all(resourceRecords.map((record) => record.destroyRef));
  }

  /**
   * Returns information on the state of the pool.
   *
   * @returns The set of current resources and leases.
   */
  getDiagnostics(): ConcurrentPoolDiagnostics {
    return {
      resources: this._resourceRecords.map((record) => ({
        id: record.id,
        createdAt: record.createdAt,
        retiredAt: record.retiredAt,
      })),
      leases: Array.from(this._leaseById.values()).map((lease) => ({
        id: lease.id,
        resourceId: lease.resourceRecord.id,
      })),
    };
  }
}

/**
 * Simplifies the concurrent pool interface to hide the underlying lease information by eliminating
 * concurrency support (e.g. each resource can be leased exactly once).
 *
 * @param pool The concurrent resource pool to wrap.
 * @returns A wrapped version of the pool that eliminates concurrency.
 */
export function wrapConcurrentPoolToHideLease<T>(
  pool: ConcurrentResourcePool<T>
): Pool<T, ConcurrentPoolDiagnostics> {
  const resourceToLease = new Map<T, ResourceLease<T>>();

  return {
    async acquire(options) {
      const lease = await pool.acquire(options);
      if (resourceToLease.has(lease.resource)) throw new Error(`Wrapped pool cannot be concurrent`);
      resourceToLease.set(lease.resource, lease);
      return lease.resource;
    },
    async release(resource, options) {
      const lease = resourceToLease.get(resource);
      if (!lease) return;
      resourceToLease.delete(resource);
      return pool.release(lease, options);
    },
    async retire(resource, options) {
      const lease = resourceToLease.get(resource);
      if (!lease) return;
      resourceToLease.delete(resource);
      return pool.retire(lease, options);
    },
    drain: pool.drain.bind(pool),
    getDiagnostics: pool.getDiagnostics.bind(pool),
  };
}
