import { describe, it, expect } from "../helpers/test.js";
import { encodeRecordKey } from '../../src/core/object/record-key.js';
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
    { name: "team_id", type: "string", [ROW_SCOPE_MARKERS.DEPARTMENT]: true },
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
    sales_manager: { read: "department", update: [], delete: false },
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
          "key-manager": { id: "u300", roles: ["sales_manager"], departmentId: "t1" },
          "key-finance": { id: "u400", roles: ["finance"] },
          "key-ghost": { id: "u500", roles: ["ghost_role"] },
        },
      },
    });
    const { app, pool, registry, dataAccess } = engine;
    const base = { pool, registry, principal: { kind: 'system' as const, capability: 'internal.admin' as const } };
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

      // 4b. total mode: `none` omits total; `estimate` returns a number; unknown → 400
      const aliceNone = await get("/api/objects/lead?limit=1&total=none", "key-sales-rep");
      expect(aliceNone.statusCode).toBe(200);
      const aliceNoneBody = aliceNone.json();
      expect("total" in aliceNoneBody).toBe(false);
      expect(aliceNoneBody.rows).toHaveLength(1);
      const aliceEstimate = await get("/api/objects/lead?total=estimate", "key-sales-rep");
      expect(aliceEstimate.statusCode).toBe(200);
      expect(typeof aliceEstimate.json().total).toBe("number");
      const badTotal = await get("/api/objects/lead?total=bogus", "key-sales-rep");
      expect(badTotal.statusCode).toBe(400);
      expect(badTotal.json().error.code).toBe("http.param.invalid");

      // 5. GET /:id denied (row outside own) → 404, does not leak existence
      const scopedOut = await get("/api/objects/lead/" + encodeRecordKey(["L2"]), "key-sales-rep");
      expect(scopedOut.statusCode).toBe(404);
      expect(scopedOut.json().error.code).toBe("data.recordNotFound");

      // 6. GET unknown object → 404 data.objectUnknown
      const unknownObj = await get("/api/objects/nope/" + encodeRecordKey(["L2"]), "key-sales-rep");
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
        url: "/api/objects/lead/" + encodeRecordKey(["L1"]),
        headers: bearer("key-sales-rep"),
        payload: { secret: "x" },
      });
      expect(patchSecret.statusCode).toBe(403);
      expect(patchSecret.json().error.code).toBe("rbac.denied.field");

      // 10. PATCH legal field (within whitelist)
      const patchName = await app.inject({
        method: "PATCH",
        url: "/api/objects/lead/" + encodeRecordKey(["L1"]),
        headers: bearer("key-sales-rep"),
        payload: { name: "Acme2" },
      });
      expect(patchName.statusCode).toBe(200);
      expect(patchName.json().name).toBe("Acme2");

      // 11. DELETE denied row → 404 (does not leak existence)
      const delScoped = await app.inject({
        method: "DELETE",
        url: "/api/objects/lead/" + encodeRecordKey(["L2"]),
        headers: bearer("key-sales-rep"),
      });
      expect(delScoped.statusCode).toBe(404);

      // 12. DELETE own row → 204
      const delOwn = await app.inject({
        method: "DELETE",
        url: "/api/objects/lead/" + encodeRecordKey(["L4"]),
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

      // 16. team row filtering (sales_manager, departmentId=t1)
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
});
