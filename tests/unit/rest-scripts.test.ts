import Fastify from 'fastify';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from '../../src/adapters/auth/index.js';
import { setErrorHandlers } from '../../src/adapters/rest/index.js';
import { registerScriptRoutes } from '../../src/adapters/rest/scripts.js';
import { DEFAULT_LOCALE, ObjectRegistry } from '../../src/core/index.js';
import { runGit } from '../../src/runtime/git/index.js';
import { describe, expect, it } from '../helpers/test.js';

async function fixture(): Promise<{ root: string; registry: ObjectRegistry }> {
  const root = await mkdtemp(join(tmpdir(), 'wk-rest-scripts-'));
  await mkdir(join(root, 'pages', 'lead'), { recursive: true });
  await writeFile(join(root, 'pages', 'lead', 'show.client.js'), 'export function onValidate() { return true; }\n');
  await runGit(['init'], { cwd: root });
  await runGit(['config', 'user.name', 'Test'], { cwd: root });
  await runGit(['config', 'user.email', 'test@example.com'], { cwd: root });
  await runGit(['add', 'pages'], { cwd: root });
  await runGit(['commit', '-m', 'initial'], { cwd: root });
  const registry = new ObjectRegistry();
  registry.register({ name: 'lead', fields: [{ name: 'id', type: 'string', primary: true }] });
  registry.buildGraph();
  return { root, registry };
}

describe('REST script source routes', () => {
  it('serves client hooks to authenticated users and gates server reads and all writes by adminRoles', async () => {
    const { root, registry } = await fixture();
    const app = Fastify();
    setErrorHandlers(app, DEFAULT_LOCALE);
    registerScriptRoutes(
      app,
      {
        registry,
        authenticator: createAuth({
          source: {
            user: { id: 'u1', roles: ['user'] },
            admin: { id: 'a1', roles: ['admin'] },
          },
        }),
        locale: DEFAULT_LOCALE,
        projectDir: root,
      },
      { adminRoles: ['admin'] },
    );
    const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
    try {
      const removedLegacyRoute = await app.inject({
        method: 'GET',
        url: '/api/scripts/lead/client.js?kind=show',
        headers: bearer('user'),
      });
      expect(removedLegacyRoute.statusCode).toBe(404);

      const runtime = await app.inject({
        method: 'GET',
        url: '/api/objects/lead/scripts/show.client',
        headers: bearer('user'),
      });
      expect(runtime.statusCode).toBe(200);
      expect(runtime.json().source).toContain('onValidate');
      expect(runtime.json().version).toMatch(/^[0-9a-f]{64}$/);

      const denied = await app.inject({
        method: 'GET',
        url: '/api/objects/lead/scripts/server',
        headers: bearer('user'),
      });
      expect(denied.statusCode).toBe(403);

      const deniedWrite = await app.inject({
        method: 'PUT',
        url: '/api/objects/lead/scripts/show.client',
        headers: bearer('user'),
        payload: { source: 'export function onValidate() { return false; }' },
      });
      expect(deniedWrite.statusCode).toBe(403);

      const read = await app.inject({
        method: 'GET',
        url: '/api/objects/lead/scripts/show.client',
        headers: bearer('admin'),
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().version).toMatch(/^[0-9a-f]{64}$/);

      const missing = await app.inject({
        method: 'GET',
        url: '/api/objects/lead/scripts/server',
        headers: bearer('admin'),
      });
      expect(missing.statusCode).toBe(404);

      const source = 'export function validate() {}\n';
      const save = await app.inject({
        method: 'PUT',
        url: '/api/objects/lead/scripts/server',
        headers: bearer('admin'),
        payload: { source, expectVersion: 'reserved' },
      });
      expect(save.statusCode).toBe(200);
      expect(save.json().committed).toBe(true);
      expect(await readFile(join(root, 'objects', 'lead', 'server.js'), 'utf8')).toBe(source);

      const invalid = await app.inject({
        method: 'PUT',
        url: '/api/objects/lead/scripts/server',
        headers: bearer('admin'),
        payload: { source: 'export function validate(value) {}' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(await readFile(join(root, 'objects', 'lead', 'server.js'), 'utf8')).toBe(source);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails editor access closed when adminRoles is absent', async () => {
    const { root, registry } = await fixture();
    const app = Fastify();
    setErrorHandlers(app, DEFAULT_LOCALE);
    registerScriptRoutes(
      app,
      {
        registry,
        authenticator: createAuth({ source: { admin: { id: 'a1', roles: ['admin'] } } }),
        locale: DEFAULT_LOCALE,
        projectDir: root,
      },
    );
    try {
      const clientSource = await app.inject({
        method: 'GET',
        url: '/api/objects/lead/scripts/show.client',
        headers: { authorization: 'Bearer admin' },
      });
      expect(clientSource.statusCode).toBe(200);

      const serverSource = await app.inject({
        method: 'GET',
        url: '/api/objects/lead/scripts/server',
        headers: { authorization: 'Bearer admin' },
      });
      expect(serverSource.statusCode).toBe(403);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});