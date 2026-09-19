import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry } from '../../src/core/index.js';
import { createScriptRpcExecutor } from '../../src/subsystems/script/bridge.js';
import type { RpcExecutor, RpcRequest } from '../../src/subsystems/script/backend/types.js';
import type { ObjectDataAccess, FindOptions, FindResult } from '../../src/runtime/data-access/index.js';

function makeExecutor(maxObjectsPerQuery: number): { executor: RpcExecutor; findCalls: Array<{ name: string; opts: FindOptions }> } {
  const findCalls: Array<{ name: string; opts: FindOptions }> = [];
  const dataAccess = {
    find: async (name: string, opts: FindOptions): Promise<FindResult> => {
      findCalls.push({ name, opts });
      return { rows: [], total: 0 };
    },
  } as unknown as ObjectDataAccess;
  const registry = new ObjectRegistry();
  const executor = createScriptRpcExecutor({
    pool: {} as never,
    registry,
    dataAccess,
    services: {} as never,
    queryTimeoutMs: 1000,
    rlsRole: 'weavekit_query',
    maxObjectsPerQuery,
  });
  return { executor, findCalls };
}

function req(method: string, args: unknown[]): RpcRequest {
  return { ns: 'objects', method, args, user: { id: 'u1', roles: ['sales'] } };
}

describe('bridge handleObjects — maxObjectsPerQuery tightens find limit', () => {
  it('find: limit above cap is clamped; omitted limit uses cap', async () => {
    const { executor, findCalls } = makeExecutor(50);
    await executor(req('find', ['lead', 'find', { limit: 1000 }]), 1000);
    await executor(req('find', ['lead', 'find', {}]), 1000);
    expect(findCalls[0]!.opts.limit).toBe(50);
    expect(findCalls[1]!.opts.limit).toBe(50);
  });

  it('find: limit below cap unchanged; limit 0 raised to 1', async () => {
    const { executor, findCalls } = makeExecutor(50);
    await executor(req('find', ['lead', 'find', { limit: 10 }]), 1000);
    await executor(req('find', ['lead', 'find', { limit: 0 }]), 1000);
    expect(findCalls[0]!.opts.limit).toBe(10);
    expect(findCalls[1]!.opts.limit).toBe(1);
  });

  it('findOne / write methods unaffected by clamp', async () => {
    const { findCalls } = makeExecutor(50);
    const da = {
      findOne: async () => null,
      create: async () => ({ id: 'x' }),
      update: async () => ({ id: 'x' }),
    } as unknown as ObjectDataAccess;
    const registry = new ObjectRegistry();
    const ex2 = createScriptRpcExecutor({
      pool: {} as never,
      registry,
      dataAccess: da,
      services: {} as never,
      queryTimeoutMs: 1000,
      rlsRole: 'weavekit_query',
      maxObjectsPerQuery: 50,
    });
    await ex2(req('findOne', ['lead', 'findOne', 'L1']), 1000);
    await ex2(req('create', ['lead', 'create', { id: 'x' }]), 1000);
    expect(findCalls).toHaveLength(0); // only find is triggered; the rest are not clamped
  });
});
