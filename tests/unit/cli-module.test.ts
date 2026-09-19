import { describe, it, expect } from '../helpers/test.js';
import { setSubsystemEnabled } from '../../src/cli/commands/module.js';

const SCAFFOLD = `import type { EngineConfig } from '@weave-kit/engine';

export default {
  subsystems: {
    // sandbox hooks run in isolated workers (*.server.js)
    script: { enabled: true },
  },
  schemaDir: '.',
  auth: {
    source: {
      'sk-admin': { id: 'admin', roles: ['admin'] },
    },
  },
};
`;

const NO_SUBSYSTEMS = `import type { EngineConfig } from '@weave-kit/engine';

export default {
  schemaDir: '.',
  auth: {
    source: { 'sk-admin': { id: 'admin', roles: ['admin'] } },
  },
};
`;

describe('setSubsystemEnabled — weavekit.config.ts editing', () => {
  it('add: inserts entry into existing subsystems block', () => {
    const out = setSubsystemEnabled(SCAFFOLD, 'audit', true);
    expect(out).toContain('  subsystems: {\n    audit: { enabled: true },\n');
    expect(out).toContain('script: { enabled: true }');
  });

  it('add: already enabled → no change; disabled → toggled to enabled', () => {
    expect(setSubsystemEnabled(SCAFFOLD, 'script', true)).toBe(SCAFFOLD);
    const disabled = setSubsystemEnabled(SCAFFOLD, 'script', false)!;
    expect(disabled).toContain('script: { enabled: false }');
    expect(setSubsystemEnabled(disabled, 'script', true)!).toContain('script: { enabled: true }');
  });

  it('add: no subsystems block → inserts whole block', () => {
    const out = setSubsystemEnabled(NO_SUBSYSTEMS, 'audit', true);
    expect(out).toContain('export default {\n  subsystems: {\n    audit: { enabled: true },\n  },');
    expect(out).toContain('schemaDir');
  });

  it('remove: sets entry disabled; absent → returns unchanged', () => {
    const out = setSubsystemEnabled(SCAFFOLD, 'script', false);
    expect(out).toContain('script: { enabled: false }');
    expect(setSubsystemEnabled(SCAFFOLD, 'audit', false)).toBe(SCAFFOLD);
  });

  it('non-standard (no export default) → null', () => {
    expect(setSubsystemEnabled('const x = 1;', 'audit', true)).toBeNull();
  });
});
