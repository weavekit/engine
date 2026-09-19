import { describe, it, expect } from "../helpers/test.js";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPool, scaffoldProject } from "../../src/index.js";

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
// compiled CLI (dist) — spawns are real `node` processes without a per-spawn
// tsx transpile of the whole engine. `npm test` builds dist first (the linked
// @weave-kit/engine module the scaffolded project bundles already needs dist).
const CLI_PATH = join(REPO_ROOT, "dist", "cli", "index.js");
const PROJECT_DIR = join(REPO_ROOT, ".tmp", "weavekit-project");

const API_KEY = "sk-admin";

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Remove the shared project dir, retrying briefly: a test that timed out may
 * leave a spawned CLI child holding files in it, so the first `rm` can hit
 * EBUSY on Windows. Retries give lingering one-shot children time to exit.
 */
async function rmProjectDir(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(PROJECT_DIR, { recursive: true, force: true });
      return;
    } catch {
      await sleep(1000);
    }
  }
  await rm(PROJECT_DIR, { recursive: true, force: true });
}

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CLI_PATH, ...args],
      {
        cwd: PROJECT_DIR,
        env: { ...process.env, DATABASE_URL: url!, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
    child.on("error", (error) =>
      resolveRun({ code: 1, stdout, stderr: error.message }),
    );
  });
}

function gitIn(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn("git", args, {
      cwd: PROJECT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
    child.on("error", (error) =>
      resolveRun({ code: 1, stdout, stderr: error.message }),
    );
  });
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 60000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(500);
  }
  return false;
}

/** simulate `bun install` inside the scaffolded project: link @weave-kit/engine from the workspace */
async function linkEngineModule(): Promise<void> {
  const scoped = join(PROJECT_DIR, "node_modules", "@weave-kit");
  await mkdir(scoped, { recursive: true });
  try {
    await symlink(
      REPO_ROOT,
      join(scoped, "engine"),
      "junction",
    );
  } catch {
    // already linked
  }
}

async function tableExists(table: string): Promise<boolean> {
  const pool = createPool(url!);
  try {
    const result = await pool.query("SELECT to_regclass($1) AS t", [table]);
    return result.rows[0]?.t !== null;
  } finally {
    await pool.end();
  }
}

const LEADS_V2 = JSON.stringify(
  {
    name: "leads",
    label: "Leads",
    fields: [
      { name: "id", type: "string", primary: true },
      { name: "title", type: "string", required: true },
      { name: "status", type: "enum", options: ["active", "archived"] },
      { name: "note", type: "string" },
    ],
  },
  null,
  2,
);

/** label-only change — no DDL; exercises dev hot-reload without touching tables */
const LEADS_V3 = JSON.stringify(
  {
    name: "leads",
    label: "Leads Relabeled",
    fields: [
      { name: "id", type: "string", primary: true },
      { name: "title", type: "string", required: true },
      { name: "status", type: "enum", options: ["active", "archived"] },
    ],
  },
  null,
  2,
);

