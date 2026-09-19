import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry, SCRIPT_HOOKS, SchemaError } from '../../src/core/index.js';
import type { ScriptDispatchArgs, ScriptDispatchResult, ScriptDispatcher } from '../../src/core/index.js';
import { createDataAccess } from '../../src/runtime/data-access/index.js';
import type { DataAccessContext } from '../../src/runtime/data-access/index.js';

function registryOf(): ObjectRegistry {
  const reg = new ObjectRegistry();
  reg.register({
    name: 'lead',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'title', type: 'string' },
      { name: 'amount', type: 'number' },
    ],
  });
  reg.buildGraph();
  return reg;
}

/** fake dispatcher with configurable behavior + call recording */
function fakeDispatcher(behavior: {
  has?: (obj: string) => boolean;
  dispatch?: (obj: string, hook: string, args: ScriptDispatchArgs) => Promise<ScriptDispatchResult>;
}): { dispatcher: ScriptDispatcher; calls: Array<{ obj: string; hook: string; args: ScriptDispatchArgs }> } {
  const calls: Array<{ obj: string; hook: string; args: ScriptDispatchArgs }> = [];
  return {
    calls,
    dispatcher: {
      has: behavior.has ?? ((_obj: string, hook: string) => hook === SCRIPT_HOOKS.ON_LOAD),
      dispatch: async (obj, hook, args) => {
        calls.push({ obj, hook, args });
        return (behavior.dispatch ?? (async () => ({ warnings: [] })))(obj, hook, args);
      },
      close: async () => {},
    },
  };
}

/** fake pool: find returns canned rows; write path returns empty rows */
function fakePool(findRows: Record<string, unknown>[]): never {
  const handler = async (sql: string) => {
    if (/COUNT/i.test(sql)) return { rows: [{ total: findRows.length }] };
    if (/SELECT/i.test(sql)) return { rows: findRows };
    if (/BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET\s/i.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  const client = { query: handler, release: () => {} };
  return { query: handler, connect: async () => client } as never;
}

const ctx = (pool: DataAccessContext['pool'], registry: ObjectRegistry): DataAccessContext => ({ pool, registry });

describe('onLoad read hook — find/findOne/create/update', () => {
  it('find: onLoad receives whole batch of records, returns same-length array replacing result', async () => {
    const reg = registryOf();
    const rows = [{ id: 'L1', title: 'a' }, { id: 'L2', title: 'b' }];
    const fake = fakeDispatcher({
      dispatch: async (_o, _h, args) => ({
        records: (args.records ?? []).map((r) => ({ ...r, decorated: true })),
        warnings: [],
      }),
    });
    const da = createDataAccess({ script: fake.dispatcher });
    const res = await da.find('lead', {}, ctx(fakePool(rows), reg));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.hook).toBe(SCRIPT_HOOKS.ON_LOAD);
    expect(fake.calls[0]!.args.records).toEqual(rows);
    expect(fake.calls[0]!.args.record).toBeNull();
    expect(res.rows).toEqual([
      { id: 'L1', title: 'a', decorated: true },
      { id: 'L2', title: 'b', decorated: true },
    ]);
    expect(res.total).toBe(2); // total = DB count, unaffected by transformation
  });

  it('find: no onLoad hook → zero dispatch, zero-overhead passthrough', async () => {
    const reg = registryOf();
    const rows = [{ id: 'L1', title: 'a' }];
    const fake = fakeDispatcher({ has: () => false });
    const da = createDataAccess({ script: fake.dispatcher });
    const res = await da.find('lead', {}, ctx(fakePool(rows), reg));
    expect(fake.calls).toHaveLength(0);
    expect(res.rows).toEqual(rows);
  });

  it('find: onLoad returns undefined → original rows kept', async () => {
    const reg = registryOf();
    const rows = [{ id: 'L1', title: 'a' }];
    const fake = fakeDispatcher({ dispatch: async () => ({ warnings: [] }) });
    const da = createDataAccess({ script: fake.dispatcher });
    const res = await da.find('lead', {}, ctx(fakePool(rows), reg));
    expect(res.rows).toEqual(rows);
  });

  it('find: onLoad returns mismatched length → script.abort (fail-closed)', async () => {
    const reg = registryOf();
    const rows = [{ id: 'L1', title: 'a' }, { id: 'L2', title: 'b' }];
    const fake = fakeDispatcher({ dispatch: async () => ({ records: [{ id: 'L1' }], warnings: [] }) });
    const da = createDataAccess({ script: fake.dispatcher });
    let caught: SchemaError | undefined;
    try {
      await da.find('lead', {}, ctx(fakePool(rows), reg));
    } catch (e) {
      caught = e as SchemaError;
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe('script.abort');
    expect(String(caught!.params.message)).toContain('returned 1 records, expected 2');
  });

  it('findOne: delegates to find, takes row after 1-element batch transform', async () => {
    const reg = registryOf();
    const rows = [{ id: 'L1', title: 'a' }];
    const fake = fakeDispatcher({
      dispatch: async (_o, _h, args) => ({ records: (args.records ?? []).map((r) => ({ ...r, loaded: true })), warnings: [] }),
    });
    const da = createDataAccess({ script: fake.dispatcher });
    const found = await da.findOne('lead', 'L1', ctx(fakePool(rows), reg));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.args.records).toHaveLength(1);
    expect(found).toEqual({ id: 'L1', title: 'a', loaded: true });
  });

  it('reentrancy guard: find same object inside onLoad → not triggered again', async () => {
    const reg = registryOf();
    const rows = [{ id: 'L1', title: 'a' }];
    const holder: { da?: ReturnType<typeof createDataAccess> } = {};
    const fake = fakeDispatcher({
      dispatch: async () => {
        // simulates this.db.objects('lead').find() reentrancy inside the hook
        await holder.da!.find('lead', {}, ctx(fakePool(rows), reg));
        return { warnings: [] };
      },
    });
    holder.da = createDataAccess({ script: fake.dispatcher });
    await holder.da.find('lead', {}, ctx(fakePool(rows), reg));
    expect(fake.calls).toHaveLength(1); // inner find skipped by guard
  });

  it('create: returned record passes through onLoad (1-element batch)', async () => {
    const reg = registryOf();
    const fake = fakeDispatcher({
      dispatch: async (_o, _h, args) => ({ records: (args.records ?? []).map((r) => ({ ...r, created: true })), warnings: [] }),
    });
    const da = createDataAccess({ script: fake.dispatcher });
    const created = await da.create('lead', { id: 'L1', title: 't', amount: 1 }, ctx(fakePool([]), reg));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.hook).toBe(SCRIPT_HOOKS.ON_LOAD);
    expect(created).toEqual(expect.objectContaining({ id: 'L1', title: 't', amount: 1, created: true }));
  });

  it('update: returned record passes through onLoad (1-element batch)', async () => {
    const reg = registryOf();
    const rows = [{ id: 'L1', title: 'a', amount: 1 }];
    const fake = fakeDispatcher({
      dispatch: async (_o, _h, args) => ({ records: (args.records ?? []).map((r) => ({ ...r, updated: true })), warnings: [] }),
    });
    const da = createDataAccess({ script: fake.dispatcher });
    const updated = await da.update('lead', 'L1', { title: 'b' }, ctx(fakePool(rows), reg));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.hook).toBe(SCRIPT_HOOKS.ON_LOAD);
    expect(updated).toEqual(expect.objectContaining({ id: 'L1', title: 'b', amount: 1, updated: true }));
  });
});
