import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FIELD_TYPES, SCHEMA_FORMAT_VERSION } from "../../core/index.js";
import { autoCommit } from "../../runtime/git/index.js";
import { writeDefaultLayout } from "./default-view.js";
import { loadConfig } from "../load-config.js";
import { PROJECT_TYPES } from "../types/index.js";
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

const SHOW_CLIENT_JS = `// Client-side hooks for this object's record surface (show detail + edit
// form) — object-scoped (loaded at runtime by @weave-kit/ui via
// GET /api/objects/<object>/scripts/show.client). Isolated per instance.
// Hooks run in the browser. They only shape the UX; the server remains the
// security boundary (server.js validate / RBAC are authoritative).
// Context is a single \`this\`:
//   this.form     form instance: setValue / getValue / toggleDisplay /
//                 toggleReadOnly / toggleRequired / showHint / setButtonState
//   this.record   current record data ({} when creating)
//   this.changes  fields the user edited this session
//   this.user     optional { id, name, roles } supplied by the UI host
//   this.actions  action buttons available on the form (hide/show/disable)
//   this.api      @weave-kit/client instance scoped to the current permissions
//   this.block    optional layout block ui_id
//
// Reserved for future use; the loader imports the module but does not call it.
export function onLoad() {
  // Future: dynamic defaults and role-based action visibility.
}

// Runs after a user or script field change. It may be async. Calls to
// this.form.setValue trigger onFieldChange again, enabling explicit cascades.
export async function onFieldChange(fieldName) {
  //   if (fieldName === 'supplier_id') {
  //     const supplier = await this.api.objects('supplier').findOne(
  //       this.form.getValue('supplier_id')
  //     );
  //     this.form.setValue('tax_rate', supplier.default_tax_rate);
  //   }
}

// Reserved for future use.
export function onActionClick(actionName) {
  // Future: intercept/confirm/custom action flows.
}

// Runs before create/save. Return exactly false or throw to stop this
// submission; every other return value allows it. This is UX validation only;
// server.js and RBAC remain authoritative.
export async function onValidate(action) {
  //   if (action === 'save' && this.form.getValue('amount') > 50000) {
  //     return confirm('Amount over 50,000 - save anyway?');
  //   }
  //   return true;
}

// Reserved for future use.
export function beforeSubmit(action) {
  // Future: lock buttons or add fields immediately before transport.
}

// Reserved for future use.
export function afterSubmit(action, result) {
  // Future: unlock buttons, notify, or navigate after the response.
}
`;

const LIST_CLIENT_JS = `// Client-side hooks for this object's list surface (tables) — object-scoped
// (loaded at runtime by @weave-kit/ui via GET /api/objects/<object>/scripts/list.client).
// Hooks run in the browser. They only shape the UX; the server remains the
// security boundary (server.js validate / RBAC are authoritative).
// Context is a single \`this\`:
//   this.list     page/pageSize/sort/filter/records getters plus
//                 setPage/setSort/setFilter/refetch
//   this.records  rows of the current page
//   this.row      the row for onRowAction
//   this.user     optional { id, name, roles } supplied by the UI host
//   this.api      @weave-kit/client instance scoped to the current permissions
//   this.block    optional layout block ui_id
//
// Runs once after this list instance's first successful data response. The
// list values are an invocation snapshot; its setters update that snapshot and
// the UI. Subsequent query/live refreshes do not rerun this hook.
export function onLoad() {
  // this.list.setSort({ key: 'created_at', desc: true });
}

// Runs before built-in show/edit. Return exactly false or throw to block it;
// every other return value allows the action.
export async function onRowAction(actionName) {
  // if (actionName === 'edit' && this.row.locked) return false;
  // return true;
}

// Reserved for future use.
export function onCellRender(fieldName, value) {
  // Future: customize one rendered cell.
}

export function onFilter(filter) {
  // Future: observe or intercept filter changes.
}

export function onSort(sort) {
  // Future: observe or intercept sort changes.
}

export function onSelectionChange(rows) {
  // Future: react to selected rows.
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
  let showClientPath: string | undefined;
  let listClientPath: string | undefined;
  let layoutPath: string | undefined;
  if (config.projectType === PROJECT_TYPES.BUSINESS) {
    const pageDir = join(schemaDir, "pages", name);
    await mkdir(pageDir, { recursive: true });
    showClientPath = join(pageDir, "show.client.js");
    listClientPath = join(pageDir, "list.client.js");
    await writeFile(showClientPath, SHOW_CLIENT_JS, { flag: "wx" });
    await writeFile(listClientPath, LIST_CLIENT_JS, { flag: "wx" });
    files.push(
      `pages/${name}/show.client.js`,
      `pages/${name}/list.client.js`,
    );
    const layout = await writeDefaultLayout(schemaDir, name, schema.fields, config.locale);
    layoutPath = layout.paths[0];
    if (layout.written) files.push(...layout.paths);
  }

  const commit = await autoCommit({
    dir: schemaDir,
    paths:
      config.projectType === PROJECT_TYPES.BUSINESS
        ? ["objects", "pages"]
        : undefined,
  });
  p.log(
    `created object "${name}" (${files.join(", ")})${commit.committed ? ` · committed ${commit.sha}` : ""}`,
  );
  if (config.projectType === PROJECT_TYPES.BUSINESS) {
    p.log(
      "note: *.client.js and pages/<name>/layout.json are experimental groundwork for a future product line (no in-project renderer yet)",
    );
  }
  p.data({
    object: name,
    schema: schemaPath,
    script: scriptPath,
    showClient: showClientPath ?? null,
    listClient: listClientPath ?? null,
    layout: layoutPath ?? null,
    committed: commit.committed,
  });
}
