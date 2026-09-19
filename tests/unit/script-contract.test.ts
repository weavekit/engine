import { describe, it, expect } from '../helpers/test.js';import {
  NOOP_SCRIPT_DISPATCHER,
  SCRIPT_HOOKS,
} from '../../src/core/script/index.js';
import { mapSchemaError } from '../../src/core/api/index.js';
import { SchemaError } from '../../src/core/index.js';

describe('SCRIPT_HOOKS — single source of truth', () => {
  it('contains all 11 lifecycle hooks with no duplicate values', () => {
    const values = Object.values(SCRIPT_HOOKS);
    expect(values).toHaveLength(11);
    expect(new Set(values).size).toBe(11);
  });

  it('full write hook set in place (MVP wiring target)', () => {
    expect(SCRIPT_HOOKS.VALIDATE).toBe('validate');
    expect(SCRIPT_HOOKS.BEFORE_UPDATE).toBe('beforeUpdate');
    expect(SCRIPT_HOOKS.AFTER_UPDATE).toBe('afterUpdate');
    expect(SCRIPT_HOOKS.BEFORE_DELETE).toBe('beforeDelete');
    expect(SCRIPT_HOOKS.AFTER_DELETE).toBe('afterDelete');
  });

  it('workflow hooks defined (contract first, wiring later)', () => {
    expect(SCRIPT_HOOKS.BEFORE_TRANSITION).toBe('beforeTransition');
    expect(SCRIPT_HOOKS.AFTER_TRANSITION).toBe('afterTransition');
    expect(SCRIPT_HOOKS.ON_ENTER).toBe('onEnter');
    expect(SCRIPT_HOOKS.ON_EXIT).toBe('onExit');
    expect(SCRIPT_HOOKS.ON_TIMEOUT).toBe('onTimeout');
  });

  it('derived union type matches constants (no hardcoded second set of literals)', () => {
    const hook: (typeof SCRIPT_HOOKS)[keyof typeof SCRIPT_HOOKS] = SCRIPT_HOOKS.ON_LOAD;
    expect(hook).toBe('onLoad');
  });
});

describe('NOOP_SCRIPT_DISPATCHER — disabled = zero overhead', () => {
  it('has always false, dispatch returns empty warnings, close is a no-op', async () => {
    expect(NOOP_SCRIPT_DISPATCHER.has('lead', SCRIPT_HOOKS.VALIDATE)).toBe(false);
    const result = await NOOP_SCRIPT_DISPATCHER.dispatch('lead', SCRIPT_HOOKS.VALIDATE, {
      record: null,
      changes: {},
      user: { id: 'u1', roles: ['admin'] },
    });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toBeUndefined();
    await NOOP_SCRIPT_DISPATCHER.close();
  });
});

describe('mapSchemaError — script error mapping', () => {
  it('script.abort → 400, message passes through hook error', async () => {
    const err = new SchemaError('script.abort', { hook: 'validate', message: 'amount must be > 0' });
    const spec = mapSchemaError(err);
    expect(spec.status).toBe(400);
    expect(spec.body.error.code).toBe('script.abort');
    expect(spec.body.error.message).toContain('amount must be > 0');
  });

  it('script.timeout not listed → 500 (server failure, not client error)', async () => {
    const err = new SchemaError('script.timeout', { script: 'lead', timeout: 5000 });
    expect(mapSchemaError(err).status).toBe(500);
  });
});
