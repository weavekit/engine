import { SchemaError } from '../../core/index.js';
import type { Locale } from '../../core/index.js';
import { runGit } from './runner.js';
import type { GitResult } from './runner.js';

export interface AutoCommitOptions {
  /** project root containing `objects/**` */
  dir: string;
  /** paths (relative to dir) to stage; defaults to `['objects']` */
  paths?: string[];
  /** commit subject; defaults to `chore(metadata): sync schema objects` */
  message?: string;
  /** commit identity; falls back to a local weavekit identity when git has none configured */
  identity?: { name: string; email: string };
  locale?: Locale;
}

export interface AutoCommitResult {
  committed: boolean;
  /** commit sha, present when a commit was created */
  sha?: string;
}

export interface CommitPathsOptions {
  dir: string;
  /** working-tree paths (relative to dir) to commit as one unit */
  paths: string[];
  message: string;
  identity?: AutoCommitOptions['identity'];
  locale?: Locale;
}

export interface CommitPathOptions extends Omit<CommitPathsOptions, 'paths'> {
  path: string;
}

const DEFAULT_IDENTITY = { name: 'weavekit', email: 'support@weavekit.io' };

/** stage the metadata tree and commit it; no-op when nothing changed */
export async function autoCommit(options: AutoCommitOptions): Promise<AutoCommitResult> {
  const locale = options.locale;
  const paths = options.paths ?? ['objects'];

  const repo = await runGit(['rev-parse', '--is-inside-work-tree'], {
    cwd: options.dir,
    allowFailure: true,
    locale,
  });
  if (repo.stdout.trim() !== 'true') {
    throw new SchemaError('git.notRepo', { dir: options.dir }, locale);
  }

  const add = await runGit(['add', '--', ...paths], { cwd: options.dir, allowFailure: true, locale });
  if (add.code !== 0) {
    const detail = (add.stderr || add.stdout).trim();
    if (detail.includes('ignored by one of your .gitignore files')) {
      // metadata tree is git-ignored (e.g. project inside a larger repo) → nothing to commit
      return { committed: false };
    }
    throw new SchemaError('git.command.failed', { command: 'add', detail }, locale);
  }

  const staged = await runGit(['diff', '--cached', '--quiet'], { cwd: options.dir, allowFailure: true, locale });
  if (staged.code === 0) {
    return { committed: false };
  }

  const message = options.message ?? 'chore(metadata): sync schema objects';
  await commitWithIdentity(options.dir, message, options.identity, locale);

  const head = await runGit(['rev-parse', 'HEAD'], { cwd: options.dir, locale });
  return { committed: true, sha: head.stdout.trim() };
}

async function commitWithIdentity(
  dir: string,
  message: string,
  identity: AutoCommitOptions['identity'],
  locale?: Locale,
  trailingArgs: string[] = [],
): Promise<GitResult> {
  const args = ['commit', '-m', message, ...trailingArgs];
  try {
    return await runGit(args, { cwd: dir, identity, locale });
  } catch (error) {
    const detail = error instanceof SchemaError ? String(error.params.detail ?? '') : '';
    if (detail.includes('Please tell me who you are') || detail.includes('Author identity unknown')) {
      return runGit(args, { cwd: dir, identity: DEFAULT_IDENTITY, locale });
    }
    throw error;
  }
}

/** Commit one working-tree path while leaving unrelated staged changes intact. */
export async function commitPath(options: CommitPathOptions): Promise<AutoCommitResult> {
  return commitPaths({
    dir: options.dir,
    paths: [options.path],
    message: options.message,
    identity: options.identity,
    locale: options.locale,
  });
}

/**
 * Commit a set of working-tree paths as one unit while leaving unrelated
 * staged changes intact (`git commit --only -- <paths>`). Prior index entries
 * are captured and restored on failure — a failed commit leaves the index as
 * it was (callers are responsible for restoring working-tree file content).
 */
export async function commitPaths(options: CommitPathsOptions): Promise<AutoCommitResult> {
  const { dir, paths, message, identity, locale } = options;
  if (paths.length === 0) return { committed: false };
  const repo = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir, allowFailure: true, locale });
  if (repo.stdout.trim() !== 'true') {
    throw new SchemaError('git.notRepo', { dir }, locale);
  }

  const previousIndex = new Map<string, string>();
  for (const path of paths) {
    const entry = await runGit(['ls-files', '--stage', '--', path], { cwd: dir, locale });
    previousIndex.set(path, entry.stdout);
  }

  await runGit(['add', '--', ...paths], { cwd: dir, locale });
  const staged = await runGit(['diff', '--cached', '--quiet', '--', ...paths], { cwd: dir, allowFailure: true, locale });
  if (staged.code === 0) return { committed: false };

  try {
    await commitWithIdentity(dir, message, identity, locale, ['--only', '--', ...paths]);
  } catch (error) {
    for (const [path, entry] of previousIndex) {
      await restoreIndexEntry(dir, path, entry, locale);
    }
    throw error;
  }

  const head = await runGit(['rev-parse', 'HEAD'], { cwd: dir, locale });
  return { committed: true, sha: head.stdout.trim() };
}

async function restoreIndexEntry(dir: string, path: string, entry: string, locale?: Locale): Promise<void> {
  const fields = entry.trim().match(/^(\d+)\s+([0-9a-f]+)\s+\d+\t/);
  if (fields !== null) {
    await runGit(['update-index', '--cacheinfo', fields[1]!, fields[2]!, path], { cwd: dir, locale });
    return;
  }
  await runGit(['rm', '--cached', '--ignore-unmatch', '--', path], { cwd: dir, locale });
}
