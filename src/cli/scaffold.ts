import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { FIELD_TYPES, SCHEMA_FORMAT_VERSION } from '../core/index.js';
import { PRIMITIVE_FIELD_TYPES as PRIMITIVES, SEMANTIC_FIELD_TYPES as SEMANTICS } from '../core/types/registry.js';
import { runGit } from '../runtime/git/index.js';
import { version } from '../version.js';
import type { ProjectType } from './types/index.js';

/** project-type presets (starting subsystem composition + narrative); core is never trimmed */
const TYPE_NARRATIVES: Record<ProjectType, string> = {
  agent: 'AI-Agent backend: metadata-driven objects with REST access for AI agents',
  governance: 'Governance platform: auditable, permission-scoped business objects',
  service: 'Business service: headless backend with RBAC and a REST API',
  business: 'Business backend: objects and formulas on Postgres',
} satisfies Record<ProjectType, string>;

const LEADS_OBJECT = {
  schemaVersion: SCHEMA_FORMAT_VERSION,
  name: 'leads',
  label: 'Leads',
  fields: [
    { name: 'id', type: FIELD_TYPES.STRING, primary: true },
    { name: 'title', type: FIELD_TYPES.STRING, required: true },
    { name: 'status', type: FIELD_TYPES.ENUM, options: ['active', 'archived'] },
    // row-level ownership marker: read: "own" scopes queries to this field.
    // The field name is arbitrary — only the `ownership: true` flag matters.
    { name: 'owner_id', type: FIELD_TYPES.STRING, ownership: true },
    // team marker: read: "team" scopes queries to this field (sales_manager).
    { name: 'team_id', type: FIELD_TYPES.STRING, team: true },
    { name: 'company', type: FIELD_TYPES.STRING },
    { name: 'amount', type: FIELD_TYPES.CURRENCY },
    // sales cannot read this field; sales_manager can (fields.exclude strips on read).
    { name: 'source', type: FIELD_TYPES.STRING },
  ],
  permissions: {
    // roles are user-defined — they must match the keys in your schema's permissions.
    // update: true = all fields updatable, string[] = whitelist.
    admin: { read: 'all', create: true, update: true, delete: true },
    sales: {
      read: 'own',
      create: true,
      update: ['title', 'status'],
      delete: false,
      fields: { exclude: ['source'] },
    },
    sales_manager: {
      read: 'team',
      create: true,
      update: ['title', 'status'],
      delete: false,
      // no exclude → sales_manager sees `source` (only admin + managers can)
    },
  },
};

/** presets whose starting subsystem set includes the script sandbox */
const SCRIPT_TYPES = new Set<ProjectType>(['service', 'business']);

/** engine primitives — always enabled */
const BASE_FIELD_TYPES: readonly string[] = PRIMITIVES;

/** semantic types gated by `features.fieldTypes` */
const SEMANTIC_FIELD_TYPES: readonly string[] = SEMANTICS;

/** per-projectType default `features.fieldTypes` whitelist (config gating, fail-closed) */
const DEFAULT_FIELD_TYPES_BY_TYPE: Record<ProjectType, string[]> = {
  // pure API tooling, no UI — identity/avatar semantics unused; extend via config
  agent: [...BASE_FIELD_TYPES],
  // governance: backend members/teams (person/department) of the user's own system
  governance: [...BASE_FIELD_TYPES, ...SEMANTIC_FIELD_TYPES],
  service: [...BASE_FIELD_TYPES, ...SEMANTIC_FIELD_TYPES],
  business: [...BASE_FIELD_TYPES, ...SEMANTIC_FIELD_TYPES],
};

/** `features.fieldTypes` snippet for a project-type preset (undefined → no gating) */
function renderFeatures(type?: ProjectType): string {
  if (type === undefined) return '';
  const fieldTypes = DEFAULT_FIELD_TYPES_BY_TYPE[type];
  return `  features: {
    // field-type whitelist — a schema using a type outside this list is rejected
    fieldTypes: [${fieldTypes.map((t) => `'${t}'`).join(', ')}],
  },
`;
}

function renderConfig(type?: ProjectType): string {
  const narrative = type === undefined ? '' : `  // ${TYPE_NARRATIVES[type] ?? 'custom project'}\n`;
  const projectType = type === undefined ? '' : `  projectType: '${type}',\n`;
  const subsystems =
    type !== undefined && SCRIPT_TYPES.has(type)
      ? `  subsystems: {
    // sandbox hooks run in isolated workers (*.server.js)
    script: { enabled: true },
  },
`
      : '';
  const features = renderFeatures(type);
  return `import type { EngineConfig } from '@weave-kit/engine';\n
  // WeaveKit engine configuration.
${narrative}export default {
${projectType}${subsystems}${features}  schemaDir: '.',
  auth: {
    source: {
      // Replace with real keys; prefer env references:
      // process.env.WEAVEKIT_ADMIN_KEY ?? 'sk-admin'
      'sk-admin': { id: 'admin', roles: ['admin'] },
    },
  },
  adapters: {
    rest: { enabled: true, prefix: '/api' },
    // MCP endpoint /mcp is enabled by default; configure on-behalf-of identities
    // that agents may act as (RBAC decides each identity's tool surface).
    mcp: {
      identities: {
        // on-behalf-of identity directory: ref -> subject.
        // roles must match the permissions keys in your schema.json
        // (the leads object declares admin, sales and sales_manager).
        // alice: { id: 'u-alice', roles: ['sales'] },
      },
      guardrails: {
        rateLimit: { windowMs: 60_000, max: 100 },
        alerts: { channel: 'console' },
      },
    },
  },
} satisfies EngineConfig;
`;
}

