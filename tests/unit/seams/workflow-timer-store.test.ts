import { describe, it, expect } from '../../helpers/test.js';
import {
  ObjectRegistry,
  validateObject,
  type WorkflowTimer,
  type WorkflowTimerStore,
} from '../../../src/core/index.js';
import { createWorkflowScheduler } from '../../../src/subsystems/workflow/index.js';

/**
 * `WorkflowTimerStore` / `WorkflowBackend` seam contract: the scheduler drives
 * the store through schedule/cancel/claimDue/complete. An enterprise (E3) HA
 * timer backend is injected via `subsystems.workflow.backend.timerStore` and
 * must honour exactly these call semantics.
 */
describe('WorkflowTimerStore seam contract (scheduler-driven)', () => {
  it('arms on enter, cancels on leave, claims + completes due timers', async () => {
    const def = validateObject({
      name: 'lead',
      fields: [{ name: 'id', type: 'string', primary: true }],
      workflowEnabled: true,
      workflow: {
        nodes: [
          { id: 'review', assign: { roles: ['reviewer'] }, onTimeout: { after: '30m' } },
          { id: 'start', assign: { roles: ['reviewer'] } },
        ],
      },
    });
    const registry = new ObjectRegistry();
    registry.register(def);
    registry.buildGraph();

    const scheduled = new Map<string, WorkflowTimer>();
    const cancelled: string[] = [];
    const completed: WorkflowTimer[] = [];
    let due: WorkflowTimer[] = [];
    const timerStore: WorkflowTimerStore = {
      schedule: async (t) => {
        scheduled.set(`${t.object}:${t.id}`, t);
      },
      cancel: async (o, i) => {
        cancelled.push(`${o}:${i}`);
        scheduled.delete(`${o}:${i}`);
      },
      claimDue: async () => {
        const d = due;
        due = [];
        return d;
      },
      complete: async (t) => {
        completed.push(t);
      },
    };

    const before = Date.now();
    const scheduler = await createWorkflowScheduler({
      pool: {} as never,
      registry,
      dataAccess: {} as never,
      config: { backend: { timerStore }, pollMs: 3_600_000 },
    });
    try {
      // enter a node with onTimeout → schedule with the parsed duration
      await scheduler.sync('lead', 'r1', 'review');
      const armed = scheduled.get('lead:r1');
      expect(armed).toBeDefined();
      expect(armed!.nodeId).toBe('review');
      expect(armed!.dueAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000);

      // enter a node without onTimeout → cancel
      await scheduler.sync('lead', 'r1', 'start');
      expect(cancelled).toContain('lead:r1');

      // a due timer whose node has no auto-action → completed (idempotent finalize)
      due = [{ object: 'lead', id: 'r2', nodeId: 'review', dueAt: new Date() }];
      expect(await scheduler.runOnce()).toBe(1);
      expect(completed.map((t) => t.id)).toEqual(['r2']);
    } finally {
      await scheduler.close();
    }
  });
});
