#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

/**
 * Local PostgreSQL helper for the e2e suites — removes the manual
 * `docker run postgres`. Usage:
 *
 *   node scripts/test-db.mjs start   # ensure a container is running, print DATABASE_URL
 *   node scripts/test-db.mjs stop    # remove the container
 *   node scripts/test-db.mjs status  # print container status
 *
 * If DATABASE_URL is already set, `start` just echoes it (bring-your-own DB).
 */

const NAME = process.env.WK_TEST_PG_CONTAINER ?? 'weavekit-test-db';
const PORT = process.env.WK_TEST_PG_PORT ?? '5432';
const IMAGE = process.env.WK_TEST_PG_IMAGE ?? 'postgres:18-alpine';
const URL = `postgres://postgres:postgres@localhost:${PORT}/postgres`;

function docker(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8' }).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

const command = process.argv[2] ?? 'start';

if (command === 'start') {
  if (process.env.DATABASE_URL) {
    console.log(process.env.DATABASE_URL);
    process.exit(0);
  }
  const running = docker(['inspect', '-f', '{{.State.Running}}', NAME], { allowFailure: true });
  if (running === 'true') {
    console.log(URL);
    process.exit(0);
  }
  if (running === 'false') {
    docker(['start', NAME]);
  } else {
    docker([
      'run',
      '--name',
      NAME,
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-p',
      `${PORT}:5432`,
      '-d',
      IMAGE,
    ]);
  }
  process.stdout.write('waiting for postgres');
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 30; i += 1) {
    const ready = docker(['exec', NAME, 'pg_isready', '-U', 'postgres'], { allowFailure: true });
    if (ready.includes('accepting connections')) break;
    process.stdout.write('.');
    Atomics.wait(sleeper, 0, 0, 1000);
  }
  console.log(`\n${URL}`);
} else if (command === 'stop') {
  docker(['rm', '-f', NAME], { allowFailure: true });
  console.log(`removed ${NAME}`);
} else if (command === 'status') {
  console.log(docker(['ps', '-a', '--filter', `name=${NAME}`], { allowFailure: true }) || 'docker unavailable');
} else {
  console.error('usage: node scripts/test-db.mjs start|stop|status');
  process.exit(1);
}
