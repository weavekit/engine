import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { SchemaError, transformScriptSource } from '../../../core/index.js';
import type { ScriptDispatchArgs, ScriptHook } from '../../../core/index.js';
import type { RpcExecutor, SandboxBackend, SandboxCallResult, SandboxEntry, SandboxInstance } from './types.js';

/**
 * `isolated-vm` sandbox backend (Node / V8 isolates).
 *
 * Isolation model:
 * - each `*.server.js` runs in its own worker thread hosting its own V8 isolate
 *   (`new ivm.Isolate({ memoryLimit })`) — real heap isolation, no host
 *   capability globals reachable (no require/process/fetch/Function escapes)
 * - `this.db` / `this.services` / `console` are **synchronous Callbacks** whose
 *   implementations bridge to the engine main process over a SharedArrayBuffer +
 *   `Atomics.wait/notify` message channel — the sandbox posts an RPC, the main
 *   process runs the async data-access/providers and replies, the sandbox
 *   resumes synchronously
 * - wall-clock timeout is enforced host-side (race → `worker.terminate()`); the
 *   isolate eval timeout additionally kills CPU-bound sync loops
 * - v7.0.1 resolves `evalClosure` with `undefined` for a promise that never
 *   settles, so hook completion is tracked with an in-isolate `__done` sentinel
 *   instead of the completion value alone — a hook still pending when evalClosure
 *   returns can never resolve (no timers/IO in the sandbox), so it is reported
 *   as a timeout and the sandbox is poisoned (lazily respawned on next call)
 *
 * The worker code is an inlined string (`eval: true`) with `isolated-vm`
 * resolved at runtime, so the backend works from source (tsx) and from the
 * compiled `dist`, and survives `weave build` bundling.
 */

const require = createRequire(import.meta.url);

/**
 * Resolve `isolated-vm` lazily — it is an **optional** dependency (a native
 * addon). Users without the script subsystem must be able to install and load
 * the engine; the missing-module error is only raised when the backend is
 * actually created, and the dispatcher turns it into an actionable message.
 */
let cachedIvmPath: string | undefined;
function resolveIvmPath(): string {
  if (cachedIvmPath !== undefined) return cachedIvmPath;
  try {
    cachedIvmPath = require.resolve('isolated-vm');
  } catch {
    throw new Error('isolated-vm is not installed (required by the script sandbox backend)');
  }
  return cachedIvmPath;
}

/** reply buffer size (JSON payloads, capped) */
const DATA_BYTES = 8 * 1024 * 1024;

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'closed' }
  | { type: 'initError'; error: string }
  | { type: 'rpc'; ns: string; method: string; args: unknown[]; user: { id: string; name?: string; roles: string[]; teamId?: string } }
  | { type: 'callResult'; id: number; ok: true; value: unknown }
  | { type: 'callResult'; id: number; ok: false; error: { message: string; code?: 'abort' | 'timeout' | 'sandbox' }; poisoned?: boolean };

const WORKER_CODE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const ivm = require(workerData.ivmPath);

const DATA_BYTES = workerData.dataBytes;
const sab = workerData.sab;
const genView = new Int32Array(sab, 0, 1);
const lenView = new Int32Array(sab, 4, 1);
const dataView = new Uint8Array(sab, 8, DATA_BYTES);
const td = new TextDecoder();
const te = new TextEncoder();
let currentUser = { id: 'system', roles: [], teamId: undefined as string | undefined };
let isolate, context, exportsRef;

function rpcSync(ns, method, args, user) {
  const gen = Atomics.load(genView, 0);
  parentPort.postMessage({ type: 'rpc', ns, method, args, user });
  const res = Atomics.wait(genView, 0, gen, workerData.queryTimeoutMs);
  if (res === 'timed-out') throw new Error('query timeout after ' + workerData.queryTimeoutMs + 'ms');
  const parsed = JSON.parse(td.decode(dataView.subarray(0, lenView[0])));
  if (parsed.ok) return parsed.value;
  const err = new Error(parsed.error);
  if (parsed.errorCode !== undefined) err.code = parsed.errorCode;
  throw err;
}

