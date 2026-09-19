import kleur from 'kleur';
import type { CliPrinter } from './render.js';

/** one advertised endpoint on the value screen */
export interface ReadyEndpoint {
  label: string;
  url: string;
  note?: string;
}

/** the `weave dev` "value screen" — shown once on startup */
export interface ReadyScreen {
  projectType?: string;
  endpoints: ReadyEndpoint[];
  objects: string[];
  capabilities: { label: string; value: string }[];
  nextSteps: string[];
  /** true when the project has no objects yet (first-run guidance) */
  empty: boolean;
  /** the first statically-configured API key, when one exists (never a function/env secret) */
  apiKey?: string;
}

export interface ReadyScreenInput {
  port: number;
  projectType?: string;
  restEnabled: boolean;
  restPrefix: string;
  mcpEnabled: boolean;
  mcpEndpoint: string;
  eventsEnabled: boolean;
  eventsPrefix: string;
  objects: string[];
  audit: boolean;
  script: boolean;
  events: boolean;
  customTools: number;
  /** first statically-configured API key (undefined → placeholder) */
  apiKey?: string;
}

/**
 * Build the `weave dev` value screen from runtime facts. Pure (no I/O) so it is
 * unit-testable; `renderReadyScreen` handles the colored/human presentation.
 */
export function readyScreen(input: ReadyScreenInput): ReadyScreen {
  const base = `http://localhost:${input.port}`;

  const endpoints: ReadyEndpoint[] = [];
  if (input.restEnabled) endpoints.push({ label: 'REST', url: `${base}${input.restPrefix}`, note: 'objects' });
  if (input.mcpEnabled) endpoints.push({ label: 'MCP', url: `${base}${input.mcpEndpoint}`, note: 'tools for agents' });
  if (input.eventsEnabled) endpoints.push({ label: 'events', url: `${base}${input.eventsPrefix}/events`, note: 'live SSE' });

  const empty = input.objects.length === 0;
  const key = input.apiKey ?? '<your API key>';
  const nextSteps = empty
    ? [
        'Import an existing database:  weave introspect',
        'Or create one:                weave object:create <name>',
      ]
    : [
        `Try the API:      curl -H "Authorization: Bearer ${key}" ${base}${input.restPrefix}/objects/${input.objects[0]!}`,
        'Connect an agent: `weave mcp:config` (guide: docs/practices/connect-agent.md)',
        'Edit schema:      objects/<name>/schema.json — save to hot-reload',
      ];

  const screen: ReadyScreen = {
    endpoints,
    objects: input.objects,
    capabilities: [
      { label: 'audit', value: input.audit ? 'on' : 'off' },
      { label: 'script', value: input.script ? 'on' : 'off' },
      { label: 'events', value: input.events ? 'on' : 'off' },
      { label: 'custom tools', value: String(input.customTools) },
    ],
    nextSteps,
    empty,
  };
  if (input.projectType !== undefined) screen.projectType = input.projectType;
  if (input.apiKey !== undefined) screen.apiKey = input.apiKey;
  return screen;
}

/** render the value screen (human mode) or emit it as JSON (`--json`) */
export function renderReadyScreen(p: CliPrinter, screen: ReadyScreen): void {
  if (p.json) {
    p.data(screen);
    return;
  }
  p.log('');
  p.log(kleur.bold(`WeaveKit ready${screen.projectType !== undefined ? ` · ${screen.projectType}` : ''}`));
  for (const e of screen.endpoints) {
    const note = e.note === undefined ? '' : kleur.dim(`  ${e.note}`);
    p.log(`  ${kleur.dim(e.label.padEnd(7))} ${kleur.cyan(e.url)}${note}`);
  }
  p.log('');
  if (screen.empty) {
    p.log(kleur.yellow('  No objects yet.'));
  } else {
    p.log(`  ${screen.objects.length} object(s): ${screen.objects.join(', ')}`);
  }
  p.log(`  ${screen.capabilities.map((c) => `${c.label}: ${c.value}`).join('   ')}`);
  p.log('');
  p.log(kleur.bold('Next steps'));
  for (const step of screen.nextSteps) p.log(`  • ${step}`);
  p.log('');
}
