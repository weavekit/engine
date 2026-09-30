#!/usr/bin/env node
// Docs guard: relative `.md` links inside `docs/` (and the root `AGENTS.md`) must
// resolve, and every docs page must be reachable from `docs/README.md`.
// Enforced via `prelint` (runs before `npm run lint`).
//
// The web sync rewrites these links for the docs site; this keeps the in-repo
// tree (GitHub, editors) honest after renames/moves.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const INDEX = 'docs/README.md';
const EXTRA = ['AGENTS.md'];

const errors = [];

/** every `.md` under docs/, as repo-relative posix paths */
function collect(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) collect(full, out);
    else if (ent.isFile() && ent.name.endsWith('.md')) {
      out.push(relative(ROOT, full).split(sep).join('/'));
    }
  }
  return out;
}

/** links in a markdown file, skipping fenced code blocks */
function linksIn(text) {
  const out = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const re = /\]\(([^()\s]+?)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(line)) !== null) out.push(m[1]);
  }
  return out;
}

const docsFiles = collect(DOCS);
const scanned = [...docsFiles, ...EXTRA].filter((f) => existsSync(join(ROOT, f)));
const edges = new Map();

for (const file of scanned) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const targets = new Set();
  for (const raw of linksIn(text)) {
    const target = raw.split('#')[0];
    if (target === '' || !target.endsWith('.md')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue; // external/absolute
    const resolved = posix.normalize(posix.join(posix.dirname(file), target));
    if (resolved.startsWith('..')) continue; // outside the repo
    const abs = join(ROOT, resolved);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      errors.push(`${file}: broken link -> ${raw}`);
      continue;
    }
    targets.add(resolved);
  }
  edges.set(file, targets);
}

// reachability from the docs index (docs pages only)
const seen = new Set([INDEX]);
const queue = [INDEX];
while (queue.length > 0) {
  const cur = queue.shift();
  for (const next of edges.get(cur) ?? []) {
    if (next.startsWith('docs/') && !seen.has(next)) {
      seen.add(next);
      queue.push(next);
    }
  }
}
for (const file of docsFiles) {
  if (!seen.has(file)) errors.push(`${file}: not reachable from ${INDEX}`);
}

if (errors.length > 0) {
  console.error('docs-link guard FAILED:');
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.log(`docs-link guard OK (${docsFiles.length} pages, all reachable from ${INDEX})`);
