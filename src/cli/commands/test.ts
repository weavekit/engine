import { run } from '../exec.js';
import type { TestOptions } from '../types/index.js';

/** `weave test` — proxy `node --test` in the project directory */
export async function test(cwd: string, options: TestOptions): Promise<void> {
  const p = options.printer;
  // clear the test-runner marker so a nested `node --test` does not mistake
  // itself for a recursive invocation (skips running files otherwise)
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = await run(process.execPath, ['--test', ...options.args], cwd, env);
  if (result.stdout.trim().length > 0) p.log(result.stdout.trim());
  if (result.stderr.trim().length > 0) p.error(result.stderr.trim());
  if (result.code !== 0) process.exitCode = result.code;
}
