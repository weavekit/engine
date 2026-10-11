import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry } from '../../src/core/object/registry.js';
import { getPrompt, listPrompts } from '../../src/adapters/mcp/index.js';
import type { McpEngine } from '../../src/adapters/mcp/types.js';
import type { McpSession } from '../../src/adapters/mcp/session.js';
import { BUILTIN_PROMPTS } from '../../src/core/index.js';
import type { IdentitySubject, ObjectDefinition, PromptsProvider } from '../../src/core/index.js';

const LEAD: ObjectDefinition = {
  name: 'lead',
  labels: { en: 'Lead' },
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
    { name: 'secret', type: 'string' },
  ],
  permissions: {
    sales: { read: 'all', fields: { exclude: ['secret'] } },
  },
};

const SECRET: ObjectDefinition = {
  name: 'secret_obj',
  fields: [{ name: 'id', type: 'string', primary: true }],
  permissions: { nobody: { read: 'all' } },
};

const DOC: ObjectDefinition = {
  name: 'wf_doc',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
  ],
  workflowEnabled: true,
  workflow: { nodes: [{ id: 'review', assign: { roles: ['approver'], mode: 'any' } }] },
  permissions: { sales: { read: 'all', update: true } },
};

function setup(defs: ObjectDefinition[], roles: string[]): { engine: McpEngine; session: McpSession } {
  const registry = new ObjectRegistry();
  for (const def of defs) registry.register(def);
  registry.buildGraph();
  const user: IdentitySubject = { id: 'u1', roles };
  const engine: McpEngine = { registry, pool: {} as never, dataAccess: {} as never, locale: 'en' };
  const session: McpSession = {
    id: 's1',
    agentCredentialId: 'key-1',
    agentSubject: { id: 'agent', roles: ['agent'] },
    user,
    onBehalfOf: 'alice',
    createdAt: new Date(),
    lastActivity: new Date(),
  };
  return { engine, session };
}

const PROVIDER: PromptsProvider = {
  list: () => [{ name: 'my_prompt', description: 'a business prompt' }, { name: BUILTIN_PROMPTS.EXPLORE }],
  get: (name) =>
    name === 'my_prompt'
      ? { messages: [{ role: 'user', content: { type: 'text', text: 'business hello' } }] }
      : null,
};

describe('MCP prompts — built-in, schema-derived, RBAC-filtered', () => {
  it('lists the built-in prompts', async () => {
    const { engine, session } = setup([LEAD], ['sales']);
    const names = (await listPrompts(engine, session)).map((p) => p.name);
    expect(names).toContain(BUILTIN_PROMPTS.EXPLORE);
    expect(names).toContain(BUILTIN_PROMPTS.OBJECT_GUIDE);
    expect(names).toContain(BUILTIN_PROMPTS.BUILD_FILTER);
  });

  it('lists run_workflow only when a readable object has a workflow', async () => {
    const withWf = setup([LEAD, DOC], ['sales']);
    expect((await listPrompts(withWf.engine, withWf.session)).map((p) => p.name)).toContain(BUILTIN_PROMPTS.RUN_WORKFLOW);
    const noWf = setup([LEAD], ['sales']);
    expect((await listPrompts(noWf.engine, noWf.session)).map((p) => p.name)).not.toContain(BUILTIN_PROMPTS.RUN_WORKFLOW);
  });

  it('lists no built-ins when the identity can read nothing', async () => {
    const { engine, session } = setup([SECRET], ['sales']);
    expect(await listPrompts(engine, session)).toEqual([]);
  });

  it('object_guide embeds the descriptor with excluded fields stripped', async () => {
    const { engine, session } = setup([LEAD], ['sales']);
    const result = await getPrompt(engine, session, BUILTIN_PROMPTS.OBJECT_GUIDE, { object: 'lead' }, 'en');
    const text = result.messages[0]!.content.text;
    expect(text).toContain('"name": "lead"');
    // the excluded field must not appear as a field entry (it may still be listed under permissions.excludedFields)
    expect(text).not.toContain('"name": "secret"');
  });

  it('object_guide without the required argument → prompt.args.invalid', async () => {
    const { engine, session } = setup([LEAD], ['sales']);
    await expect(getPrompt(engine, session, BUILTIN_PROMPTS.OBJECT_GUIDE, {}, 'en')).rejects.toThrow();
  });

  it('object_guide on an unknown object → error', async () => {
    const { engine, session } = setup([LEAD], ['sales']);
    await expect(getPrompt(engine, session, BUILTIN_PROMPTS.OBJECT_GUIDE, { object: 'nope' }, 'en')).rejects.toThrow();
  });

  it('object_guide on an unreadable object → error', async () => {
    const { engine, session } = setup([SECRET], ['sales']);
    await expect(
      getPrompt(engine, session, BUILTIN_PROMPTS.OBJECT_GUIDE, { object: 'secret_obj' }, 'en'),
    ).rejects.toThrow();
  });

  it('run_workflow renders the workflow; non-workflow object → error', async () => {
    const { engine, session } = setup([LEAD, DOC], ['sales']);
    const result = await getPrompt(engine, session, BUILTIN_PROMPTS.RUN_WORKFLOW, { object: 'wf_doc' }, 'en');
    expect(result.messages[0]!.content.text).toContain('review');
    await expect(getPrompt(engine, session, BUILTIN_PROMPTS.RUN_WORKFLOW, { object: 'lead' }, 'en')).rejects.toThrow();
  });

  it('an unknown prompt name → prompt.notFound', async () => {
    const { engine, session } = setup([LEAD], ['sales']);
    await expect(getPrompt(engine, session, 'nope', {}, 'en')).rejects.toThrow();
  });
});

describe('MCP prompts — host provider', () => {
  it('merges provider prompts and ignores reserved built-in names', async () => {
    const { engine, session } = setup([LEAD], ['sales']);
    const names = (await listPrompts(engine, session, { provider: PROVIDER })).map((p) => p.name);
    expect(names).toContain('my_prompt');
    expect(names.filter((n) => n === BUILTIN_PROMPTS.EXPLORE)).toHaveLength(1);
  });

  it('resolves a provider prompt, and falls back to notFound otherwise', async () => {
    const { engine, session } = setup([LEAD], ['sales']);
    const result = await getPrompt(engine, session, 'my_prompt', {}, 'en', { provider: PROVIDER });
    expect(result.messages[0]!.content.text).toBe('business hello');
    await expect(getPrompt(engine, session, 'other', {}, 'en', { provider: PROVIDER })).rejects.toThrow();
  });

  it('builtins:false exposes only the provider', async () => {
    const { engine, session } = setup([LEAD], ['sales']);
    const names = (await listPrompts(engine, session, { builtins: false, provider: PROVIDER })).map((p) => p.name);
    expect(names).toEqual(['my_prompt']);
    await expect(getPrompt(engine, session, BUILTIN_PROMPTS.EXPLORE, {}, 'en', { builtins: false, provider: PROVIDER })).rejects.toThrow();
  });
});
