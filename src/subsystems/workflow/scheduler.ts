import type {
  EngineWorkflowConfig,
  Locale,
  ObjectRegistry,
  ScriptDispatcher,
  WorkflowTimer,
  WorkflowTimerStore,
  WorkflowTimerSync,
} from '../../core/index.js';
import {
  SCRIPT_HOOKS,
  WORKFLOW_TIMER_DEFAULTS,
  parseDuration,
} from '../../core/index.js';
import type { DataAccessContext, ObjectDataAccess } from '../../runtime/data-access/index.js';
import { createPgWorkflowTimerStore, ensureWorkflowTimersTable } from './store.js';

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
 * Durable `onTimeout` scheduler. A record's timer is armed when it enters a state
 * with `onTimeout` and cancelled when it leaves; the poll loop claims due timers
 * (`FOR UPDATE SKIP LOCKED`) and dispatches the `onTimeout` hook plus any declared
 * auto-transition. The store is pluggable via `subsystems.workflow.backend`.
 */
export async function createWorkflowScheduler(
  options: WorkflowSchedulerOptions,
): Promise<WorkflowTimerScheduler> {
  const pollMs = options.config?.pollMs ?? WORKFLOW_TIMER_DEFAULTS.pollMs;
  const batchSize = options.config?.batchSize ?? WORKFLOW_TIMER_DEFAULTS.batchSize;

  let store: WorkflowTimerStore;
  if (options.config?.backend !== undefined) {
    store = options.config.backend.timerStore;
  } else {
    await ensureWorkflowTimersTable(options.pool);
    store = createPgWorkflowTimerStore(options.pool);
  }

  const base: DataAccessContext = {
    pool: options.pool,
    registry: options.registry,
    ...(options.locale === undefined ? {} : { locale: options.locale }),
  };

  /** the state's declared timeout, or undefined */
  function timeoutOf(object: string, state: string) {
    return options.registry.get(object)?.workflow?.states.find((s) => s.name === state)?.onTimeout;
  }

  async function sync(object: string, id: string, state: string): Promise<void> {
    const timeout = timeoutOf(object, state);
    const ms = timeout === undefined ? undefined : parseDuration(timeout.after);
    if (ms === undefined) {
      await store.cancel(object, id);
      return;
    }
    await store.schedule({ object, id, state, dueAt: new Date(Date.now() + ms) });
  }

  async function fire(timer: WorkflowTimer): Promise<void> {
    const wf = options.registry.get(timer.object)?.workflow;
    if (wf === undefined) return;
    const record = await options.dataAccess.findOne<Record<string, unknown>>(timer.object, timer.id, base);
    if (record === null) return;
    const current = record[wf.stateField];
    // stale timer: the record has already left this state
    if (typeof current !== 'string' || current !== timer.state) return;
    const timeout = timeoutOf(timer.object, timer.state);
    if (timeout === undefined) return;

    if (options.script !== undefined && options.script.has(timer.object, SCRIPT_HOOKS.ON_TIMEOUT)) {
      try {
        await options.script.dispatch(timer.object, SCRIPT_HOOKS.ON_TIMEOUT, {
          record,
          changes: {},
          user: { id: 'system', roles: [] },
          state: timer.state,
        });
      } catch {
        // a failing timeout hook must not block the declared auto-transition
      }
    }

    if (timeout.action !== undefined) {
      // the transition re-arms/cancels the timer for the target state via `WorkflowTimerSync`
      await options.dataAccess.transition(timer.object, timer.id, timeout.action, base);
    } else {
      await store.complete(timer);
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
