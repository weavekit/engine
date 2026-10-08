import type {
  EngineWorkflowConfig,
  Locale,
  ObjectRegistry,
  ScriptDispatcher,
  WorkflowTimer,
  WorkflowTimerStore,
  WorkflowTimerSync,
} from '../../core/index.js';
import { SCRIPT_HOOKS, SYSTEM_CAPABILITIES, WORKFLOW_TIMER_DEFAULTS, parseDuration, systemPrincipal } from '../../core/index.js';
import type { DataAccessContext, ObjectDataAccess } from '../../runtime/data-access/index.js';
import { advanceOnTimeout } from '../../runtime/data-access/workflow.js';
import { createPgWorkflowTimerStore } from './store.js';

/** the engine's workflow scheduler handle (also the injected {@link WorkflowTimerSync}) */
export interface WorkflowTimerScheduler extends WorkflowTimerSync {
  /** process the currently due timers once (exposed for tests / one-shot use) */
  runOnce(now?: Date): Promise<number>;
  close(): Promise<void>;
}

export interface WorkflowSchedulerOptions {
  pool: DataAccessContext['pool'];
  registry: ObjectRegistry;
  /** the RBAC-decorated data-access used to fire auto-transitions (system, subject-less) */
  dataAccess: ObjectDataAccess;
  /** script dispatcher for the `onTimeout` hook; absent = no hook dispatch */
  script?: ScriptDispatcher;
  config?: EngineWorkflowConfig;
  locale?: Locale;
}

/**
 * Durable `onTimeout` scheduler. A record's timer is armed when it enters a node
 * with `onTimeout` and cancelled when it leaves; the poll loop claims due timers
 * (`FOR UPDATE SKIP LOCKED`) and dispatches the `onTimeout` hook plus the node's
 * declared auto-action (`approve`/`reject`, as the system actor). The store is
 * pluggable via `subsystems.workflow.backend`.
 */
export async function createWorkflowScheduler(
  options: WorkflowSchedulerOptions,
): Promise<WorkflowTimerScheduler> {
  const pollMs = options.config?.pollMs ?? WORKFLOW_TIMER_DEFAULTS.pollMs;
  const batchSize = options.config?.batchSize ?? WORKFLOW_TIMER_DEFAULTS.batchSize;
  const store: WorkflowTimerStore = options.config?.backend?.timerStore ?? createPgWorkflowTimerStore(options.pool);

  const timeoutOf = (object: string, nodeId: string) =>
    options.registry.get(object)?.workflow?.nodes.find((n) => n.id === nodeId)?.onTimeout;

  async function sync(object: string, id: string, nodeId: string): Promise<void> {
    const timeout = timeoutOf(object, nodeId);
    const ms = timeout === undefined ? undefined : parseDuration(timeout.after);
    if (ms === undefined || ms <= 0) {
      await store.cancel(object, id);
      return;
    }
    const hash = options.registry.get(object)?.workflowHash;
    await store.schedule({
      object,
      id,
      nodeId,
      dueAt: new Date(Date.now() + ms),
      ...(hash === undefined ? {} : { workflowHash: hash }),
    });
  }

  async function fire(timer: WorkflowTimer): Promise<void> {
    const entry = options.registry.get(timer.object);
    const timeout = entry?.workflow?.nodes.find((n) => n.id === timer.nodeId)?.onTimeout;
    if (entry === undefined || timeout === undefined) return;

    if (options.script !== undefined && options.script.has(timer.object, SCRIPT_HOOKS.ON_TIMEOUT)) {
      let record: Record<string, unknown> | null = null;
      try {
        record = await options.dataAccess.findOne<Record<string, unknown>>(timer.object, timer.id, {
          pool: options.pool,
          registry: options.registry,
          principal: systemPrincipal(SYSTEM_CAPABILITIES.WORKFLOW_TIMER, 'onTimeout hook read'),
          ...(options.locale === undefined ? {} : { locale: options.locale }),
        });
      } catch {
        record = null;
      }
      try {
        await options.script.dispatch(timer.object, SCRIPT_HOOKS.ON_TIMEOUT, {
          record,
          changes: {},
          user: { id: 'system', roles: [] },
          state: timer.nodeId,
        });
      } catch {
        // a failing timeout hook must not block the declared auto-action
      }
    }

    if (timeout.action === undefined) {
      await store.complete(timer);
      return;
    }
    const action = timeout.action;
    const client = await options.pool.connect();
    try {
      await client.query('BEGIN');
      const outcome = await advanceOnTimeout(client, entry, timer.id, timer.nodeId, action, options.locale);
      await client.query('COMMIT');
      if (outcome.nodeId !== undefined) await sync(timer.object, timer.id, outcome.nodeId);
      else await store.cancel(timer.object, timer.id);
    } catch {
      await client.query('ROLLBACK').catch(() => {});
    } finally {
      client.release();
    }
  }

  async function runOnce(now: Date = new Date()): Promise<number> {
    const due = await store.claimDue(batchSize, now);
    for (const timer of due) {
      try {
        await fire(timer);
      } catch {
        // drop a failing timer (stale record / invalid transition); never wedge the loop
        await store.complete(timer).catch(() => {});
      }
    }
    return due.length;
  }

  const timer = setInterval(() => {
    void runOnce().catch(() => {});
  }, pollMs);
  timer.unref?.();

  return {
    sync,
    cancel: (object, id) => store.cancel(object, id),
    runOnce,
    async close() {
      clearInterval(timer);
    },
  };
}
