#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * e2e runner — removes the manual `docker run postgres`.
 *
 * Resolution order for the test database:
 *   1. an already-set `DATABASE_URL` (env or `.env`) — bring your own DB
 *   2. otherwise start a throwaway PostgreSQL via `@testcontainers/postgresql`
 *   3. otherwise (no Docker) run anyway; the e2e suites self-skip
 *
 * The container is stopped when the test process exits (testcontainers' Ryuk
 * also reaps it if this process is killed).
 */

if (existsSync('.env')) {
  try {
    process.loadEnvFile('.env');
  } catch {
    // ignore a malformed .env — the child re-reads it best-effort too
  }
}

let container;
if (!process.env.DATABASE_URL) {
  try {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    console.log(`[test:e2e] started throwaway Postgres at ${process.env.DATABASE_URL}`);
  } catch (error) {
    console.warn(
      `[test:e2e] DATABASE_URL is unset and no Postgres container could be started (${String(
        error instanceof Error ? error.message : error,
      )}); e2e suites will self-skip`,
    );
  }
}

const args = [
  '--env-file-if-exists=.env',
  '--import',
  'tsx',
  '--test',
  '--test-concurrency=1',
  'tests/e2e/*.test.ts',
];
const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });

child.on('close', async (code) => {
  if (container !== undefined) await container.stop().catch(() => {});
  process.exit(code ?? 1);
});
child.on('error', async (error) => {
  console.error(error);
  if (container !== undefined) await container.stop().catch(() => {});
  process.exit(1);
});
