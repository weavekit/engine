import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SchemaError, type Locale } from '../../core/index.js';
import { commitPath, type AutoCommitOptions } from './autoCommit.js';
import { runGit } from './runner.js';
import { readSource, sourceVersion, writeSourceAtomically } from './sourceFile.js';

/**
 * Guardrail policy source management: a `policies/` directory holds one
 * `.js` module per guardrail policy (default-exporting a `GuardrailPolicy` or
 * an array). The engine loads them at startup (`resolvePolicies`); this module
 * exposes the same files as an admin-editable source surface (list / read /
 * write with atomic write + git commit), mirroring the script-source layer.
 */

export interface GuardrailPolicySummary {
  name: string;
  version: string;
}

export interface GuardrailPolicyDocument {
  source: string;
  version: string;
}

export interface WriteGuardrailPolicyOptions {
  source: string;
  identity?: AutoCommitOptions['identity'];
  locale?: Locale;
}

export interface WriteGuardrailPolicyResult extends GuardrailPolicyDocument {
  committed: boolean;
}

export interface GuardrailPolicyCommit {
  sha: string;
  author: string;
  email: string;
  date: string;
  message: string;
  /** source blob at this commit; null when the blob is unavailable (rename-predeces) */
  source: string | null;
  version: string | null;
}

export interface GuardrailPolicyHistory {
  name: string;
  commits: GuardrailPolicyCommit[];
}

const POLICY_FILE_EXTENSIONS = ['.js', '.mjs', '.cjs'];
const POLICY_NAME_PATTERN = /^[a-zA-Z0-9_-]+\.(js|mjs|cjs)$/;

/** validate a single policy file name (reject traversal / nested / non-ext) */
export function assertPolicyName(name: string, locale?: Locale): void {
  if (!POLICY_NAME_PATTERN.test(name) || name.startsWith('.')) {
    throw new SchemaError('http.param.invalid', { param: 'name', detail: name }, locale);
  }
}

function isPolicyFile(name: string): boolean {
  return POLICY_FILE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function isValidPolicyName(name: string): boolean {
  return POLICY_NAME_PATTERN.test(name) && !name.startsWith('.');
}

function policyDir(projectDir: string, policiesDir: string): string {
  return join(projectDir, policiesDir);
}

/** list policy files in the policies dir (name + sha256 version), sorted */
export async function listGuardrailPolicies(
  projectDir: string,
  policiesDir: string,
): Promise<GuardrailPolicySummary[]> {
  const dir = policyDir(projectDir, policiesDir);
  let isDir = false;
  try {
    isDir = (await stat(dir)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && isPolicyFile(entry.name) && isValidPolicyName(entry.name))
    .map((entry) => entry.name)
    .sort();
  const out: GuardrailPolicySummary[] = [];
  for (const name of files) {
    const document = await readGuardrailPolicy(projectDir, policiesDir, name);
    out.push({ name, version: document?.version ?? '' });
  }
  return out;
}

/** read one policy source (null when the file is missing) */
export async function readGuardrailPolicy(
  projectDir: string,
  policiesDir: string,
  name: string,
): Promise<GuardrailPolicyDocument | null> {
  assertPolicyName(name);
  const dir = policyDir(projectDir, policiesDir);
  const document = await readSource(dir, name);
  if (document === null) return null;
  return document;
}

/** validate a policy source parses as JS (esbuild transform) */
async function validatePolicySource(source: string, locale?: Locale): Promise<void> {
  try {
    const { transformSync } = await import('esbuild');
    transformSync(source, { loader: 'js', format: 'esm' });
  } catch (error) {
    throw new SchemaError(
      'http.param.invalid',
      { param: 'source', detail: error instanceof Error ? error.message : String(error) },
      locale,
    );
  }
}

/** write a policy source (atomic + git commit); no-op when unchanged */
export async function writeGuardrailPolicy(
  projectDir: string,
  policiesDir: string,
  name: string,
  options: WriteGuardrailPolicyOptions,
): Promise<WriteGuardrailPolicyResult> {
  assertPolicyName(name);
  const { source, identity, locale } = options;
  await validatePolicySource(source, locale);
  const dir = policyDir(projectDir, policiesDir);
  const previous = await readSource(dir, name);
  const version = sourceVersion(source);
  if (previous?.version === version) return { source, version, committed: false };

  await writeSourceAtomically(dir, name, source);
  try {
    const commit = await commitPath({
      dir: projectDir,
      path: join(policiesDir, name),
      message: `chore(policies): update ${name}`,
      identity,
      locale,
    });
    return { source, version, committed: commit.committed };
  } catch (error) {
    if (previous === null) {
      const { rm } = await import('node:fs/promises');
      await rm(join(dir, name), { force: true });
    } else {
      await writeSourceAtomically(dir, name, previous.source);
    }
    throw error;
  }
}

const HISTORY_FIELD_SEP = '\x1f';
const HISTORY_FORMAT = ['%H', '%an', '%ae', '%aI', '%s'].join(HISTORY_FIELD_SEP);

/**
 * Git history of a policy file: the commits that touched it (newest first) with
 * the source blob at each commit. Used by the admin history/diff surface. Empty
 * when the project is not a git work tree or the file has no history — never
 * throws, so a missing-git project degrades to a blank history.
 */
export async function listGuardrailHistory(
  projectDir: string,
  policiesDir: string,
  name: string,
): Promise<GuardrailPolicyHistory> {
  assertPolicyName(name);
  const rel = join(policiesDir, name).split('\\').join('/');
  const inRepo = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: projectDir, allowFailure: true });
  if (inRepo.stdout.trim() !== 'true') return { name, commits: [] };

  const log = await runGit(['log', '--follow', `--format=${HISTORY_FORMAT}`, '--', rel], {
    cwd: projectDir,
    allowFailure: true,
  });
  if (log.code !== 0) return { name, commits: [] };

  const commits: GuardrailPolicyCommit[] = [];
  for (const line of log.stdout.split('\n')) {
    if (line === '') continue;
    const [sha, author, email, date, ...rest] = line.split(HISTORY_FIELD_SEP);
    if (!sha) continue;
    const blob = await runGit(['show', `${sha}:${rel}`], { cwd: projectDir, allowFailure: true });
    const source = blob.code === 0 ? blob.stdout : null;
    commits.push({
      sha,
      author: author ?? '',
      email: email ?? '',
      date: date ?? '',
      message: rest.join(HISTORY_FIELD_SEP),
      source,
      version: source === null ? null : sourceVersion(source),
    });
  }
  return { name, commits };
}
