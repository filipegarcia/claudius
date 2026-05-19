/**
 * Tiny pub/sub used by the main-process IPC handlers to cross-talk
 * when no BrowserWindow is involved (e.g. a notification click that
 * arrives just as the last window closes).
 *
 * Phase 6 of docs/electron-conversion/PLAN.md.
 */
export type Bus = {
  publish(topic: string, value: unknown): void;
  subscribe(topic: string, cb: (value: unknown) => void): () => void;
};

export function createBus(): Bus {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  return {
    publish(topic, value) {
      listeners.get(topic)?.forEach((cb) => {
        try {
          cb(value);
        } catch (err) {
          console.error(`[electron/bus] listener for ${topic} threw:`, err);
        }
      });
    },
    subscribe(topic, cb) {
      let set = listeners.get(topic);
      if (!set) {
        set = new Set();
        listeners.set(topic, set);
      }
      set.add(cb);
      return () => {
        set?.delete(cb);
      };
    },
  };
}