const SAMPLE_TEST = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n`;

maybe("CLI weave E2E (spawn + local PG + .tmp/weavekit-project)", () => {
  it("scaffold → migrate(--dry-run/json) → migrate → build → test", async () => {
    await rmProjectDir();
    await mkdir(PROJECT_DIR, { recursive: true });
    const pool = createPool(url!);
    try {
      await pool.query(
        "DROP TABLE IF EXISTS leads, weavekit_metadata, weavekit_meta CASCADE",
      );
      const init = await scaffoldProject(PROJECT_DIR);
      await linkEngineModule();
      for (const file of [
        "weavekit.config.ts",
        "main.ts",
        "package.json",
        ".gitignore",
        ".env.example",
      ]) {
        expect(init.created).toContain(file);
      }
      expect(init.created).toContain(join("objects", "leads", "schema.json"));
      expect(
        await readFile(join(PROJECT_DIR, "weavekit.config.ts"), "utf8"),
      ).toContain("schemaDir");

      // leads object closes the RBAC loop: permissions with admin/sales/sales_manager + ownership/team markers
      const leadsSchema = await readFile(
        join(PROJECT_DIR, "objects", "leads", "schema.json"),
        "utf8",
      );
      expect(leadsSchema).toContain('"permissions"');
      expect(leadsSchema).toContain('"sales"');
      expect(leadsSchema).toContain('"sales_manager"');
      expect(leadsSchema).toContain('"owner_id"');
      expect(leadsSchema).toContain('"team_id"');
      expect(leadsSchema).toContain('"source"');

      const dry = await runCli(["migrate", "--dry-run", "--json"]);
      expect(dry.code).toBe(0);
      const dryJson = JSON.parse(dry.stdout) as {
        objects: string[];
        dryRun: boolean;
        statements: string[];
      };
      expect(dryJson.objects).toEqual(["leads"]);
      expect(dryJson.dryRun).toBe(true);
      expect(dryJson.statements.length).toBeGreaterThan(0);
      expect(await tableExists("leads")).toBe(false);

      const mig = await runCli(["migrate", "--json"]);
      expect(mig.code).toBe(0);
      expect(await tableExists("leads")).toBe(true);

      await writeFile(
        join(PROJECT_DIR, "objects", "leads", "schema.json"),
        LEADS_V2,
      );
      // existing table without adding field: engine does not ALTER existing tables — migrate rejects
      const mig2 = await runCli(["migrate", "--json"]);
      expect(mig2.code).not.toBe(0);
      expect(mig2.stdout + mig2.stderr).toContain(
        'field "note" does not exist as a column',
      );

      const typesRes = await runCli(["types", "--json"]);
      expect(typesRes.code).toBe(0);
      const typesJson = JSON.parse(typesRes.stdout) as {
        outfile: string;
        objects: string[];
      };
      expect(typesJson.objects).toEqual(["leads"]);
      const generated = await readFile(
        join(PROJECT_DIR, "generated", "types.ts"),
        "utf8",
      );
      expect(generated).toContain("export interface Leads {");
      expect(generated).toContain("note?: string;");
      expect(generated).toContain("// Generated by @weave-kit/engine");

      const buildRes = await runCli(["build", "--json"]);
      expect(buildRes.code).toBe(0);
      const dist = await stat(join(PROJECT_DIR, "dist", "main.js"));
      expect(dist.isFile()).toBe(true);

      await mkdir(join(PROJECT_DIR, "tests"), { recursive: true });
      await writeFile(
        join(PROJECT_DIR, "tests", "sample.test.mjs"),
        SAMPLE_TEST,
      );
      const testRes = await runCli(["test"]);
      expect(testRes.code).toBe(0);
      expect(testRes.stdout + testRes.stderr).toMatch(/tests\s+1/);
    } finally {
      await pool.query(
        "DROP TABLE IF EXISTS leads, weavekit_metadata, weavekit_meta CASCADE",
      );
      await pool.end();
      await rmProjectDir();
    }
  }, 90000);

  it("object:create scaffolds → schema.json + server.js + types visible", async () => {
    await rmProjectDir();
    await mkdir(PROJECT_DIR, { recursive: true });
    try {
      await scaffoldProject(PROJECT_DIR);
      await linkEngineModule();

      const res = await runCli(["object:create", "purchase_order", "--json"]);
      expect(res.code).toBe(0);
      const createdJson = JSON.parse(res.stdout) as {
        object: string;
        committed: boolean;
      };
      expect(createdJson.object).toBe("purchase_order");
      // inside the monorepo the metadata tree is gitignored → committed:false (graceful)
      expect(typeof createdJson.committed).toBe("boolean");
      const schema = JSON.parse(
        await readFile(
          join(PROJECT_DIR, "objects", "purchase_order", "schema.json"),
          "utf8",
        ),
      );
      expect(schema.name).toBe("purchase_order");
      expect(
        schema.fields.some((f: { primary?: boolean }) => f.primary === true),
      ).toBe(true);
      const server = await readFile(
        join(PROJECT_DIR, "objects", "purchase_order", "server.js"),
        "utf8",
      );
      expect(server).toContain("export function validate()");
      expect(server).toContain("export function beforeUpdate()");

      const typesRes = await runCli(["types", "--json"]);
      expect(typesRes.code).toBe(0);
      const typesJson = JSON.parse(typesRes.stdout) as { objects: string[] };
      expect(typesJson.objects).toEqual(["leads", "purchase_order"]);

      // invalid name rejected
      const bad = await runCli(["object:create", "NotValid"]);
      expect(bad.code).not.toBe(0);
      expect(
        await readFile(
          join(PROJECT_DIR, "objects", "purchase_order", "server.js"),
          "utf8",
        ),
      ).toBeDefined();
    } finally {
      await rmProjectDir();
    }
  }, 120000);

  it("object:create in a business project generates object-level show.client.js + list.client.js + pages/<name>/layout.json", async () => {
    await rmProjectDir();
    await mkdir(PROJECT_DIR, { recursive: true });
    try {
      await scaffoldProject(PROJECT_DIR, { type: "business", git: false });
      await linkEngineModule();

      const res = await runCli(["object:create", "purchase_order", "--json"]);
      expect(res.code).toBe(0);
      const createdJson = JSON.parse(res.stdout) as {
        showClient: string | null;
        listClient: string | null;
        layout: string | null;
      };
      expect(createdJson.showClient).toContain(
        join("pages", "purchase_order", "show.client.js"),
      );
      expect(createdJson.listClient).toContain(
        join("pages", "purchase_order", "list.client.js"),
      );
      expect(createdJson.layout).toContain(
        join("pages", "purchase_order", "show.layout.json"),
      );

      const show = await readFile(
        join(PROJECT_DIR, "pages", "purchase_order", "show.client.js"),
        "utf8",
      );
      expect(show).toContain("export function onLoad()");
      expect(show).toContain("export async function onValidate(action)");
      expect(show).toContain("this.api.objects('supplier').findOne");
      const list = await readFile(
        join(PROJECT_DIR, "pages", "purchase_order", "list.client.js"),
        "utf8",
      );
      expect(list).toContain("export function onLoad()");
      expect(list).toContain("export async function onRowAction(actionName)");
      expect(list).toContain("Return exactly false or throw to block it");
      expect(list).toContain("export function onSelectionChange(rows)");

      // default view layout: show = composed fields > grid(2 columns) > column > field; list = list node columns
      const layout = JSON.parse(
        await readFile(
          join(PROJECT_DIR, "pages", "purchase_order", "show.layout.json"),
          "utf8",
        ),
      );
      const fieldsNode = layout.viewports.desktop.layout[0];
      expect(fieldsNode.type).toBe("fields");
      expect(fieldsNode.columns).toBeUndefined();
      const grid = fieldsNode.children[0];
      expect(grid.type).toBe("grid");
      expect(grid.columns).toHaveLength(2);
      const fieldNames = grid.columns.flatMap((c: { children: Array<{ field: string }> }) =>
        c.children.map((f) => f.field),
      );
      expect(fieldNames).toEqual(["id", "title"]);
      const listLayout = JSON.parse(
        await readFile(
          join(PROJECT_DIR, "pages", "purchase_order", "list.layout.json"),
          "utf8",
        ),
      );
      expect(listLayout.viewports.desktop.layout[0].type).toBe("list");
      expect(listLayout.viewports.desktop.layout[0].columns).toEqual(["id", "title"]);
    } finally {
      await rmProjectDir();
    }
  }, 120000);

  it("field:add: add a field to an object (schema.json update + validation + autoCommit)", async () => {
    await rmProjectDir();
    await mkdir(PROJECT_DIR, { recursive: true });
    try {
      await scaffoldProject(PROJECT_DIR);
      await linkEngineModule();
      await gitIn(["init"]);

      // add enum field
      const res = await runCli([
        "field:add",
        "leads",
        "--name",
        "priority",
        "--type",
        "enum",
        "--options",
        "low,high",
        "--json",
      ]);
      expect(res.code).toBe(0);
      const out = JSON.parse(res.stdout) as {
        object: string;
        field: string;
        type: string;
        committed: boolean;
      };
      expect(out.field).toBe("priority");
      expect(out.type).toBe("enum");
      expect(out.committed).toBe(true);

      const schema = JSON.parse(
        await readFile(
          join(PROJECT_DIR, "objects", "leads", "schema.json"),
          "utf8",
        ),
      );
      const field = schema.fields.find(
        (f: { name: string }) => f.name === "priority",
      );
      expect(field).toEqual({
        name: "priority",
        type: "enum",
        options: ["low", "high"],
      });

      // invalid field name rejected
      const bad = await runCli([
        "field:add",
        "leads",
        "--name",
        "Not Valid",
        "--type",
        "string",
        "--json",
      ]);
      expect(bad.code).not.toBe(0);

      // duplicate field rejected
      const dup = await runCli([
        "field:add",
        "leads",
        "--name",
        "priority",
        "--type",
        "string",
        "--json",
      ]);
      expect(dup.code).not.toBe(0);

      // enum missing options rejected
      const noOpts = await runCli([
        "field:add",
        "leads",
        "--name",
        "status2",
        "--type",
        "enum",
        "--json",
      ]);
      expect(noOpts.code).not.toBe(0);
    } finally {
      await rmProjectDir();
    }
  }, 120000);

  it("module:add/remove: subsystem enable/disable (config source of truth + autoCommit)", async () => {
    await rmProjectDir();
    await mkdir(PROJECT_DIR, { recursive: true });
    try {
      await scaffoldProject(PROJECT_DIR);
      await linkEngineModule();
      await gitIn(["init"]);

      const add = await runCli(["module:add", "audit", "--json"]);
      expect(add.code).toBe(0);
      expect(
        (
          JSON.parse(add.stdout) as {
            module: string;
            enabled: boolean;
            changed: boolean;
          }
        ).enabled,
      ).toBe(true);

      let config = await readFile(
        join(PROJECT_DIR, "weavekit.config.ts"),
        "utf8",
      );
      expect(config).toContain("audit: { enabled: true }");

      const remove = await runCli(["module:remove", "audit", "--json"]);
      expect(remove.code).toBe(0);
      config = await readFile(join(PROJECT_DIR, "weavekit.config.ts"), "utf8");
      expect(config).toContain("audit: { enabled: false }");

      // unimplemented subsystem rejected
      const bad = await runCli(["module:add", "workflow", "--json"]);
      expect(bad.code).not.toBe(0);
      expect(bad.stdout + bad.stderr).toContain("unsupported subsystem");
    } finally {
      await rmProjectDir();
    }
  }, 120000);

  it("migrate: per-object alter — adding fields to an existing table rejected by default; schema.alter: true auto ADD COLUMN + idempotent", async () => {
    await rmProjectDir();
    await mkdir(PROJECT_DIR, { recursive: true });
    const pool = createPool(url!);
    try {
      await scaffoldProject(PROJECT_DIR);
      await linkEngineModule();
      await gitIn(["init"]);

      const mig = await runCli(["migrate"]);
      expect(mig.code).toBe(0);
      expect(await tableExists("leads")).toBe(true);

      // add a field to the existing table (object has no alter → read-only by default)
      let leads = JSON.parse(
        await readFile(
          join(PROJECT_DIR, "objects", "leads", "schema.json"),
          "utf8",
        ),
      );
      leads.fields.push({
        name: "priority",
        type: "enum",
        options: ["low", "high"],
      });
      await writeFile(
        join(PROJECT_DIR, "objects", "leads", "schema.json"),
        JSON.stringify(leads, null, 2),
      );

      // alter:false (default): existing table read-only → rejected
      const strict = await runCli(["migrate", "--json"]);
      expect(strict.code).not.toBe(0);
      expect(strict.stdout + strict.stderr).toContain(
        'field "priority" does not exist as a column',
      );

      // set schema.alter: true → ADD COLUMN applied
      leads = JSON.parse(
        await readFile(
          join(PROJECT_DIR, "objects", "leads", "schema.json"),
          "utf8",
        ),
      );
      leads.alter = true;
      await writeFile(
        join(PROJECT_DIR, "objects", "leads", "schema.json"),
        JSON.stringify(leads, null, 2),
      );
      const alter = await runCli(["migrate", "--json"]);
      expect(alter.code).toBe(0);
      const alterJson = JSON.parse(alter.stdout) as { statements: string[] };
      expect(
        alterJson.statements.some((s) =>
          s.includes('ADD COLUMN "priority" VARCHAR(255)'),
        ),
      ).toBe(true);

      const col = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'priority'",
      );
      expect(col.rows.length).toBe(1);

      // auto commit message carries field-level detail
      const msg = await gitIn(["log", "-1", "--format=%s%n%b"]);
      expect(msg.stdout).toContain("chore(metadata): update schema");
      expect(msg.stdout).toContain("+ priority");

      // idempotent
      const idem = await runCli(["migrate", "--json"]);
      expect(idem.code).toBe(0);
      expect(
        (JSON.parse(idem.stdout) as { statements: string[] }).statements,
      ).toEqual([]);
    } finally {
      await pool.query(
        "DROP TABLE IF EXISTS leads, weavekit_metadata, weavekit_meta CASCADE",
      );
      await pool.end();
      await rmProjectDir();
    }
  }, 90000);

  it("dev hot reload: schema change → sync + rebuild (label change zero DDL) + service available", async () => {
    await rmProjectDir();
    await mkdir(PROJECT_DIR, { recursive: true });
    const port = 3500 + Math.floor(Math.random() * 200);
    const pool = createPool(url!);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await pool.query(
        "DROP TABLE IF EXISTS leads, weavekit_metadata, weavekit_meta CASCADE",
      );
      await scaffoldProject(PROJECT_DIR);
      await linkEngineModule();
      await runCli(["migrate"]);
      expect(await tableExists("leads")).toBe(true);

      const output: string[] = [];
      child = spawn(
        process.execPath,
        ["--import", "tsx", CLI_PATH, "dev", "--port", String(port)],
        {
          cwd: PROJECT_DIR,
          env: { ...process.env, DATABASE_URL: url! },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout?.on("data", (chunk: Buffer) =>
        output.push(chunk.toString()),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        output.push(chunk.toString()),
      );

      const up = await waitFor(async () => {
        try {
          const res = await fetch(
            `http://localhost:${port}/api/objects/leads`,
            {
              headers: { authorization: `Bearer ${API_KEY}` },
              signal: AbortSignal.timeout(2000),
            },
          );
          return res.status === 200;
        } catch {
          return false;
        }
      });
      expect(up).toBe(true);

      await writeFile(
        join(PROJECT_DIR, "objects", "leads", "schema.json"),
        LEADS_V3,
      );
      // dev syncs Git→PG on every reload (per-object alter); label change is zero DDL, rebuild suffices
      const regeneratedReady = await waitFor(async () => {
        try {
          const content = await readFile(
            join(PROJECT_DIR, "generated", "types.ts"),
            "utf8",
          );
          return content.includes("Leads");
        } catch {
          return false;
        }
      }, 60000);
      expect(regeneratedReady).toBe(true);

      // service still available after rebuild (reload sequence: load → types → rebuild engine → listen)
      const served = await waitFor(async () => {
        try {
          const r = await fetch(`http://localhost:${port}/api/objects/leads`, {
            headers: { authorization: `Bearer ${API_KEY}` },
            signal: AbortSignal.timeout(2000),
          });
          return r.status === 200;
        } catch {
          return false;
        }
      }, 60000);
      expect(served).toBe(true);
      expect(output.join("\n")).toContain("listening");
    } finally {
      child?.kill();
      await pool.query(
        "DROP TABLE IF EXISTS leads, weavekit_metadata, weavekit_meta CASCADE",
      );
      await pool.end();
      await rmProjectDir();
    }
  }, 90000);

  it("dev hot reload: schema.alter: true → adding a field auto DDL + auto commit", async () => {
    await rmProjectDir();
    await mkdir(PROJECT_DIR, { recursive: true });
    const port = 3700 + Math.floor(Math.random() * 200);
    const pool = createPool(url!);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await pool.query(
        "DROP TABLE IF EXISTS leads, weavekit_metadata, weavekit_meta CASCADE",
      );
      await scaffoldProject(PROJECT_DIR);
      await linkEngineModule();
      await gitIn(["init"]);

      // let the leads object opt in to automatic additive DDL
      const leads0 = JSON.parse(
        await readFile(
          join(PROJECT_DIR, "objects", "leads", "schema.json"),
          "utf8",
        ),
      );
      leads0.alter = true;
      await writeFile(
        join(PROJECT_DIR, "objects", "leads", "schema.json"),
        JSON.stringify(leads0, null, 2),
      );

      const mig = await runCli(["migrate"]);
      expect(mig.code).toBe(0);
      const headBefore = (await gitIn(["rev-parse", "HEAD"])).stdout.trim();

      const output: string[] = [];
      child = spawn(
        process.execPath,
        ["--import", "tsx", CLI_PATH, "dev", "--port", String(port)],
        {
          cwd: PROJECT_DIR,
          env: { ...process.env, DATABASE_URL: url! },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout?.on("data", (chunk: Buffer) =>
        output.push(chunk.toString()),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        output.push(chunk.toString()),
      );

      const up = await waitFor(async () => {
        try {
          const res = await fetch(
            `http://localhost:${port}/api/objects/leads`,
            {
              headers: { authorization: `Bearer ${API_KEY}` },
              signal: AbortSignal.timeout(2000),
            },
          );
          return res.status === 200;
        } catch {
          return false;
        }
      });
      expect(up).toBe(true);

      // add field → hot reload (per-object alter) auto DDL + commit
      const leads = JSON.parse(
        await readFile(
          join(PROJECT_DIR, "objects", "leads", "schema.json"),
          "utf8",
        ),
      );
      leads.fields.push({
        name: "priority",
        type: "enum",
        options: ["low", "high"],
      });
      await writeFile(
        join(PROJECT_DIR, "objects", "leads", "schema.json"),
        JSON.stringify(leads, null, 2),
      );

      const columnAdded = await waitFor(async () => {
        const col = await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'priority'",
        );
        return col.rows.length === 1;
      }, 60000);
      expect(columnAdded).toBe(true);

      const committed = await waitFor(async () => {
        const head = (await gitIn(["rev-parse", "HEAD"])).stdout.trim();
        return head !== "" && head !== headBefore;
      }, 60000);
      expect(committed).toBe(true);

      const served = await waitFor(async () => {
        try {
          const r = await fetch(`http://localhost:${port}/api/objects/leads`, {
            headers: { authorization: `Bearer ${API_KEY}` },
            signal: AbortSignal.timeout(2000),
          });
          return r.status === 200;
        } catch {
          return false;
        }
      }, 60000);
      expect(served).toBe(true);
    } finally {
      child?.kill();
      await pool.query(
        "DROP TABLE IF EXISTS leads, weavekit_metadata, weavekit_meta CASCADE",
      );
      await pool.end();
      await rmProjectDir();
    }
  }, 120000);
});
