import { describe, it, expect } from '../helpers/test.js';import { createIdentityResolver } from '../../src/infrastructure/identity.js';
import type { RbacSubject } from '../../src/core/rbac/index.js';

const alice: RbacSubject = { id: 'u-alice', roles: ['sales'] };
const emma: RbacSubject = { id: 'u-emma', roles: ['finance'], teamId: 't1' };

describe('createIdentityResolver', () => {
  it('exact match ref → subject', () => {
    const resolve = createIdentityResolver({ alice, emma });
    expect(resolve('alice')).toEqual(alice);
    expect(resolve('emma')).toEqual(emma);
  });

  it('no match → null', () => {
    const resolve = createIdentityResolver({ alice });
    expect(resolve('ghost')).toBeNull();
  });

  it('empty directory → all null', () => {
    const resolve = createIdentityResolver({});
    expect(resolve('alice')).toBeNull();
  });

  it('missing object without override directory does not throw', () => {
    const resolve = createIdentityResolver({ alice });
    expect(() => resolve(undefined as unknown as string)).not.toThrow();
  });
});
