import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, after, before } from '../helpers/test.js';import { scaffoldProject, PROJECT_TYPES } from '../../src/index.js';

const dirs: string[] = [];

async function scaffoldTo(type: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `wk-scaffold-${type}-`));
  dirs.push(dir);
  await scaffoldProject(dir, { type: type as never, git: false });
  return dir;
}

before(async () => {
  for (const type of Object.values(PROJECT_TYPES)) {
    await scaffoldTo(type);
  }
});

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('scaffoldProject — subsystems config for starter presets', () => {
  it('service → subsystems.script.enabled preset', async () => {
    const dir = dirs.find((d) => d.includes('service'))!;
    const config = await readFile(join(dir, 'weavekit.config.ts'), 'utf8');
    expect(config).toContain('script: { enabled: true }');
  });

  it('agent → no subsystems preset', async () => {
    const agent = await readFile(join(dirs.find((d) => d.includes('agent'))!, 'weavekit.config.ts'), 'utf8');
    expect(agent).not.toContain('subsystems');
  });

  it('governance → subsystems.audit transactional preset, no script', async () => {
    const governance = await readFile(join(dirs.find((d) => d.includes('governance'))!, 'weavekit.config.ts'), 'utf8');
    expect(governance).toContain("audit: { enabled: true, mode: 'transactional' }");
    expect(governance).not.toContain('script: { enabled: true }');
  });

  it('generated config shows the MCP prompts provider example (customer path)', async () => {
    const config = await readFile(join(dirs.find((d) => d.includes('agent'))!, 'weavekit.config.ts'), 'utf8');
    expect(config).toContain('prompts: {');
    expect(config).toContain('qualify_lead');
  });
});
