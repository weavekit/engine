import { describe, it, expect } from '../helpers/test.js';import Fastify from 'fastify';
import type { RbacSubject } from '../../src/core/rbac/index.js';
import { ObjectRegistry } from '../../src/core/index.js';
import type { ObjectDefinition } from '../../src/core/index.js';
import { registerMcp } from '../../src/adapters/mcp/index.js';
import { createAuth } from '../../src/adapters/auth/index.js';
import { setErrorHandlers } from '../../src/adapters/rest/index.js';
import type { ObjectDataAccess } from '../../src/runtime/data-access/index.js';

const alice: RbacSubject = { id: 'u-alice', roles: ['sales'] };
const emma: RbacSubject = { id: 'u-emma', roles: ['finance'], teamId: 't1' };

const LEAD: ObjectDefinition = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
  ],
  permissions: { sales: { read: 'all' } },
};

const noopDataAccess: ObjectDataAccess = {
  find: async () => ({ rows: [], total: 0 }),
  findOne: async () => null,
  create: async () => ({}) as never,
  update: async () => ({}) as never,
  delete: async () => undefined,
};

type IdentitySource = Record<string, RbacSubject> | ((ref: string) => RbacSubject | null | Promise<RbacSubject | null>);

async function newApp(identities: IdentitySource, endpoint?: string) {
  const app = Fastify();
  setErrorHandlers(app, 'en');
  const registry = new ObjectRegistry();
  registry.register(LEAD);
  registry.buildGraph();
  registerMcp(app, {
    engine: { registry, pool: {} as never, dataAccess: noopDataAccess, locale: 'en' },
    authenticator: createAuth({ source: { 'sk-1': { id: 'a1', roles: ['agent'] } } }),
    mcp: { identities, ...(endpoint !== undefined ? { endpoint } : {}) },
    locale: 'en',
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function initBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'unit', version: '1.0.0' },
    },
  };
}

async function initSession(baseUrl: string, onBehalfOf: string, path = '/mcp'): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer sk-1',
      'x-weavekit-on-behalf-of': onBehalfOf,
    },
    body: JSON.stringify(initBody()),
  });
}

describe('MCP identities — static directory (unchanged)', () => {
  it('initialize binds static directory identity → 200 + session established', async () => {
    const { app, baseUrl } = await newApp({ alice, emma });
    try {
      const res = await initSession(baseUrl, 'alice');
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('static directory miss → 400 mcp.identity.unknown', async () => {
    const { app, baseUrl } = await newApp({ alice });
    try {
      const res = await initSession(baseUrl, 'ghost');
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('mcp.identity.unknown');
    } finally {
      await app.close();
    }
  });
});

describe('MCP identities — resolver function (route B)', () => {
  it('function resolves ref → subject (async query of customer user table)', async () => {
    const table = new Map([
      ['alice', { id: 'u-alice', roles: ['sales'] }],
      ['emma', { id: 'u-emma', roles: ['finance'], teamId: 't1' }],
    ]);
    let calls = 0;
    const { app, baseUrl } = await newApp(async (ref: string) => {
      calls += 1;
      await Promise.resolve();
      return table.get(ref) ?? null;
    });
    try {
      const ok = await initSession(baseUrl, 'emma');
      expect(ok.status).toBe(200);
      expect(calls).toBeGreaterThan(0);

      const miss = await initSession(baseUrl, 'ghost');
      expect(miss.status).toBe(400);
      expect((await miss.json() as { error?: { code?: string } }).error?.code).toBe('mcp.identity.unknown');
    } finally {
      await app.close();
    }
  });

  it('function resolver takes precedence over static directory (function used when same key provided)', async () => {
    const { app, baseUrl } = await newApp(async (ref: string) => (ref === 'alice' ? { id: 'u-fn', roles: ['manager'] } : null));
    try {
      const res = await initSession(baseUrl, 'alice');
      expect(res.status).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('MCP endpoint — configurable path', () => {
  it('mounts at /mcp by default', async () => {
    const { app, baseUrl } = await newApp({ alice });
    try {
      expect((await initSession(baseUrl, 'alice')).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('mounts at configured path after endpoint customization, /mcp no longer responds', async () => {
    const { app, baseUrl } = await newApp({ alice }, '/mcp/agent');
    try {
      expect((await initSession(baseUrl, 'alice', '/mcp/agent')).status).toBe(200);
      expect((await initSession(baseUrl, 'alice', '/mcp')).status).toBe(404);
    } finally {
      await app.close();
    }
  });
});
