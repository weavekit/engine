import { describe, it as nodeIt, before, after, beforeEach, afterEach } from 'node:test';
export { describe, before, after, beforeEach, afterEach };
export type { TestContext } from 'node:test';

/**
 * bun:test-compatible `it(name, fn, timeout)` — node:test wants `{ timeout }`
 * as the 2nd argument, so wrap it to accept bun's trailing-number form.
 */
export function it(name: string, fn: () => void | Promise<void>, timeout?: number): void {
  if (timeout !== undefined) {
    nodeIt(name, { timeout }, fn);
  } else {
    nodeIt(name, fn);
  }
}

export { expect } from './expect.js';