const MAIN_ENTRY = `import { createEngine } from '@weave-kit/engine';\nimport config from './weavekit.config.js';\n
const engine = await createEngine(config);
const port = Number(process.env.PORT ?? 3000);
await engine.app.listen({ host: '0.0.0.0', port });
engine.app.log.info(\`weavekit engine listening on http://localhost:\${port}\`);

// graceful shutdown: flush audit buffer and release the pool on SIGTERM/SIGINT
const shutdown = async () => {
  // lifecycle.shutdown is emitted inside engine.close()
  await engine.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
`;

const GITIGNORE = `node_modules/\ndist/\n.env\n`;

const ENV_EXAMPLE = `# Copy to .env and fill in your PostgreSQL connection.\nDATABASE_URL=postgres://postgres:postgres@localhost:5432/weavekit\n# HTTP port the engine listens on (default 3000)\n# PORT=3000\n`;

function renderPackageJson(name: string): string {
  return JSON.stringify(
    {
      name,
      private: true,
      type: 'module',
      scripts: {
        dev: 'weave dev',
        migrate: 'weave migrate',
        build: 'weave build',
        test: 'weave test',
      },
      dependencies: { '@weave-kit/engine': `^${version}` },
    },
    null,
    2,
  );
}

function renderReadme(dir: string, type?: ProjectType): string {
  const line = type === undefined ? 'WeaveKit project' : `${type}: ${TYPE_NARRATIVES[type] ?? 'WeaveKit project'}`;
  const business =
    type === 'business'
      ? `\n> **Backend preset.** \`business\` currently scaffolds the headless engine only (REST/MCP/RBAC/audit/script) — no UI. Files such as \`objects/<name>/show.client.js\` and \`pages/<name>/layout.json\` are experimental groundwork for a future product line and have **no in-project renderer yet**.\n`
      : '';
  return `# ${basename(dir)}\n\n${line}\n${business}\n- \`weave dev\` — run with hot reload\n- \`weave migrate\` — sync schema to PostgreSQL\n- \`weave build\` — production bundle\n- \`weave test\` — run tests\nObjects live in \`objects/<name>/schema.json\`.\n`;
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd, allowFailure: true });
  return result.stdout.trim() === 'true';
}

export interface ScaffoldProjectOptions {
  /** starting-preset narrative; undefined = generic WeaveKit project */
  type?: ProjectType;
  /** overwrite existing files */
  force?: boolean;
  /** initialize a git repository (default true) when cwd is not already one */
  git?: boolean;
}

export interface ScaffoldProjectResult {
  /** files written (relative to cwd); `(overwritten)` marks force-replacements */
  created: string[];
  /** files skipped because they already exist (force=false) */
  skipped: string[];
  /** whether a git repo was initialized (cwd was not already a repo) */
  gitInit: boolean;
}

/** scaffold a WeaveKit project into `cwd`; shared by `create-weavekit-app` */
export async function scaffoldProject(cwd: string, options: ScaffoldProjectOptions = {}): Promise<ScaffoldProjectResult> {
  const files: Record<string, string> = {
    'weavekit.config.ts': renderConfig(options.type),
    'main.ts': MAIN_ENTRY,
    'package.json': renderPackageJson(basename(cwd)),
    '.gitignore': GITIGNORE,
    '.env.example': ENV_EXAMPLE,
    'README.md': renderReadme(cwd, options.type),
    [join('objects', 'leads', 'schema.json')]: `${JSON.stringify(LEADS_OBJECT, null, 2)}\n`,
  };

  const created: string[] = [];
  const skipped: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const full = join(cwd, rel);
    await mkdir(dirname(full), { recursive: true });
    try {
      await writeFile(full, content, { flag: 'wx' });
      created.push(rel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        if (options.force) {
          await writeFile(full, content);
          created.push(`${rel} (overwritten)`);
        } else {
          skipped.push(rel);
        }
      } else {
        throw error;
      }
    }
  }

  let gitInit = false;
  if ((options.git ?? true) && !(await isGitRepo(cwd))) {
    await runGit(['init'], { cwd });
    gitInit = true;
  }

  return { created, skipped, gitInit };
}
