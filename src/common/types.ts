export interface GenericPoolDiagnostics {
  resources: Array<{id: number; createdAt: number; retiredAt: number | undefined}>;
  leases: Array<{id: number; resourceId: number}>;
}

export interface Pool<TPoolItem, TDiagnostics = GenericPoolDiagnostics> {
  /** Acquires a resource from the pool, waits until a resource is available before resolving. */
  acquire(opts?: ActionOptions): Promise<TPoolItem>;
  /** Releases a resource back to the pool, waits until necessary cleanup has been performed before resolving. */
  release(object: TPoolItem, opts?: ActionOptions): Promise<void>;
  /** Releases a resource back to the pool and retires it (makes it unavailable for future use). */
  retire(object: TPoolItem, opts?: ActionOptions): Promise<void>;
  /** Destroys all resources in the pool. */
  drain(): Promise<void>;
  /** Returns information about the internal state of the pool. */
  getDiagnostics(): TDiagnostics;
}

export interface ActionOptions {
  /** The time before the action should be cancelled in milliseconds. */
  timeoutMs?: number;
}
