import { describe, it, expect } from '../helpers/test.js';
import { buildDeploymentReport } from '../../src/cli/commands/doctor.js';
import type { EngineConfig } from '../../src/runtime/engine.js';
import type { DoctorCheck } from '../../src/cli/types/index.js';

const checks: DoctorCheck[] = [
  { name: 'connection', status: 'pass', detail: 'PostgreSQL 15.3' },
  { name: 'schema-drift', status: 'warn', detail: '1 object(s) drift' },
];

describe('buildDeploymentReport — redacted, local-only deployment profile', () => {
  it('derives a coarse, secret-free profile', () => {
    const config = {
      projectType: 'governance',
      auth: { oidc: { issuer: 'https://secret-idp.example.com' } },
      subsystems: { audit: { enabled: true, mode: 'transactional' }, script: { enabled: true } },
      evidence: { enabled: true },
      adapters: { rest: { enabled: true }, graphql: { enabled: true } },
      rls: { enforce: true },
      systemSchema: 'weavekit',
    } as unknown as EngineConfig;

    const profile = buildDeploymentReport({
      config,
      objectCount: 12,
      fieldCount: 140,
      workflowObjects: 2,
      postgresVersion: 150000,
      checks,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(profile.tool).toBe('weave doctor --report');
    expect(profile.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(profile.engine.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(profile.engine.contractVersion).toBe(2);
    expect(profile.runtime.postgresVersion).toBe(150000);
    expect(profile.projectType).toBe('governance');
    expect(profile.schema).toEqual({ objects: '6-20', fields: '51-200', workflowObjects: '1-5' });
    expect(profile.identity.mode).toBe('oidc');
    expect(profile.subsystems).toMatchObject({ audit: { mode: 'transactional' }, script: true, evidence: true, quotas: false, tools: false });
    expect(profile.adapters).toEqual({ rest: true, mcp: true, graphql: true, events: false });
    expect(profile.security).toEqual({ rlsEnforce: true, scope: false, systemSchema: true });
    expect(profile.checks).toEqual({ connection: 'pass', 'schema-drift': 'warn' });

    // redaction: nothing identifying leaks into the profile
    const json = JSON.stringify(profile);
    expect(json).not.toContain('secret-idp');
    expect(json).not.toContain('weavekit'); // the schema NAME is only a boolean flag
    expect(json).not.toContain('localhost');
  });

  it('defaults identity to none and buckets edge counts', () => {
    const profile = buildDeploymentReport({
      config: {} as EngineConfig,
      objectCount: 0,
      fieldCount: 3,
      workflowObjects: 0,
      checks: [],
    });
    expect(profile.identity.mode).toBe('none');
    expect(profile.schema).toEqual({ objects: '0', fields: '1-5', workflowObjects: '0' });
    expect(profile.runtime.postgresVersion).toBeUndefined();
    expect(profile.projectType).toBeUndefined();
  });
});
