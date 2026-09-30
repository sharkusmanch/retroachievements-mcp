import { deepFreeze } from '../src/client.js';

/**
 * A deep-frozen COPY of a fixture — what the real RAClient hands tools (parsed bodies
 * are frozen because they are shared through the cache). Tool fakes return these so an
 * in-place mutation of upstream data fails the test instead of corrupting the cache.
 */
export function frozen<T>(v: T): T {
  return v === undefined ? v : deepFreeze(structuredClone(v));
}
