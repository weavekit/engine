import type { ScriptDispatchArgs, ScriptHook } from '../../../core/index.js';

/**
 * Sandbox backend contract — the pluggable isolation engine.
 *
 * `create()` spawns an isolated runtime for one `*.server.js` file and returns
 * a handle that executes hooks with a script-visible `this` (plain data +
 * RPC proxies). Today the backend is `node:worker_threads` (Bun-compatible,
 * Node escape path intact); a V8-isolate backend (e.g. isolated-vm) can be
 * swapped in later without touching the dispatcher.
 */

/** a data-access / service call the sandbox delegates to the engine main process */
export interface RpcRequest {
  /** 'objects' | 'services' | 'console' */
  ns: string;
  /** method name (e.g. 'find', 'email.send', 'log') */
  method: string;
  /** arguments after the object name (for 'objects': [objectName, method, ...args]) */
  args: unknown[];
  /** the script author (this.user) driving the call — rebuilt as an RbacSubject */
  user: { id: string; name?: string; roles: string[]; teamId?: string };
}

export type RpcExecutor = (req: RpcRequest, timeoutMs: number) => Promise<unknown>;

export interface SandboxCallResult {
  ok: boolean;
  /** resolved return value of the hook (structured-clone safe) */
  value?: unknown;
  /** thrown error, serialized to { message }; code distinguishes user-thrown vs sandbox failure */
  error?: { message: string; code?: 'abort' | 'timeout' | 'sandbox' };
}

export interface SandboxEntry {
  /** object name (also the worker/instance key) */
  name: string;
  /** raw source of the *.server.js file */
  source: string;
  /** hook names detected at load (drives fast-path registration) */
  hooks: ScriptHook[];
}

export interface SandboxInstance {
  /** run one hook; resolves when done, on timeout, or on sandbox crash */
  call(hook: ScriptHook, args: ScriptDispatchArgs): Promise<SandboxCallResult>;
  /**
   * Release the sandbox. Returns whether the shutdown handshake **confirmed**
   * a clean release (`true`) or fell back to a forced terminate on timeout
   * (`false` — the isolate release was not confirmed). `false` only happens on
   * a wedged worker; the dispatcher surfaces it as a warning.
   */
  close(): Promise<boolean>;
}

export interface SandboxBackend {
  create(entry: SandboxEntry, executor: RpcExecutor): SandboxInstance;
  close(): Promise<void>;
}