async function init() {
  isolate = new ivm.Isolate({ memoryLimit: workerData.memoryLimitMb });
  context = await isolate.createContext();
  await context.eval('globalThis.__exports = {}');
  exportsRef = await context.global.get('__exports', { reference: true });
  const rpcCb = new ivm.Callback((ns, method, args) => rpcSync(ns, method, args, currentUser));
  await context.global.set('__rpc', rpcCb);
  await context.eval(workerData.source, { timeout: workerData.timeoutMs });
}

async function callHook(hook, args) {
  currentUser = args.user;
  await context.evalClosure(
    'globalThis.__ctx = ({ record: $0, records: $5, changes: $1, user: $2, transition: $3, state: $4, ' +
    'db: { objects: (n) => ({ find: (o) => __rpc("objects","find",[n,"find",o]), ' +
    'findOne: (id) => __rpc("objects","findOne",[n,"findOne",id]), ' +
    'create: (d) => __rpc("objects","create",[n,"create",d]), ' +
    'update: (id, ch) => __rpc("objects","update",[n,"update",id,ch]), ' +
    'delete: (id) => __rpc("objects","delete",[n,"delete",id]) }), ' +
    'query: (sql, p) => __rpc("query","run",[sql,p]) }, ' +
    'services: { email: { send: (o) => __rpc("services","email.send",[o]) }, ' +
    'slack: { post: (o) => __rpc("services","slack.post",[o]) }, ' +
    'webhook: { call: (o) => __rpc("services","webhook.call",[o]) } }, ' +
    'console: { log: (...a) => __rpc("console","log",a.map(String)), ' +
    'warn: (...a) => __rpc("console","warn",a.map(String)), ' +
    'error: (...a) => __rpc("console","error",a.map(String)), ' +
    'info: (...a) => __rpc("console","info",a.map(String)) } })',
    [args.record, args.changes, args.user, args.transition === undefined ? null : args.transition, args.state === undefined ? null : args.state, args.records === undefined ? null : args.records],
    { arguments: { copy: true } },
  );
  const hookRef = await exportsRef.get(hook, { reference: true });
  // v7.0.1 returns a Reference even for missing properties — verify it is a function
  if (!hookRef || hookRef.typeof !== 'function') return { ok: false, error: { message: 'no hook: ' + hook } };
  try {
    // isolated-vm v7.0.1 resolves evalClosure with undefined for a promise that
    // never settles, so the completion value alone is ambiguous — record completion
    // inside the isolate and read the __done sentinel back
    await context.evalClosure(
      '(async () => { globalThis.__done = false; globalThis.__result = undefined; try { ' +
      'globalThis.__result = { ok: true, value: await __exports[$0].call(__ctx) }; } ' +
      'catch (e) { globalThis.__result = { ok: false, error: { message: String((e && e.message) || e), code: (e && e.code) || "abort" } }; } ' +
      'finally { globalThis.__done = true; } })()',
      [hook],
      { arguments: { copy: true }, result: { promise: true, copy: true }, timeout: workerData.timeoutMs },
    );
    const done = await context.global.get('__done', { copy: true });
    if (done !== true) {
      // the hook is logically still pending — this sandbox has no timers/IO, so
      // it can never resolve; poison the isolate and report a timeout (the host
      // tears the sandbox down and it respawns on the next call)
      return { ok: false, error: { message: 'script timed out (async hook did not settle)', code: 'timeout' }, poisoned: true };
    }
    const value = await context.global.get('__result', { copy: true });
    if (value !== undefined && typeof value === 'object' && value.ok === false) {
      const rawError = (value as { error?: { message?: string; code?: string } }).error;
      return { ok: false, error: { message: String(rawError?.message ?? 'script error'), code: (rawError?.code as 'abort' | 'timeout' | 'sandbox' | undefined) ?? 'abort' } };
    }
    return { ok: true, value: value !== undefined && typeof value === 'object' && value.ok === true ? value.value : value };
  } catch (e) {
    const m = String((e && e.message) || e);
    const timedOut = /timed out|timeout/i.test(m);
    return { ok: false, error: { message: m, code: timedOut ? 'timeout' : 'abort' } };
  }
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'shutdown') {
    try {
      await isolate.dispose();
    } catch {}
    // drop the message listener so the worker's event loop drains and the
    // thread exits — isolated-vm's background V8 threads are only released on
    // a clean isolate dispose, which worker.terminate() would otherwise leak
    parentPort.removeAllListeners();
    parentPort.postMessage({ type: 'closed' });
    return;
  }
  if (msg.type === 'init') {
    try {
      await init();
      parentPort.postMessage({ type: 'ready' });
    } catch (e) {
      parentPort.postMessage({ type: 'initError', error: String((e && e.message) || e) });
    }
    return;
  }
  if (msg.type === 'call') {
    try {
      const r = await callHook(msg.hook, msg.args);
      parentPort.postMessage({ type: 'callResult', id: msg.id, ...r });
    } catch (e) {
      parentPort.postMessage({ type: 'callResult', id: msg.id, ok: false, error: { message: String((e && e.message) || e) } });
    }
  }
});
`;

export interface IsolatedVmSandboxOptions {
  timeoutMs: number;
  queryTimeoutMs: number;
  memoryLimitMb: number;
}

class IsolatedVmSandboxInstance implements SandboxInstance {
  private worker: Worker | undefined;
  private ready: Promise<void> | undefined;
  private readonly pending = new Map<number, { resolve: (r: SandboxCallResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextCallId = 1;
  private closed = false;

  private readonly sab = new SharedArrayBuffer(8 + DATA_BYTES);
  private readonly genView = new Int32Array(this.sab, 0, 1);
  private readonly lenView = new Int32Array(this.sab, 4, 1);
  private readonly dataView = new Uint8Array(this.sab, 8, DATA_BYTES);

  constructor(
    private readonly entry: SandboxEntry,
    private readonly executor: RpcExecutor,
    private readonly opts: IsolatedVmSandboxOptions,
  ) {}

  private ensureReady(): Promise<void> {
    if (this.ready === undefined) {
      this.ready = this.spawn();
    }
    return this.ready;
  }

  private spawn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(WORKER_CODE, {
        eval: true,
        workerData: {
          source: transformScriptSource(this.entry.source),
          timeoutMs: this.opts.timeoutMs,
          queryTimeoutMs: this.opts.queryTimeoutMs,
          memoryLimitMb: this.opts.memoryLimitMb,
          dataBytes: DATA_BYTES,
          sab: this.sab,
          ivmPath: resolveIvmPath(),
        },
      });
      // the worker hosts a V8 isolate with background threads that would keep
      // the process alive after the sandbox is closed — decouple its lifetime
      // (calls are awaited explicitly, so the main event loop stays alive
      // while a hook runs)
      worker.unref();
      this.worker = worker;

      const onMessage = (message: WorkerMessage): void => {
        if (message.type === 'ready') {
          resolve();
          return;
        }
        if (message.type === 'initError') {
          this.destroy();
          reject(new SchemaError('script.compile', { file: `${this.entry.name}.server.js`, detail: message.error }));
          return;
        }
        if (message.type === 'rpc') {
          void this.handleRpc(message);
          return;
        }
        if (message.type === 'callResult') {
          const pending = this.pending.get(message.id);
          if (pending !== undefined) {
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            pending.resolve(message.ok ? { ok: true, value: message.value } : { ok: false, error: message.error });
          }
          if (!message.ok && message.poisoned) {
            // the hook left a never-settling promise behind — the isolate can
            // never resolve it, so tear the sandbox down (it respawns on demand)
            this.destroy();
          }
        }
      };
      worker.on('message', onMessage);
      worker.on('error', (error) => {
        this.destroy();
        reject(error);
      });
      worker.postMessage({ type: 'init' });
    });
  }

  private writeReply(payload: { ok: boolean; value?: unknown; error?: string; errorCode?: string }): void {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    if (bytes.length > DATA_BYTES) {
      throw new Error(`rpc reply exceeds ${DATA_BYTES} bytes`);
    }
    this.lenView[0] = bytes.length;
    this.dataView.set(bytes);
  }

  private async handleRpc(message: Extract<WorkerMessage, { type: 'rpc' }>): Promise<void> {
    try {
      const value = await this.executor(
        { ns: message.ns, method: message.method, args: message.args, user: message.user },
        this.opts.queryTimeoutMs,
      );
      this.writeReply({ ok: true, value });
    } catch (error) {
      // carry the engine SchemaError code across the RPC bridge so a script
      // hook can inspect `e.code` (e.g. rbac.denied) instead of parsing text
      this.writeReply({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: error instanceof SchemaError ? error.code : undefined,
      });
    }
    Atomics.add(this.genView, 0, 1);
    Atomics.notify(this.genView, 0, 1);
  }

  async call(hook: ScriptHook, args: ScriptDispatchArgs): Promise<SandboxCallResult> {
    await this.ensureReady();
    if (this.closed || this.worker === undefined) {
      return { ok: false, error: { message: 'sandbox is closed', code: 'sandbox' } };
    }
    const id = this.nextCallId++;
    return new Promise<SandboxCallResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { message: 'script timed out', code: 'timeout' } });
        void this.destroy();
      }, this.opts.timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.worker?.postMessage({ type: 'call', id, hook, args });
    });
  }

  private failAll(error: { message: string; code?: 'abort' | 'timeout' | 'sandbox' }): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error });
    }
    this.pending.clear();
  }

  /**
   * Ask the worker to dispose its isolate (releasing isolated-vm's background
   * V8 threads) and exit cleanly; `worker.terminate()` alone leaks those
   * threads and can keep the process alive. Returns `true` when the worker
   * acknowledged `closed` (isolate dispose confirmed); `false` when the
   * handshake timed out and we fell back to a forced terminate (release not
   * confirmed — caller should surface it).
   */
  private async gracefulShutdown(worker: Worker): Promise<boolean> {
    let confirmed = false;
    const closed = new Promise<void>((resolve) => {
      const onMessage = (message: WorkerMessage): void => {
        if (message.type === 'closed') {
          confirmed = true;
          worker.off('message', onMessage);
          resolve();
        }
      };
      worker.on('message', onMessage);
      setTimeout(() => {
        worker.off('message', onMessage);
        resolve();
      }, 1000);
    });
    try {
      worker.postMessage({ type: 'shutdown' });
    } catch {
      // worker already dead
    }
    await closed;
    worker.removeAllListeners();
    await worker.terminate().catch(() => {});
    return confirmed;
  }

  private destroy(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.ready = undefined;
    if (worker !== undefined) {
      worker.removeAllListeners();
      try {
        worker.postMessage({ type: 'shutdown' });
      } catch {
        // worker already dead
      }
      setTimeout(() => {
        void worker.terminate().catch(() => {});
      }, 100);
    }
    this.failAll({ message: 'sandbox destroyed', code: 'sandbox' });
  }

  async close(): Promise<boolean> {
    this.closed = true;
    this.failAll({ message: 'sandbox closed', code: 'sandbox' });
    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) {
      return this.gracefulShutdown(worker);
    }
    return true;
  }
}

export function createIsolatedVmSandboxBackend(options: IsolatedVmSandboxOptions): SandboxBackend {
  // fail fast when the optional native dependency is missing
  resolveIvmPath();
  return {
    create(entry: SandboxEntry, executor: RpcExecutor): SandboxInstance {
      return new IsolatedVmSandboxInstance(entry, executor, options);
    },
    async close() {},
  };
}
