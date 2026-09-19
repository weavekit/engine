import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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

  it('business → subsystems.script.enabled preset', async () => {
    const dir = dirs.find((d) => d.includes('business'))!;
    const config = await readFile(join(dir, 'weavekit.config.ts'), 'utf8');
    expect(config).toContain('script: { enabled: true }');
  });

  it('agent / governance → script subsystem not preset', async () => {
    const agent = await readFile(join(dirs.find((d) => d.includes('agent'))!, 'weavekit.config.ts'), 'utf8');
    const governance = await readFile(join(dirs.find((d) => d.includes('governance'))!, 'weavekit.config.ts'), 'utf8');
    expect(agent).not.toContain('subsystems');
    expect(governance).not.toContain('subsystems');
  });

  it('business → Desk frontend no longer generated (Desk line frozen), README only describes the pure backend', async () => {
    const dir = dirs.find((d) => d.includes('business'))!;
    let hasFrontend = true;
    try {
      hasFrontend = (await stat(join(dir, 'frontend'))).isDirectory();
    } catch {
      hasFrontend = false;
    }
    expect(hasFrontend).toBe(false);

    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    const pkg = await readFile(join(dir, 'package.json'), 'utf8');
    expect(readme).not.toContain('@weave-kit/ui');
    expect(pkg).not.toContain('@weave-kit/ui');
    expect(readme).toContain('Backend preset');
  });
});
