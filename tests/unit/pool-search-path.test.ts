import { describe, it, expect } from '../helpers/test.js';
import { searchPathOptions } from '../../src/core/storage/pool.js';

/** minimal fake PoolClient capturing `set_config` calls */
function fakeClient(currentPath: string) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text.includes("current_setting('search_path')")) {
        return { rows: [{ path: currentPath }] } as never;
      }
      return { rows: [] } as never;
    },
  };
  return { client, calls };
}

describe('searchPathOptions — append system schema without clobbering search_path', () => {
  it('returns the plain pool when no system schema is configured', () => {
    expect(searchPathOptions(undefined)).toEqual({});
  });

  it('never sets the connection `options` (that would override URL/role search_path)', () => {
    const opts = searchPathOptions('weavekit');
    expect(opts.options).toBeUndefined();
    expect(typeof opts.onConnect).toBe('function');
  });

  it('appends the quoted system schema to the effective path', async () => {
    const { client, calls } = fakeClient('app, public');
    await searchPathOptions('weavekit').onConnect!(client as never);
    expect(calls[1]?.params).toEqual(['app, public, "weavekit"']);
  });

  it('uses just the system schema when the path is empty', async () => {
    const { client, calls } = fakeClient('  ');
    await searchPathOptions('weavekit').onConnect!(client as never);
    expect(calls[1]?.params).toEqual(['"weavekit"']);
  });

  it('fails closed on an invalid schema name', () => {
    expect(() => searchPathOptions('Bad Name')).toThrow();
  });
});
