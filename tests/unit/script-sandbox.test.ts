import { describe, expect, it, before, after } from '../helpers/test.js';
import { SCRIPT_HOOKS, SchemaError } from '../../src/core/index.js';
import type { RpcExecutor, SandboxEntry, SandboxInstance } from '../../src/subsystems/script/backend/types.js';
import { createIsolatedVmSandboxBackend } from '../../src/subsystems/script/backend/isolated-vm.js';

const ENTRY: SandboxEntry = {
  name: 'lead',
  source: `
// helper (not exported) — must be ignored
function helper() { return 42; }

export function validate() {
  if (this.changes.amount <= 0) throw new Error('amount must be > 0');
  return true;
}

export function beforeUpdate() {
  this.changes.approved = true;
  return this.changes;
}

export async function withRpc() {
  const res = await this.db.objects('supplier').find({ filter: { status: 'open' } });
  return res.total;
}
`,
  hooks: [SCRIPT_HOOKS.VALIDATE, SCRIPT_HOOKS.BEFORE_UPDATE, SCRIPT_HOOKS.AFTER_UPDATE],
};

const rpcCalls: Array<{ ns: string; method: string; args: unknown[] }> = [];

const executor: RpcExecutor = async (req) => {
  rpcCalls.push({ ns: req.ns, method: req.method, args: req.args });
  if (req.ns === 'objects' && req.method === 'find') {
    return { rows: [], total: 3 };
  }
  throw new Error('unexpected rpc');
};

describe('IsolatedVmSandboxInstance — compilation and execution', () => {
  let backend: ReturnType<typeof createIsolatedVmSandboxBackend>;
  let instance: SandboxInstance;

  before(async () => {
    backend = createIsolatedVmSandboxBackend({ timeoutMs: 5000, queryTimeoutMs: 1000, memoryLimitMb: 64 });
    instance = backend.create(ENTRY, executor);
  });
  after(async () => {
    await instance.close();
    await backend.close();
  });

  it('exported hooks available, helper ignored', async () => {
    const result = await instance.call(SCRIPT_HOOKS.VALIDATE, {
      record: null,
      changes: { amount: 10 },
      user: { id: 'u1', roles: ['admin'] },
    });
    expect(result.ok).toBe(true);
  });

  it('this.changes can be modified and is returned with the result (beforeUpdate contract)', async () => {
    const result = await instance.call(SCRIPT_HOOKS.BEFORE_UPDATE, {
      record: { id: 'L1', amount: 10 },
      changes: { amount: 10 },
      user: { id: 'u1', roles: ['admin'] },
    });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ amount: 10, approved: true });
  });

  it('hook throws → code=abort + message passed through', async () => {
    const result = await instance.call(SCRIPT_HOOKS.VALIDATE, {
      record: null,
      changes: { amount: 0 },
      user: { id: 'u1', roles: ['admin'] },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('abort');
    expect(result.error?.message).toContain('amount must be > 0');
  });

  it('db RPC round trip: worker posts message → executor runs → result returns to hook', async () => {
    const missing = await instance.call('beforeTransition' as never, {
      record: null,
      changes: {},
      user: { id: 'u1', roles: ['admin'] },
    });
    expect(missing.ok).toBe(false);
    expect(missing.error?.message).toContain('no hook');

    rpcCalls.length = 0;
    const rpcResult = await instance.call('withRpc' as never, {
      record: null,
      changes: {},
      user: { id: 'u1', roles: ['admin'] },
    });
    expect(rpcCalls.length).toBeGreaterThan(0);
    expect(rpcCalls[0]?.ns).toBe('objects');
    expect(rpcCalls[0]?.method).toBe('find');
    expect(rpcResult.ok).toBe(true);
    expect(rpcResult.value).toBe(3);
  });
});

