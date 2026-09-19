import { describe, it, expect } from '../helpers/test.js';import { McpSessionStore } from '../../src/adapters/mcp/session.js';
import type { RbacSubject } from '../../src/core/index.js';

const alice: RbacSubject = { id: 'u-alice', roles: ['sales'] };
const base = { agentKey: 'key-1', agentSubject: { id: 'a1', roles: ['agent'] }, user: alice, onBehalfOf: 'alice' };

describe('McpSessionStore', () => {
  it('create/get round-trip + lastActivity refresh', () => {
    const store = new McpSessionStore();
    store.create('s1', base, new Date(1000));
    expect(store.get('s1', new Date(2000))?.onBehalfOf).toBe('alice');
    expect(store.get('s1', new Date(2000))?.lastActivity.getTime()).toBe(2000);
  });

  it('get returns undefined and clears after TTL expiry', () => {
    const store = new McpSessionStore();
    store.create('s1', base, new Date(0));
    expect(store.get('s1', new Date(0) as unknown as Date)).toBeDefined();
    // beyond SESSION_TTL_MS (30min)
    const farFuture = new Date(0 + 31 * 60 * 1000);
    expect(store.get('s1', farFuture)).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it('delete and dispose', () => {
    const store = new McpSessionStore();
    store.create('s1', base);
    store.create('s2', base);
    store.delete('s1');
    expect(store.list().map((s) => s.id)).toEqual(['s2']);
    store.dispose();
    expect(store.list()).toHaveLength(0);
  });
});
