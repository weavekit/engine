import { describe, it, expect } from "../helpers/test.js";
import type { LightMyRequestResponse } from "fastify";
import {
  buildEngineFromRegistry,
  migrate,
  ObjectRegistry,
  ROW_SCOPE_MARKERS,
  runGit,
  type ObjectDefinition,
} from "../../src/index.js";

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const LEAD: ObjectDefinition = {
  name: "lead",
  fields: [
    { name: "id", type: "string", primary: true },
    { name: "name", type: "string" },
    { name: "status", type: "enum", options: ["open", "won", "lost"] },
    { name: "owner_id", type: "string", [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
    { name: "team_id", type: "string", [ROW_SCOPE_MARKERS.TEAM]: true },
    { name: "secret", type: "string" },
  ],
  permissions: {
    sales: {
      read: "own",
      create: true,
      update: ["name", "status"],
      delete: true,
      fields: { exclude: ["secret"] },
    },
    sales_manager: { read: "team", update: [], delete: false },
    finance: { read: "all", fields: { exclude: ["secret"] } },
  },
};

maybe("REST API E2E (local PG + fastify inject): auth + RBAC full path", () => {
  it("auth/authorization/row-level/field-level/pagination/unified errors", async () => {
    const registry0 = new ObjectRegistry();
    registry0.register(LEAD);
    registry0.buildGraph();
    const engine = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      auth: {
        source: {
          "key-sales-rep": { id: "u100", roles: ["sales"] },
          "key-manager": { id: "u300", roles: ["sales_manager"], teamId: "t1" },
          "key-finance": { id: "u400", roles: ["finance"] },
          "key-ghost": { id: "u500", roles: ["ghost_role"] },
        },
      },
    });
    const { app, pool, registry, dataAccess } = engine;
    const base = { pool, registry };
    const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

    try {
      await pool.query("DROP TABLE IF EXISTS lead, weavekit_meta CASCADE");
      await migrate(registry, { databaseUrl: url! });

      // seed (internal subject-less direct connection, freely set ownership)
      await dataAccess.create(
        "lead",
        {
          id: "L1",
          name: "Acme",
          status: "open",
          owner_id: "u100",
          team_id: "t1",
          secret: "s1",
        },
        base,
      );
      await dataAccess.create(
        "lead",
        {
          id: "L2",
          name: "Globex",
          status: "open",
          owner_id: "u200",
          team_id: "t1",
          secret: "s2",
        },
        base,
      );
      await dataAccess.create(
        "lead",
        {
          id: "L3",
          name: "Initech",
          status: "won",
          owner_id: "u100",
          team_id: "t2",
          secret: "s3",
        },
        base,
      );

      const get = (target: string, key?: string) =>
        app.inject({
          method: "GET",
          url: target,
          headers: key !== undefined ? bearer(key) : {},
        });

      // 1. no key → 401 auth.missingKey
      const noKey = await get("/api/objects/lead");
      expect(noKey.statusCode).toBe(401);
      expect(noKey.json().error.code).toBe("auth.missingKey");

      // 2. invalid key → 401 auth.invalidKey
      const badKey = await get("/api/objects/lead", "not-a-key");
      expect(badKey.statusCode).toBe(401);
      expect(badKey.json().error.code).toBe("auth.invalidKey");

      // 3. own row filtering + secret stripping + pagination envelope { rows, total, limit, offset }
      const alice = await get("/api/objects/lead?limit=1", "key-sales-rep");
      expect(alice.statusCode).toBe(200);
      const aliceBody = alice.json();
      expect(aliceBody.total).toBe(2);
      expect(aliceBody.limit).toBe(1);
      expect(aliceBody.offset).toBe(0);
      expect(aliceBody.rows).toHaveLength(1);
      expect(aliceBody.rows[0].owner_id).toBe("u100");
      expect("secret" in aliceBody.rows[0]).toBe(false);

      // 4. filter JSON + rowScope combination
      const aliceOpen = await get(
        `/api/objects/lead?filter=${encodeURIComponent('{"status":"open"}')}`,
        "key-sales-rep",
      );
      expect(aliceOpen.statusCode).toBe(200);
      const aliceOpenBody = aliceOpen.json();
      expect(aliceOpenBody.total).toBe(1);
      expect(aliceOpenBody.rows[0].id).toBe("L1");

      // 5. GET /:id denied (row outside own) → 404, does not leak existence
      const scopedOut = await get("/api/objects/lead/L2", "key-sales-rep");
      expect(scopedOut.statusCode).toBe(404);
      expect(scopedOut.json().error.code).toBe("data.recordNotFound");

      // 6. GET unknown object → 404 data.objectUnknown
      const unknownObj = await get("/api/objects/nope/L2", "key-sales-rep");
      expect(unknownObj.statusCode).toBe(404);
      expect(unknownObj.json().error.code).toBe("data.objectUnknown");

      // 7. unlisted role → 403 rbac.denied.read
      const ghost = await get("/api/objects/lead", "key-ghost");
      expect(ghost.statusCode).toBe(403);
      expect(ghost.json().error.code).toBe("rbac.denied.read");

      // 8. POST create (sales allowed → 201, returns stripped secret)
      const created = await app.inject({
        method: "POST",
        url: "/api/objects/lead",
        headers: bearer("key-sales-rep"),
        payload: {
          id: "L4",
          name: "Umbrella",
          status: "open",
          owner_id: "u100",
          team_id: "t1",
          secret: "s4",
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().name).toBe("Umbrella");
      expect("secret" in created.json()).toBe(false);

      // 9. PATCH forbidden field → 403 rbac.denied.field
      const patchSecret = await app.inject({
        method: "PATCH",
        url: "/api/objects/lead/L1",
        headers: bearer("key-sales-rep"),
        payload: { secret: "x" },
      });
      expect(patchSecret.statusCode).toBe(403);
      expect(patchSecret.json().error.code).toBe("rbac.denied.field");

      // 10. PATCH legal field (within whitelist)
      const patchName = await app.inject({
        method: "PATCH",
        url: "/api/objects/lead/L1",
        headers: bearer("key-sales-rep"),
        payload: { name: "Acme2" },
      });
      expect(patchName.statusCode).toBe(200);
      expect(patchName.json().name).toBe("Acme2");

      // 11. DELETE denied row → 404 (does not leak existence)
      const delScoped = await app.inject({
        method: "DELETE",
        url: "/api/objects/lead/L2",
        headers: bearer("key-sales-rep"),
      });
      expect(delScoped.statusCode).toBe(404);

      // 12. DELETE own row → 204
      const delOwn = await app.inject({
        method: "DELETE",
        url: "/api/objects/lead/L4",
        headers: bearer("key-sales-rep"),
      });
      expect(delOwn.statusCode).toBe(204);

      // 13. invalid filter JSON → 400 http.param.invalid
      const badFilter = await get(
        "/api/objects/lead?filter=%7Bbad",
        "key-sales-rep",
      );
      expect(badFilter.statusCode).toBe(400);
      expect(badFilter.json().error.code).toBe("http.param.invalid");

      // 14. body not an object → 400 http.param.invalid
      const badBody = await app.inject({
        method: "POST",
        url: "/api/objects/lead",
        headers: bearer("key-sales-rep"),
        payload: [1, 2],
      });
      expect(badBody.statusCode).toBe(400);
      expect(badBody.json().error.code).toBe("http.param.invalid");

      // 15. finance (read all + exclude) sees all rows with no secret
      const finance = await get("/api/objects/lead", "key-finance");
      expect(finance.statusCode).toBe(200);
      const finBody = finance.json();
      expect(finBody.total).toBe(3);
      expect(
        finBody.rows.every((r: Record<string, unknown>) => !("secret" in r)),
      ).toBe(true);

      // 16. team row filtering (sales_manager, teamId=t1)
      const manager = await get("/api/objects/lead", "key-manager");
      const mgrBody = manager.json();
      expect(mgrBody.total).toBe(2);
      expect(mgrBody.rows.map((r: { id: string }) => r.id).sort()).toEqual([
        "L1",
        "L2",
      ]);

      // 17. unknown route → 404 http.notFound (unified body)
      const notFound = await get("/api/nope", "key-sales-rep");
      expect(notFound.statusCode).toBe(404);
      expect(notFound.json().error.code).toBe("http.notFound");
    } finally {
      await pool.query("DROP TABLE IF EXISTS lead, weavekit_meta CASCADE");
      await engine.close();
    }
  }, 30000);

  it("object script source: GET/PUT {prefix}/objects/:name/scripts/:kind (unified read/write endpoint)", async () => {
    const { mkdtemp, mkdir, readFile, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "wk-rest-client-"));
    await mkdir(join(root, "pages", "lead"), { recursive: true });
    await writeFile(
      join(root, "pages", "lead", "show.client.js"),
      `export function onValidate() { return true; }\n`,
    );
    await writeFile(
      join(root, "pages", "lead", "list.client.js"),
      `export function onRowAction() { return ['delete']; }\n`,
    );
    await runGit(["init"], { cwd: root });
    await runGit(["config", "user.name", "Test"], { cwd: root });
    await runGit(["config", "user.email", "test@example.com"], { cwd: root });
    await runGit(["add", "-A"], { cwd: root });
    await runGit(["commit", "-m", "initial scripts"], { cwd: root });

    const registry0 = new ObjectRegistry();
    registry0.register(LEAD);
    registry0.buildGraph();
    const engine = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      schemaDir: root,
      auth: {
        source: {
          "key-sales-rep": { id: "u100", roles: ["sales"] },
          "key-admin": { id: "u-admin", roles: ["admin"] },
        },
      },
      adapters: { rest: { adminRoles: ["admin"] } },
    });
    const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
    try {
      const show = await engine.app.inject({
        method: "GET",
        url: "/api/objects/lead/scripts/show.client",
        headers: bearer("key-sales-rep"),
      });
      expect(show.statusCode).toBe(200);
      expect(show.json().source).toContain("export function onValidate()");
      expect(show.json().version).toMatch(/^[0-9a-f]{64}$/);

      const list = await engine.app.inject({
        method: "GET",
        url: "/api/objects/lead/scripts/list.client",
        headers: bearer("key-sales-rep"),
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().source).toContain("export function onRowAction()");

      const unauth = await engine.app.inject({
        method: "GET",
        url: "/api/objects/lead/scripts/show.client",
      });
      expect(unauth.statusCode).toBe(401);

      const unknown = await engine.app.inject({
        method: "GET",
        url: "/api/objects/nope/scripts/show.client",
        headers: bearer("key-sales-rep"),
      });
      expect(unknown.statusCode).toBe(404);

      const badKind = await engine.app.inject({
        method: "GET",
        url: "/api/objects/lead/scripts/other",
        headers: bearer("key-sales-rep"),
      });
      expect(badKind.statusCode).toBe(400);
      expect(badKind.json().error.code).toBe('http.param.invalid');

      const denied = await engine.app.inject({
        method: "GET",
        url: "/api/objects/lead/scripts/server",
        headers: bearer("key-sales-rep"),
      });
      expect(denied.statusCode).toBe(403);

      const missingServer = await engine.app.inject({
        method: "GET",
        url: "/api/objects/lead/scripts/server",
        headers: bearer("key-admin"),
      });
      expect(missingServer.statusCode).toBe(404);

      const serverSource = "export function validate() {}\n";
      const save = await engine.app.inject({
        method: "PUT",
        url: "/api/objects/lead/scripts/server",
        headers: bearer("key-admin"),
        payload: { source: serverSource, expectVersion: "reserved-marker" },
      });
      expect(save.statusCode).toBe(200);
      expect(save.json().ok).toBe(true);
      expect(save.json().committed).toBe(true);
      expect(await readFile(join(root, "objects", "lead", "server.js"), "utf8")).toBe(serverSource);
      expect((await runGit(["show", "--format=", "--name-only", "HEAD"], { cwd: root })).stdout.trim()).toBe(
        "objects/lead/server.js",
      );

      const invalidSource = await engine.app.inject({
        method: "PUT",
        url: "/api/objects/lead/scripts/list.client",
        headers: bearer("key-admin"),
        payload: { source: "export const broken = ;" },
      });
      expect(invalidSource.statusCode).toBe(400);
      expect(await readFile(join(root, "pages", "lead", "list.client.js"), "utf8")).toContain("onRowAction");

      const invalidEditorKind = await engine.app.inject({
        method: "PUT",
        url: "/api/objects/lead/scripts/other",
        headers: bearer("key-admin"),
        payload: { source: "" },
      });
      expect(invalidEditorKind.statusCode).toBe(400);
    } finally {
      await rm(root, { recursive: true, force: true });
      await engine.close();
    }
  }, 30000);

  it('pages/schema routes: path-mirrored addressing + custom CRUD + design atomic transaction + 409 + admin gate + route conflict', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { execFile } = await import('node:child_process');
    const root = await mkdtemp(join(tmpdir(), 'wk-rest-pages-'));
    const git = (args: string[]) =>
      new Promise<void>((resolve, reject) => execFile('git', args, { cwd: root }, (e) => (e ? reject(e) : resolve())));
    await git(['init']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'user.email', 'test@example.com']);

    await mkdir(join(root, 'pages', 'lead'), { recursive: true });
    await mkdir(join(root, 'objects', 'lead'), { recursive: true });
    await writeFile(
      join(root, 'pages', 'lead', 'show.layout.json'),
      JSON.stringify({
        viewports: {
          desktop: {
            mode: 'vertical',
            layout: [
              {
                ui_id: 's',
                type: 'fields',
                label: 'Main',
                children: [{ ui_id: 'g', type: 'grid', columns: [{ ui_id: 'gc', type: 'column', children: [{ ui_id: 'name', type: 'field', object: 'lead', field: 'name' }] }] }],
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(root, 'pages', 'lead', 'list.layout.json'),
      JSON.stringify({
        viewports: { desktop: { mode: 'vertical', layout: [{ ui_id: 'list', type: 'list', object: 'lead', columns: ['id', 'name', 'status'] }] } },
      }),
    );
    await writeFile(
      join(root, 'pages', 'app.layout.json'),
      JSON.stringify({
        viewports: {
          desktop: {
            mode: 'vertical',
            layout: [
              { ui_id: 'nav', type: 'sidebar', groups: [{ items: [{ label: 'Leads', page: { kind: 'object', id: 'lead' } }] }] },
              { ui_id: 'content', type: 'outlet', name: 'content' },
            ],
          },
        },
      }),
    );
    await writeFile(join(root, 'objects', 'lead', 'schema.json'), JSON.stringify(LEAD));
    await git(['add', '-A']);
    await git(['commit', '-m', 'initial']);

    const registry0 = new ObjectRegistry();
    registry0.register(LEAD);
    registry0.buildGraph();
    const engine = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      schemaDir: root,
      auth: {
        source: {
          'key-admin': { id: 'a1', roles: ['admin'] },
          'key-sales-rep': { id: 'u100', roles: ['sales'] },
        },
      },
      adapters: { rest: { adminRoles: ['admin'] } },
    });
    const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
    type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    const inject = (method: HttpMethod, u: string, key: string, payload?: unknown): Promise<LightMyRequestResponse> =>
      engine.app.inject({
        method,
        url: u,
        headers: bearer(key),
        payload: payload as Record<string, unknown> | undefined,
      });

    try {
      // catalog: shell + object show/list (authenticated, no admin)
      const catalog = await inject('GET', '/api/pages', 'key-sales-rep');
      expect(catalog.statusCode).toBe(200);
      const pages = JSON.parse(catalog.body) as Array<{ kind: string; path: string }>;
      expect(pages.some((p) => p.kind === 'shell' && p.path === 'app.layout')).toBe(true);
      expect(pages.some((p) => p.kind === 'object' && p.path === 'lead/show.layout')).toBe(true);
      expect(pages.some((p) => p.kind === 'object' && p.path === 'lead/list.layout')).toBe(true);

      // path-mirrored GET
      const shell = await inject('GET', '/api/pages/app.layout', 'key-sales-rep');
      expect(shell.statusCode).toBe(200);
      expect(shell.json().source).toContain('sidebar');
      const show = await inject('GET', '/api/pages/lead/show.layout', 'key-sales-rep');
      expect(show.statusCode).toBe(200);
      expect(show.json().version).toMatch(/^[0-9a-f]{64}$/);
      const list = await inject('GET', '/api/pages/lead/list.layout', 'key-sales-rep');
      expect(list.statusCode).toBe(200);
      expect(list.json().source).toContain('"type":"list"');
      // malformed path → 400; legacy flat custom path rejected → 400; missing custom → 404; unauth → 401
      expect((await inject('GET', '/api/pages/lead/foo.layout', 'key-sales-rep')).statusCode).toBe(400);
      expect((await inject('GET', '/api/pages/ghost.layout', 'key-sales-rep')).statusCode).toBe(400);
      expect((await inject('GET', '/api/pages/ghost/layout', 'key-sales-rep')).statusCode).toBe(404);
      expect((await engine.app.inject({ method: 'GET', url: '/api/pages/app.layout' })).statusCode).toBe(401);

      // PUT: non-admin 403, stale expectVersion 409, valid → commits
      expect(
        (
          await inject('PUT', '/api/pages/lead/show.layout', 'key-sales-rep', {
            source: '{"viewports":{}}',
          })
        ).statusCode,
      ).toBe(403);
      const stale = await inject('PUT', '/api/pages/lead/show.layout', 'key-admin', {
        source: JSON.stringify({ viewports: { desktop: { mode: 'vertical', layout: [] } } }),
        expectVersion: '0'.repeat(64),
      });
      expect(stale.statusCode).toBe(409);
      const put = await inject('PUT', '/api/pages/lead/show.layout', 'key-admin', {
        source: JSON.stringify({ viewports: { desktop: { mode: 'vertical', layout: [] } } }),
        expectVersion: show.json().version,
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().committed).toBe(true);

      // POST /pages create custom page; duplicate → 409
      const created = await inject('POST', '/api/pages', 'key-admin', { id: 'dash' });
      expect(created.statusCode).toBe(200);
      expect(created.json().path).toBe('dash/layout');
      expect((await inject('POST', '/api/pages', 'key-admin', { id: 'dash' })).statusCode).toBe(409);

      // page × object face scripts: list.client + show.client on `<page>/objects/<object>` (admin write, auth read)
      const faceScript = '/api/pages/dash/objects/lead/scripts/list.client';
      const listPut = await inject('PUT', faceScript, 'key-admin', { source: 'export function onLoad() { return 1; }' });
      expect(listPut.statusCode).toBe(200);
      expect(listPut.json().committed).toBe(true);
      const listGet = await inject('GET', faceScript, 'key-sales-rep');
      expect(listGet.statusCode).toBe(200);
      expect(listGet.json().source).toContain('onLoad');
      expect(listGet.json().version).toMatch(/^[0-9a-f]{64}$/);
      expect((await inject('GET', '/api/pages/dash/objects/missing/scripts/list.client', 'key-sales-rep')).statusCode).toBe(404);
      expect((await inject('PUT', faceScript, 'key-sales-rep', { source: 'export {}' })).statusCode).toBe(403);
      expect((await inject('DELETE', faceScript, 'key-admin')).statusCode).toBe(200);
      expect((await inject('GET', faceScript, 'key-sales-rep')).statusCode).toBe(404);

      const showScript = '/api/pages/dash/objects/lead/scripts/show.client';
      const showPut = await inject('PUT', showScript, 'key-admin', { source: 'export function onFieldChange() {}' });
      expect(showPut.statusCode).toBe(200);
      const showGet = await inject('GET', showScript, 'key-sales-rep');
      expect(showGet.statusCode).toBe(200);
      expect(showGet.json().source).toContain('onFieldChange');
      expect((await inject('PUT', showScript, 'key-admin', { source: 'not valid esm (' })).statusCode).toBe(400);
      expect((await inject('DELETE', showScript, 'key-admin')).statusCode).toBe(200);

      // page × object face layout: show.layout (the Design action target)
      const faceLayout = '/api/pages/dash/objects/lead/show.layout';
      const faceLayoutPut = await inject('PUT', faceLayout, 'key-admin', {
        source: JSON.stringify({
          viewports: {
            desktop: {
              mode: 'vertical',
              layout: [
                {
                  ui_id: 'f',
                  type: 'fields',
                  label: 'F',
                  children: [
                    {
                      ui_id: 'g',
                      type: 'grid',
                      columns: [
                        { ui_id: 'gc', type: 'column', children: [{ ui_id: 'n', type: 'field', object: 'lead', field: 'name' }] },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        }),
      });
      expect(faceLayoutPut.statusCode).toBe(200);
      const faceLayoutGet = await inject('GET', faceLayout, 'key-sales-rep');
      expect(faceLayoutGet.statusCode).toBe(200);
      expect(faceLayoutGet.json().source).toContain('"type":"fields"');
      expect((await inject('PUT', faceLayout, 'key-admin', { source: '{"viewports":{"desktop":{"mode":"vertical","layout":[{"ui_id":"l","type":"list","object":"lead"}]}}}' })).statusCode).toBe(400); // list not allowed on a show face
      expect((await inject('DELETE', faceLayout, 'key-admin')).statusCode).toBe(200);

      // schema: admin-only GET/PUT + route-conflict safety (schema wins over findOne)
      expect((await inject('GET', '/api/objects/lead/schema', 'key-sales-rep')).statusCode).toBe(403);
      const schemaDoc = await inject('GET', '/api/objects/lead/schema', 'key-admin');
      expect(schemaDoc.statusCode).toBe(200);
      expect(schemaDoc.json().source).toContain('"name":"lead"');

      // atomic design transaction: show + schema in one commit (strict versions)
      const currentShow = await inject('GET', '/api/pages/lead/show.layout', 'key-admin');
      const design = await inject('PUT', '/api/pages/lead/design', 'key-admin', {
        show: {
          source: JSON.stringify({
            viewports: {
              desktop: {
                mode: 'vertical',
                layout: [
                  {
                    ui_id: 's',
                    type: 'fields',
                    label: 'New',
                    children: [
                      {
                        ui_id: 'g',
                        type: 'grid',
                        columns: [
                          { ui_id: 'gc', type: 'column', children: [{ ui_id: 'status', type: 'field', object: 'lead', field: 'status' }] },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          }),
          expectVersion: currentShow.json().version,
        },
        schema: {
          source: JSON.stringify({ name: 'lead', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }] }),
          expectVersion: schemaDoc.json().version,
        },
      });
      expect(design.statusCode).toBe(200);
      expect(design.json().committed).toBe(true);

      // rename custom page updates the shell PageRef atomically
      const shellDoc = await inject('GET', '/api/pages/app.layout', 'key-admin');
      const shellWithDash = JSON.stringify({
        viewports: {
          desktop: {
            mode: 'vertical',
            layout: [
              {
                ui_id: 'nav',
                type: 'sidebar',
                groups: [
                  { items: [{ label: 'Leads', page: { kind: 'object', id: 'lead' } }] },
                  { items: [{ label: 'Dash', page: { kind: 'custom', id: 'dash' } }] },
                ],
              },
              { ui_id: 'content', type: 'outlet', name: 'content' },
            ],
          },
        },
      });
      const shellPut = await inject('PUT', '/api/pages/app.layout', 'key-admin', {
        source: shellWithDash,
        expectVersion: shellDoc.json().version,
      });
      expect(shellPut.statusCode).toBe(200);
      expect(shellPut.json().committed).toBe(true);
      const renamed = await inject('PATCH', '/api/pages/dash', 'key-admin', { newId: 'dash2' });
      expect(renamed.statusCode).toBe(200);
      const shellAfter = (await inject('GET', '/api/pages/app.layout', 'key-sales-rep')).json().source;
      expect(shellAfter).toContain('"id": "dash2"');

      // delete is blocked while a shell reference exists (409 + refs), then allowed
      const blocked = await inject('DELETE', '/api/pages/dash2', 'key-admin');
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error.code).toBe('page.ref.inUse');
      const shellClean = JSON.stringify({
        viewports: {
          desktop: {
            mode: 'vertical',
            layout: [
              {
                ui_id: 'nav',
                type: 'sidebar',
                groups: [{ items: [{ label: 'Leads', page: { kind: 'object', id: 'lead' } }] }],
              },
              { ui_id: 'content', type: 'outlet', name: 'content' },
            ],
          },
        },
      });
      await inject('PUT', '/api/pages/app.layout', 'key-admin', {
        source: shellClean,
        expectVersion: (await inject('GET', '/api/pages/app.layout', 'key-admin')).json().version,
      });
      expect((await inject('DELETE', '/api/pages/dash2', 'key-admin')).statusCode).toBe(200);
    } finally {
      await rm(root, { recursive: true, force: true });
      await engine.close();
    }
  }, 60000);
});
