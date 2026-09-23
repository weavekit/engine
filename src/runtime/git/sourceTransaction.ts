import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { SchemaError, type Locale } from '../../core/index.js';
import { commitPaths, type AutoCommitOptions } from './autoCommit.js';
import { isMissingFile, readSource, writeSourceAtomically } from './sourceFile.js';

/**
 * Multi-file source transaction: serialize all source writes per
 * project, version-check every candidate against its baseline, validate all
 * candidates BEFORE any write, then atomically replace targets and commit once.
 * Any failure leaves the working tree and index exactly as before.
 */

export interface SourceFileCandidate {
  /** working-tree path relative to projectDir */
  path: string;
  source: string;
  /** expected baseline version (sha256) — strict optimistic lock (409 when mismatched) */
  expectVersion?: string;
}

export interface SourceTransactionOptions {
  projectDir: string;
  files: SourceFileCandidate[];
  /** per-file content validation (runs for every candidate BEFORE any write) */
  validate?: (candidate: SourceFileCandidate) => void | Promise<void>;
  /** skip version checks (explicit overwrite) */
  force?: boolean;
  /** commit subject */
  message?: string;
  identity?: AutoCommitOptions['identity'];
  locale?: Locale;
}

export interface SourceTransactionResult {
  committed: boolean;
  sha?: string;
}

/** project-level serial mutation queue — git writes within a project must not interleave */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(dir) ?? Promise.resolve();
  const next = previous.then(task);
  queues.set(
    dir,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** run a source transaction on the project's serial queue */
export function runSourceTransaction(options: SourceTransactionOptions): Promise<SourceTransactionResult> {
  return enqueue(options.projectDir, () => sourceTransactionTask(options));
}

/** run an arbitrary (already-serialized-safe) task on the project's mutation queue */
export function runSerialized<T>(projectDir: string, task: () => Promise<T>): Promise<T> {
  return enqueue(projectDir, task);
}

export interface DeleteSourceOptions {
  projectDir: string;
  /** working-tree path relative to projectDir */
  path: string;
  message?: string;
  identity?: AutoCommitOptions['identity'];
  locale?: Locale;
}

/** delete one source file and commit the removal (serialized; restores on failure) */
export function deleteSourceFile(options: DeleteSourceOptions): Promise<SourceTransactionResult> {
  return enqueue(options.projectDir, () => deleteSourceTask(options));
}

async function deleteSourceTask(options: DeleteSourceOptions): Promise<SourceTransactionResult> {
  const { projectDir, path, message, identity, locale } = options;
  const baseline = await readSource(projectDir, path);
  if (baseline === null) {
    throw new SchemaError('http.notFound', {}, locale);
  }
  await rm(join(projectDir, path), { force: true });
  try {
    const commit = await commitPaths({
      dir: projectDir,
      paths: [path],
      message: message ?? 'chore(sources): delete file',
      identity,
      locale,
    });
    return { committed: commit.committed, sha: commit.sha };
  } catch (error) {
    await writeSourceAtomically(projectDir, path, baseline.source);
    throw error;
  }
}

export interface DeleteSourceDirOptions {
  projectDir: string;
  /** working-tree directory relative to projectDir */
  dir: string;
  message?: string;
  identity?: AutoCommitOptions['identity'];
  locale?: Locale;
}

/** delete a whole source directory (page dir) and commit the removal (serialized; restores on failure) */
export function deleteSourceDir(options: DeleteSourceDirOptions): Promise<SourceTransactionResult> {
  return enqueue(options.projectDir, () => deleteSourceDirTask(options));
}

async function listFilesRecursive(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return out;
    throw error;
  }
  for (const entry of entries) {
    const rel = join(base, entry.name).split(sep).join('/');
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

async function deleteSourceDirTask(options: DeleteSourceDirOptions): Promise<SourceTransactionResult> {
  const { projectDir, dir, message, identity, locale } = options;
  const files = await listFilesRecursive(join(projectDir, dir), dir);
  if (files.length === 0) {
    throw new SchemaError('http.notFound', {}, locale);
  }
  const baselines = new Map<string, { source: string; version: string }>();
  for (const file of files) {
    const baseline = await readSource(projectDir, file);
    if (baseline !== null) baselines.set(file, baseline);
  }
  await rm(join(projectDir, dir), { recursive: true, force: true });
  try {
    const commit = await commitPaths({
      dir: projectDir,
      paths: files,
      message: message ?? 'chore(sources): delete directory',
      identity,
      locale,
    });
    return { committed: commit.committed, sha: commit.sha };
  } catch (error) {
    for (const [file, baseline] of baselines) {
      await writeSourceAtomically(projectDir, file, baseline.source);
    }
    throw error;
  }
}

async function sourceTransactionTask(options: SourceTransactionOptions): Promise<SourceTransactionResult> {
  const { projectDir, files, validate, force, message, identity, locale } = options;
  if (files.length === 0) return { committed: false };

  // 1. read baselines + strict version checks (409 unless force)
  const baselines = new Map<string, { source: string; version: string } | null>();
  for (const file of files) {
    const baseline = await readSource(projectDir, file.path);
    baselines.set(file.path, baseline);
    if (force) continue;
    if (baseline === null) {
      // create — a versioned create is a conflict (client raced an existing file)
      if (file.expectVersion !== undefined) {
        throw new SchemaError('source.versionMismatch', { expectVersion: file.expectVersion, version: null }, locale);
      }
      continue;
    }
    if (file.expectVersion === undefined || baseline.version !== file.expectVersion) {
      throw new SchemaError(
        'source.versionMismatch',
        { expectVersion: file.expectVersion ?? null, version: baseline.version },
        locale,
      );
    }
  }

  // 2. validate every candidate BEFORE any write
  if (validate !== undefined) {
    for (const file of files) await validate(file);
  }

  // 3. write temps under `.weavekit/txn-<uuid>/`, then rename into place
  const tempDir = join(projectDir, '.weavekit', `txn-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });
  const tempPaths: Array<{ rel: string; temp: string }> = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const temp = join(tempDir, `${i}-${basename(file.path)}`);
      await writeFile(temp, file.source, 'utf8');
      tempPaths.push({ rel: file.path, temp });
    }
    for (const { rel, temp } of tempPaths) {
      await mkdir(dirname(join(projectDir, rel)), { recursive: true });
      await rename(temp, join(projectDir, rel));
    }

    // 4. one commit; restore working tree on failure (commitPaths restores the index)
    try {
      const commit = await commitPaths({
        dir: projectDir,
        paths: files.map((f) => f.path),
        message: message ?? 'chore(sources): update pages metadata',
        identity,
        locale,
      });
      return { committed: commit.committed, sha: commit.sha };
    } catch (error) {
      await restoreBaselines(projectDir, files, baselines);
      throw error;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function restoreBaselines(
  projectDir: string,
  files: SourceFileCandidate[],
  baselines: Map<string, { source: string; version: string } | null>,
): Promise<void> {
  for (const file of files) {
    const baseline = baselines.get(file.path);
    if (baseline == null) {
      await rm(join(projectDir, file.path), { force: true });
    } else {
      await writeSourceAtomically(projectDir, file.path, baseline.source);
    }
  }
}
