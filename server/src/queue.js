/**
 * Tiny concurrency-limited job queue with de-duplication by key.
 * Keeps ffmpeg from eating the whole NAS when a large library is indexed.
 */
export function createQueue({ concurrency = 2, name = 'queue' } = {}) {
  const pending = [];
  const known = new Map();
  let active = 0;
  let idleResolvers = [];

  const stats = () => ({ name, active, pending: pending.length });

  function drain() {
    while (active < concurrency && pending.length > 0) {
      const job = pending.shift();
      active += 1;
      Promise.resolve()
        .then(() => job.fn())
        .then(
          (value) => job.resolve(value),
          (error) => {
            if (job.onError) {
              try {
                job.onError(error);
              } catch {
                /* ignore */
              }
            }
            job.reject(error);
          }
        )
        .finally(() => {
          active -= 1;
          known.delete(job.key);
          if (active === 0 && pending.length === 0) {
            const resolvers = idleResolvers;
            idleResolvers = [];
            resolvers.forEach((fn) => fn());
          }
          drain();
        });
    }
  }

  return {
    push(key, fn, { onError } = {}) {
      if (key && known.has(key)) return known.get(key);
      const promise = new Promise((resolve, reject) => {
        pending.push({ key, fn, resolve, reject, onError });
      });
      if (key) known.set(key, promise);
      drain();
      return promise;
    },
    has: (key) => known.has(key),
    stats,
    onIdle() {
      if (active === 0 && pending.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleResolvers.push(resolve));
    },
  };
}
