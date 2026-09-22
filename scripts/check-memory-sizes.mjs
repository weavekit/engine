#!/usr/bin/env node
// Guard for the layered-memory system (T0/T1/T2) size budget.
// Enforced via root `prelint` (runs before `npm run lint`).
//   - AGENTS.md (auto-loaded):        file <= 6 KB, line width <= 200
//   - MEMORY/<topic>.md (on-demand):  file <= 10 KB, line width <= 200
// Keep the caps table in root AGENTS.md「记忆分层系统」in sync.
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENTS_CAP_KB = 6;
const MEMORY_CAP_KB = 10;
const LINE_CAP = 200;

const errors = [];

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function check(file) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const isAgents = rel === 'AGENTS.md' || rel.endsWith('/AGENTS.md');
  const isMemory = /(?:^|\/)MEMORY\//.test(rel) && rel.endsWith('.md');
  if (!isAgents && !isMemory) return;

  const kind = isAgents ? 'AGENTS' : 'MEMORY';
  const cap = isAgents ? AGENTS_CAP_KB : MEMORY_CAP_KB;
  const sizeKB = statSync(file).size / 1024;

  if (sizeKB > cap) {
    errors.push(`${kind} ${rel}: ${sizeKB.toFixed(1)}KB > ${cap}KB cap`);
  }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let inFence = false;
  lines.forEach((line, i) => {
    const trimmedStart = line.replace(/^\s+/, '');
    if (trimmedStart.startsWith('```')) {
      inFence = !inFence;
      return;
    }
    if (inFence) return; // preformatted content (trees/configs) can't be wrapped
    if (line.length > LINE_CAP) {
      errors.push(`${kind} ${rel}:${i + 1}: ${line.length} chars > ${LINE_CAP} (line width)`);
    }
  });
}

for (const file of walk(ROOT)) check(file);

if (errors.length > 0) {
  console.error('memory-size guard FAILED:');
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.log('memory-size guard OK (AGENTS <= 6KB, MEMORY <= 10KB, lines <= 200)');
