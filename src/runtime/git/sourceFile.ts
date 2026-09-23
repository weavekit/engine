import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Shared source-file primitives: sha256 versioning + atomic write via
 * the `.weavekit/` temp area. Used by script/layout/schema sources and the
 * multi-file source transaction so hashing and atomicity stay single-sourced.
 */

export function sourceVersion(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** read a source file under the project root → `{source, version}` or `null` (ENOENT) */
export async function readSource(
  projectDir: string,
  relPath: string,
): Promise<{ source: string; version: string } | null> {
  try {
    const source = await readFile(join(projectDir, relPath), 'utf8');
    return { source, version: sourceVersion(source) };
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/** atomic write via a `.weavekit/` temp file + rename (never a torn file on crash) */
export async function writeSourceAtomically(projectDir: string, relPath: string, source: string): Promise<void> {
  const target = join(projectDir, relPath);
  const temporaryDir = join(projectDir, '.weavekit');
  await mkdir(temporaryDir, { recursive: true });
  const temporaryPath = join(temporaryDir, `src-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, source, 'utf8');
    await rename(temporaryPath, target);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
