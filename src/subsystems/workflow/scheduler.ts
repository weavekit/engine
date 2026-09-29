import type {
  EngineWorkflowConfig,
  Locale,
  ObjectRegistry,
  ScriptDispatcher,
  WorkflowTimerSync,
} from '../../core/index.js';
import type { DataAccessContext, ObjectDataAccess } from '../../runtime/data-access/index.js';

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
 * Durable `onTimeout` scheduler.
 *
 * Phase C note: the timeout store is being rebuilt on the three-layer model
 * (instance/step/workitem) in C1/C2. Until then this is a no-op that satisfies
 * the {@link WorkflowTimerSync} seam, so the runtime compiles and never
 * mis-fires against the removed state field. The PG `WorkflowTimerStore` default
 * (`weavekit_workflow_timers`, `FOR UPDATE SKIP LOCKED`) is reused when rebased.
 */
export async function createWorkflowScheduler(
  options: WorkflowSchedulerOptions,
): Promise<WorkflowTimerScheduler> {
  void options;
  return {
    async sync(): Promise<void> {},
    async cancel(): Promise<void> {},
    async runOnce(): Promise<number> {
      return 0;
    },
    async close(): Promise<void> {},
  };
}
