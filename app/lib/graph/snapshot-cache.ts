import type { GraphSnapshot } from "./model";

type SnapshotCacheEntry = {
  fingerprint: string;
  snapshot: GraphSnapshot;
};

const cloneSnapshot = (snapshot: GraphSnapshot) => structuredClone(snapshot);

/**
 * Keeps one immutable GraphSnapshot per fingerprint and coalesces concurrent
 * requests. Every caller receives a clone so later consolidation/analytics
 * cannot mutate the cached source candidate.
 */
export function createGraphSnapshotCache() {
  let entry: SnapshotCacheEntry | null = null;
  let pending: { fingerprint: string; promise: Promise<GraphSnapshot> } | null = null;

  return {
    async get(
      fingerprint: string,
      load: () => Promise<GraphSnapshot>,
    ): Promise<GraphSnapshot> {
      if (entry?.fingerprint === fingerprint) return cloneSnapshot(entry.snapshot);
      if (pending?.fingerprint === fingerprint) {
        return cloneSnapshot(await pending.promise);
      }
      const promise = load().then((snapshot) => {
        const immutableSource = cloneSnapshot(snapshot);
        entry = { fingerprint, snapshot: immutableSource };
        return immutableSource;
      });
      pending = { fingerprint, promise };
      try {
        return cloneSnapshot(await promise);
      } finally {
        if (pending?.promise === promise) pending = null;
      }
    },
    clear() {
      entry = null;
      pending = null;
    },
  };
}
