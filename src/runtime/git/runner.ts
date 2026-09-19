import { execFile } from 'node:child_process';
import { SchemaError } from '../../core/index.js';
import type { Locale } from '../../core/index.js';

export interface GitResult {
  stdout: string;
  stderr: string;
  /** exit code; 0 on success */
  code: number;
}

export interface RunGitOptions {
  /** working directory for the git invocation */
  cwd: string;
  /** return the result instead of throwing on non-zero exit */
  allowFailure?: boolean;
  /** commit identity injected as `-c user.name=... -c user.email=...` */
  identity?: { name: string; email: string };
  locale?: Locale;
}

function execGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Run a git command. Cross-runtime (node:child_process works under Bun and
 * Node — the compatibility escape path; Bun.spawn is intentionally avoided).
 */
export async function runGit(args: string[], options: RunGitOptions): Promise<GitResult> {
  const identityArgs =
    options.identity === undefined
      ? args
      : ['-c', `user.name=${options.identity.name}`, '-c', `user.email=${options.identity.email}`, ...args];
  const result = await execGit(identityArgs, options.cwd);
  if (result.code !== 0 && !options.allowFailure) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new SchemaError('git.command.failed', { command: args.join(' '), detail }, options.locale);
  }
  return result;
}
