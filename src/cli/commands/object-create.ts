import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FIELD_TYPES, SCHEMA_FORMAT_VERSION } from "../../core/index.js";
import { autoCommit } from "../../runtime/git/index.js";
import { loadConfig } from "../load-config.js";
import type { ObjectCreateOptions } from "../types/index.js";

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

/** initial object scaffold: primary key + a human-readable title field */
function renderSchema(name: string): { source: string; fields: Array<{ name: string; type: string }> } {
  const object = {
    schemaVersion: SCHEMA_FORMAT_VERSION,
    name,
    labels: {
      en: name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    },
    fields: [
      { name: "id", type: FIELD_TYPES.STRING, primary: true },
      { name: "title", type: FIELD_TYPES.STRING, required: true },
    ],
  };
  return { source: `${JSON.stringify(object, null, 2)}\n`, fields: object.fields };
}

const SERVER_JS = `// Server-side lifecycle hooks for this object.
// Hooks run in a sandbox: no require / process / fetch — only \`this\`:
//   this.record    current record (pre-write); null on create
//   this.changes   fields being written
//   this.user      { id, name, roles }
//   this.db        db.objects(name) / db.query(sql, params)
//   this.services  email / slack / webhook (bridged to the engine process)
// Throw to abort (validate / beforeUpdate / beforeDelete); errors in after*
// hooks become non-fatal warnings on the response.

export function validate() {
  // cross-field / cross-table rules — throw to abort the write
}

export function beforeUpdate() {
  // last chance to modify this.changes; return the changes to persist:
  // return this.changes;
}

export function afterUpdate() {
  // side effects: notifications, touching related records
}

export function beforeDelete() {
  // check related data — throw to abort
}

export function afterDelete() {
  // cleanup / logging
}
`;


/**
 * `weave object:create <name>` — scaffold `objects/<name>/schema.json` +
 * `server.js` (sandbox hooks) and auto-commit the new metadata tree.
 * For `business` projects the object-level UI hook templates are also generated
 * at `pages/<name>/show.client.js` (record surface) and
 * `pages/<name>/list.client.js` (list surface) — the object's UI assets live
 * beside its page layouts under `pages/<name>/`.
 */
export async function objectCreate(
  cwd: string,
  name: string,
  options: ObjectCreateOptions,
): Promise<void> {
  const p = options.printer;
  if (!SNAKE_CASE.test(name)) {
    p.error(`object name must be snake_case: "${name}"`);
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const objectDir = join(schemaDir, "objects", name);

  await mkdir(objectDir, { recursive: true });
  const schemaPath = join(objectDir, "schema.json");
  const scriptPath = join(objectDir, "server.js");
  const schema = renderSchema(name);
  await writeFile(schemaPath, schema.source, { flag: "wx" });
  await writeFile(scriptPath, SERVER_JS, { flag: "wx" });

  const files = [`objects/${name}/schema.json`, `objects/${name}/server.js`];

  const commit = await autoCommit({
    dir: schemaDir,
    paths: ["objects"],
  });
  p.log(
    `created object "${name}" (${files.join(", ")})${commit.committed ? ` · committed ${commit.sha}` : ""}`,
  );
  p.data({
    object: name,
    schema: schemaPath,
    script: scriptPath,
    committed: commit.committed,
  });
}
