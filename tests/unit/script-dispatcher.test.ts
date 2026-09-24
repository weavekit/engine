import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, after, before } from '../helpers/test.js';import type { Pool } from 'pg';
import { FIELD_TYPES, ObjectRegistry, SCRIPT_HOOKS, SchemaError } from '../../src/core/index.js';
import { createScriptDispatcher } from '../../src/subsystems/script/index.js';
import type { ObjectDataAccess } from '../../src/runtime/data-access/index.js';

let root: string;
let objectsDir: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wk-dispatch-'));
  objectsDir = join(root, 'objects');
  await mkdir(join(objectsDir, 'lead'), { recursive: true });
  await writeFile(
    join(objectsDir, 'lead', 'server.js'),
    `export function validate() { if (this.changes.amount <= 0) throw new Error('amount must be > 0'); }
export function beforeUpdate() { this.changes.approved = true; return this.changes; }
export async function afterUpdate() { throw new Error('side effect failed'); }
`,
  );
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeRegistry(): ObjectRegistry {
  const registry = new ObjectRegistry();
  registry.register({
    name: 'lead',
    fields: [{ name: 'id', type: FIELD_TYPES.STRING, primary: true }],
  });
  return registry;
}

function mockPool(): Pool {
  const client = {
    query: async () => ({ rows: [] }),
    release: () => {},
  };
  return { connect: async () => client } as unknown as Pool;
}

const noopDataAccess: ObjectDataAccess = {
  find: async () => ({ rows: [], total: 0 }),
  findOne: async () => null,
  create: async <T>() => ({}) as T,
  update: async <T>() => ({}) as T,
  transition: async <T>() => ({}) as T,
  delete: async () => {},
};

const ARGS = {
  record: { id: 'L1', amount: 10 },
  changes: { amount: 10 },
  user: { id: 'u1', roles: ['admin'] },
};

describe('createScriptDispatcher — orchestration and semantics', () => {
  it('has(): registered hook true, unknown false, object without script false', async () => {
    const dispatcher = await createScriptDispatcher({
      objectsDir,
      registry: makeRegistry(),
      pool: mockPool(),
      dataAccess: noopDataAccess,
    });
    expect(dispatcher.has('lead', SCRIPT_HOOKS.VALIDATE)).toBe(true);
    expect(dispatcher.has('lead', SCRIPT_HOOKS.ON_LOAD)).toBe(false);
    expect(dispatcher.has('nope', SCRIPT_HOOKS.VALIDATE)).toBe(false);
    await dispatcher.close();
  });

  it('unregistered hook → returns empty warnings directly, sandbox not invoked', async () => {
    const dispatcher = await createScriptDispatcher({
      objectsDir,
      registry: makeRegistry(),
      pool: mockPool(),
      dataAccess: noopDataAccess,
    });
    const result = await dispatcher.dispatch('lead', SCRIPT_HOOKS.ON_LOAD, ARGS);
    expect(result.warnings).toEqual([]);
    expect(result.changes).toBeUndefined();
    await dispatcher.close();
  });

  it('beforeUpdate returns modified changes', async () => {
    const dispatcher = await createScriptDispatcher({
      objectsDir,
      registry: makeRegistry(),
      pool: mockPool(),
      dataAccess: noopDataAccess,
    });
    const result = await dispatcher.dispatch('lead', SCRIPT_HOOKS.BEFORE_UPDATE, ARGS);
    expect(result.changes).toEqual({ amount: 10, approved: true });
    await dispatcher.close();
  });

  it('validate throws → SchemaError(script.abort), message passed through', async () => {
    const dispatcher = await createScriptDispatcher({
      objectsDir,
      registry: makeRegistry(),
      pool: mockPool(),
      dataAccess: noopDataAccess,
    });
    try {
      await dispatcher.dispatch('lead', SCRIPT_HOOKS.VALIDATE, { ...ARGS, changes: { amount: 0 } });
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as SchemaError).code).toBe('script.abort');
      expect((error as SchemaError).message).toContain('amount must be > 0');
    }
    await dispatcher.close();
  });

  it('server.js for unregistered object is filtered out (object absent from registry → ignored)', async () => {
    await mkdir(join(objectsDir, 'ghost'), { recursive: true });
    await writeFile(join(objectsDir, 'ghost', 'server.js'), 'export function validate() {}');
    const dispatcher = await createScriptDispatcher({
      objectsDir,
      registry: makeRegistry(),
      pool: mockPool(),
      dataAccess: noopDataAccess,
    });
    expect(dispatcher.has('ghost', SCRIPT_HOOKS.VALIDATE)).toBe(false);
    await dispatcher.close();
  });
});

describe('createScriptDispatcher — db RPC pass-through (withRbac dataAccess)', () => {
  it('this.db.objects call inside hook reaches injected dataAccess, with rebuilt subject', async () => {
    const calls: Array<{ object: string; method: string; ctx: unknown }> = [];
    const dataAccess: ObjectDataAccess = {
      ...noopDataAccess,
      find: async (objectName, opts, ctx) => {
        calls.push({ object: objectName, method: 'find', ctx });
        return { rows: [], total: 2 };
      },
    };
    await mkdir(join(objectsDir, 'rpc'), { recursive: true });
    await writeFile(
      join(objectsDir, 'rpc', 'server.js'),
      `export async function beforeUpdate() { const r = await this.db.objects('supplier').find({ filter: { status: 'open' } }); return this.changes; }`,
    );
    const registry = new ObjectRegistry();
    registry.register({ name: 'rpc', fields: [{ name: 'id', type: FIELD_TYPES.STRING, primary: true }] });

    const dispatcher = await createScriptDispatcher({
      objectsDir,
      registry,
      pool: mockPool(),
      dataAccess,
    });
    await dispatcher.dispatch('rpc', SCRIPT_HOOKS.BEFORE_UPDATE, {
      record: null,
      changes: { status: 'open' },
      user: { id: 'u1', roles: ['sales'] },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.object).toBe('supplier');
    expect((calls[0]?.ctx as { subject?: { id: string } }).subject?.id).toBe('u1');
    await dispatcher.close();
  });
});
