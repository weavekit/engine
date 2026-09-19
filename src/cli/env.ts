import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal `.env` loader for the `weave` CLI. Node does not auto-load `.env`
 * the way Bun did — the scaffolded project keeps `DATABASE_URL` there, so the
 * CLI loads it from the current working directory before running commands.
 * Existing `process.env` values win (never overwritten). Zero dependencies.
 */
export function loadEnvFile(dir: string): void {
  let content: string;
  try {
    content = readFileSync(join(dir, '.env'), 'utf8');
  } catch {
    return; // no .env — rely on real environment variables
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === '' || key in process.env) continue;
    process.env[key] = value;
  }
}
