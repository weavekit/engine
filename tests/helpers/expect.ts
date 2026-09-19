import assert from 'node:assert/strict';

/**
 * Minimal bun:test-compatible `expect` surface on top of `node:assert/strict`.
 * Lets migrated test bodies keep their assertion calls while running under
 * `node --test`. Matchers added here stay thin wrappers over assert.
 */

const ARRAY_MARKER = Symbol('weavekit.arrayContaining');
const OBJECT_MARKER = Symbol('weavekit.objectContaining');

function matchObject(actual: unknown, expected: Record<string, unknown>): void {
  assert.ok(actual !== null && typeof actual === 'object' && !Array.isArray(actual));
  for (const [key, value] of Object.entries(expected)) {
    const entry: unknown = (actual as Record<string, unknown>)[key];
    deepEqualMatcher(entry, value);
  }
}

function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * bun/jest-compatible equality: arrays compare element-wise (same length), plain
 * objects compare as subsets (every expected key must be present and equal —
 * extra actual keys are allowed), and `expect.arrayContaining` /
 * `expect.objectContaining` markers resolve to their matchers.
 */
function deepEqualMatcher(actual: unknown, expected: unknown): void {
  if (typeof expected === 'object' && expected !== null) {
    const arr = (expected as Record<symbol, unknown>)[ARRAY_MARKER];
    if (arr !== undefined) {
      assert.ok(Array.isArray(actual), 'expected an array');
      for (const item of arr as unknown[]) {
        assert.ok(
          (actual as unknown[]).some((el) => {
            try {
              deepEqualMatcher(el, item);
              return true;
            } catch {
              return false;
            }
          }),
          'array does not contain expected item',
        );
      }
      return;
    }
    const partial = (expected as Record<symbol, unknown>)[OBJECT_MARKER];
    if (partial !== undefined) {
      matchObject(actual, partial as Record<string, unknown>);
      return;
    }
  }

  if (Array.isArray(actual) && Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, 'array lengths differ');
    for (let i = 0; i < actual.length; i += 1) {
      deepEqualMatcher(actual[i], expected[i]);
    }
    return;
  }
  if (isPlainObject(actual) && isPlainObject(expected)) {
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      if (value === undefined) {
        // jest/bun: `{ key: undefined }` matches either a missing key or an undefined value
        assert.equal((actual as Record<string, unknown>)[key], undefined, `key ${key} must be undefined`);
      } else {
        assert.ok(key in (actual as Record<string, unknown>), `missing key ${key}`);
        deepEqualMatcher((actual as Record<string, unknown>)[key], value);
      }
    }
    return;
  }
  assert.deepEqual(actual, expected);
}

function getPath(actual: unknown, path: string): unknown {
  let cur = actual as Record<string, unknown>;
  for (const part of path.split('.')) {
    cur = cur?.[part] as Record<string, unknown>;
  }
  return cur;
}

function expectImpl<T>(actual: T) {
  return {
    toBe(expected: unknown): void {
      assert.equal(actual, expected);
    },
    toEqual(expected: unknown): void {
      deepEqualMatcher(actual, expected);
    },
    toContain(expected: unknown): void {
      assert.ok(String(actual).includes(String(expected)));
    },
    toContainEqual(item: unknown): void {
      assert.ok(Array.isArray(actual));
      assert.ok(
        (actual as unknown[]).some((el) => {
          try {
            deepEqualMatcher(el, item);
            return true;
          } catch {
            return false;
          }
        }),
        'array does not contain equal item',
      );
    },
    toMatch(expected: RegExp): void {
      assert.match(String(actual), expected);
    },
    toBeTruthy(): void {
      assert.ok(actual);
    },
    toBeFalsy(): void {
      assert.ok(!actual);
    },
    toBeNull(): void {
      assert.equal(actual, null);
    },
    toBeUndefined(): void {
      assert.equal(actual, undefined);
    },
    toBeDefined(): void {
      assert.ok(actual !== undefined);
    },
    toHaveLength(length: number): void {
      assert.equal((actual as unknown as { length: number }).length, length);
    },
    toBeInstanceOf(cls: unknown): void {
      assert.ok(actual instanceof (cls as new () => unknown));
    },
    toMatchObject(expected: Record<string, unknown>): void {
      matchObject(actual, expected);
    },
    toHaveProperty(path: string, value?: unknown): void {
      const got = getPath(actual, path);
      if (value === undefined) assert.ok(got !== undefined, `expected property ${path}`);
      else assert.deepEqual(got, value);
    },
    toThrow(matcher?: unknown): void {
      assert.throws(actual as () => void, matcher as never);
    },
    toBeGreaterThan(n: number): void {
      assert.ok((actual as number) > n);
    },
    toBeGreaterThanOrEqual(n: number): void {
      assert.ok((actual as number) >= n);
    },
    toBeLessThan(n: number): void {
      assert.ok((actual as number) < n);
    },
    toBeLessThanOrEqual(n: number): void {
      assert.ok((actual as number) <= n);
    },
    not: {
      toBe(expected: unknown): void {
        assert.notEqual(actual, expected);
      },
      toBeNull(): void {
        assert.notEqual(actual, null);
      },
      toBeUndefined(): void {
        assert.ok(actual !== undefined);
      },
      toContain(expected: unknown): void {
        assert.ok(!String(actual).includes(String(expected)));
      },
      toHaveProperty(path: string): void {
        assert.ok(getPath(actual, path) === undefined, `expected property ${path} to be absent`);
      },
      toThrow(): void {
        assert.doesNotThrow(actual as () => void);
      },
    },
    get rejects() {
      return {
        toThrow: (matcher?: unknown) => assert.rejects(actual as Promise<unknown>, matcher as never),
      };
    },
    get resolves() {
      const value = () => Promise.resolve(actual) as Promise<unknown>;
      return {
        toBe: async (expected: unknown) => assert.equal(await value(), expected),
        toEqual: async (expected: unknown) => deepEqualMatcher(await value(), expected),
        toBeNull: async () => assert.equal(await value(), null),
        toBeUndefined: async () => assert.equal(await value(), undefined),
        toBeTruthy: async () => assert.ok(await value()),
        toHaveLength: async (length: number) =>
          assert.equal((await value() as unknown as { length: number }).length, length),
        toMatchObject: async (expected: Record<string, unknown>) => matchObject(await value(), expected),
      };
    },
  };
}

/** `expect.unreachable('should not get here')` — fails the current test */
function unreachable(message: string): never {
  assert.fail(message);
}

interface ExpectStatic {
  <T>(actual: T): ReturnType<typeof makeExpect<T>>;
  unreachable: (message: string) => never;
  arrayContaining: (items: unknown[]) => { [ARRAY_MARKER]: unknown[] };
  objectContaining: (partial: Record<string, unknown>) => { [OBJECT_MARKER]: Record<string, unknown> };
}

function makeExpect<T>(actual: T): ReturnType<typeof expectImpl<T>> {
  return expectImpl(actual);
}

export const expect = Object.assign(makeExpect, {
  unreachable,
  arrayContaining: (items: unknown[]) => ({ [ARRAY_MARKER]: items }) as never,
  objectContaining: (partial: Record<string, unknown>) => ({ [OBJECT_MARKER]: partial }) as never,
}) as ExpectStatic;