describe('IsolatedVmSandboxInstance — timeout and crash', () => {
  it('infinite loop (CPU) → terminated by eval timeout, code=timeout', async () => {
    const backend = createIsolatedVmSandboxBackend({ timeoutMs: 2000, queryTimeoutMs: 1000, memoryLimitMb: 64 });
    const inst = backend.create(
      { name: 'spin', source: 'export function beforeUpdate(){ while(true){} }', hooks: [SCRIPT_HOOKS.BEFORE_UPDATE] },
      executor,
    );
    const t0 = Date.now();
    const result = await inst.call(SCRIPT_HOOKS.BEFORE_UPDATE, { record: null, changes: {}, user: { id: 'u1', roles: [] } });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(4000);
    await inst.close();
    await backend.close();
  });

  it('CPU infinite loop in async hook → terminated by eval timeout, code=timeout', async () => {
    const backend = createIsolatedVmSandboxBackend({ timeoutMs: 2000, queryTimeoutMs: 100, memoryLimitMb: 64 });
    const inst = backend.create(
      { name: 'asyncspin', source: 'export async function afterUpdate(){ while(true){} }', hooks: [SCRIPT_HOOKS.AFTER_UPDATE] },
      executor,
    );
    const t0 = Date.now();
    const result = await inst.call(SCRIPT_HOOKS.AFTER_UPDATE, { record: null, changes: {}, user: { id: 'u1', roles: [] } });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(4000);
    await inst.close();
    await backend.close();
  });

  it('truly pending async hook (await on a promise that never resolves) → judged timeout, no silent success', async () => {
    const backend = createIsolatedVmSandboxBackend({ timeoutMs: 1000, queryTimeoutMs: 500, memoryLimitMb: 64 });
    const inst = backend.create(
      { name: 'hang', source: 'export async function beforeUpdate(){ await new Promise(()=>{}); return {a:1}; }', hooks: [SCRIPT_HOOKS.BEFORE_UPDATE] },
      executor,
    );
    const t0 = Date.now();
    const result = await inst.call(SCRIPT_HOOKS.BEFORE_UPDATE, { record: null, changes: {}, user: { id: 'u1', roles: [] } });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(4000);
    await inst.close();
    await backend.close();
  });

  it('after poisoning sandbox (pending async), next call rebuilds automatically without sandbox error', async () => {
    const backend = createIsolatedVmSandboxBackend({ timeoutMs: 1000, queryTimeoutMs: 500, memoryLimitMb: 64 });
    const inst = backend.create(
      { name: 'rebuild', source: 'export async function beforeUpdate(){ await new Promise(()=>{}); }', hooks: [SCRIPT_HOOKS.BEFORE_UPDATE] },
      executor,
    );
    const r1 = await inst.call(SCRIPT_HOOKS.BEFORE_UPDATE, { record: null, changes: {}, user: { id: 'u1', roles: [] } });
    expect(r1.ok).toBe(false);
    expect(r1.error?.code).toBe('timeout');
    const r2 = await inst.call(SCRIPT_HOOKS.BEFORE_UPDATE, { record: null, changes: {}, user: { id: 'u1', roles: [] } });
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe('timeout');
    await inst.close();
    await backend.close();
  });

  it('syntax error → script.compile, subsequent call throws SchemaError(script.compile)', async () => {
    const backend = createIsolatedVmSandboxBackend({ timeoutMs: 1000, queryTimeoutMs: 500, memoryLimitMb: 64 });
    const inst = backend.create(
      { name: 'bad', source: 'export function beforeUpdate( {', hooks: [SCRIPT_HOOKS.BEFORE_UPDATE] },
      executor,
    );
    try {
      await inst.call(SCRIPT_HOOKS.BEFORE_UPDATE, { record: null, changes: {}, user: { id: 'u1', roles: [] } });
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as SchemaError).code).toBe('script.compile');
    }
    await inst.close();
    await backend.close();
  });
});

describe('IsolatedVmSandboxInstance — escape prevention (true isolation)', () => {
  const ESCAPE_SOURCE = `
export function beforeUpdate() {
  const probe = {};
  const r = {
    typeofProcess: typeof process,
    typeofRequire: typeof require,
    typeofFetch: typeof fetch,
    typeofBuffer: typeof Buffer,
    typeofGlobal: typeof global,
    typeofSetTimeout: typeof setTimeout,
    newFunction: (function(){ try { return new Function('return typeof process')(); } catch (e) { return 'throws:' + e.name; } })(),
    ctorChain: (function(){ try { return probe.constructor.constructor('return typeof process')(); } catch (e) { return 'throws:' + e.name; } })(),
    directEval: (function(){ try { return eval('typeof process'); } catch (e) { return 'throws:' + e.name; } })(),
  };
  return r;
}
`;

  it('host capability globals (process/require/fetch/Buffer/setTimeout) all unreachable', async () => {
    const backend = createIsolatedVmSandboxBackend({ timeoutMs: 2000, queryTimeoutMs: 1000, memoryLimitMb: 64 });
    const inst = backend.create(
      { name: 'escape', source: ESCAPE_SOURCE, hooks: [SCRIPT_HOOKS.BEFORE_UPDATE] },
      executor,
    );
    const result = await inst.call(SCRIPT_HOOKS.BEFORE_UPDATE, { record: null, changes: {}, user: { id: 'u1', roles: [] } });
    expect(result.ok).toBe(true);
    const probe = result.value as Record<string, unknown>;
    expect(probe.typeofProcess).toBe('undefined');
    expect(probe.typeofRequire).toBe('undefined');
    expect(probe.typeofFetch).toBe('undefined');
    expect(probe.typeofBuffer).toBe('undefined');
    expect(probe.typeofGlobal).toBe('undefined');
    expect(probe.typeofSetTimeout).toBe('undefined');
    expect(probe.newFunction).toBe('undefined');
    expect(probe.ctorChain).toBe('undefined');
    expect(probe.directEval).toBe('undefined');
    await inst.close();
    await backend.close();
  });

  it('prototype chain pollution of host is ineffective: Object.prototype is within the isolated realm', async () => {
    const backend = createIsolatedVmSandboxBackend({ timeoutMs: 2000, queryTimeoutMs: 1000, memoryLimitMb: 64 });
    const inst = backend.create(
      {
        name: 'proto',
        source: `export function beforeUpdate() {
          Object.prototype.polluted = 'yes';
          return { polluted: ({}).polluted };
        }`,
        hooks: [SCRIPT_HOOKS.BEFORE_UPDATE],
      },
      executor,
    );
    const result = await inst.call(SCRIPT_HOOKS.BEFORE_UPDATE, { record: null, changes: {}, user: { id: 'u1', roles: [] } });
    expect(result.ok).toBe(true);
    expect((result.value as Record<string, unknown>).polluted).toBe('yes');
    // host is unaffected
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await inst.close();
    await backend.close();
  });
});

describe('IsolatedVmSandboxInstance — close handshake confirmation', () => {
  it('normal close returns true (worker replies closed ack, isolate release confirmed)', async () => {
    const backend = createIsolatedVmSandboxBackend({ timeoutMs: 2000, queryTimeoutMs: 1000, memoryLimitMb: 64 });
    const inst = backend.create(ENTRY, executor);
    const result = await inst.call(SCRIPT_HOOKS.VALIDATE, { record: null, changes: {}, user: { id: 'u1', roles: ['admin'] } });
    expect(result.ok).toBe(true);
    const confirmed = await inst.close();
    expect(confirmed).toBe(true);
    await backend.close();
  });
});
