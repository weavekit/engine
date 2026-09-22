import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FIELD_TYPES, resolveLabel } from '../../core/index.js';
import type { Locale } from '../../core/index.js';
import type { LayoutField, LayoutFile, LayoutList } from '../../layout-format.js';

/** fields that render as layout blocks, not flat form fields (details → subtable, multiRelation → phase 2) */
const NON_FLAT_FIELD_TYPES = new Set<string>([FIELD_TYPES.DETAILS, FIELD_TYPES.MULTI_RELATION]);

/** minimal field shape the generator reads (name + type + display names) */
export interface DefaultLayoutField {
  name: string;
  type: string;
  /** per-locale display names resolved for the field entry's `label` */
  labels?: Record<string, string>;
}

function flatFields(fields: ReadonlyArray<DefaultLayoutField>): DefaultLayoutField[] {
  return fields.filter((f) => !NON_FLAT_FIELD_TYPES.has(f.type));
}

/**
 * Show/detail default layout (SU-4c, SU-7c): a composite `fields` block holding
 * one 2-column `grid`; every flat field is distributed round-robin across the
 * columns (fields live in grid columns — the strict field container rule).
 * The schema carries no UI grouping metadata (headless line); multi-section
 * arrangements are authored in the designer. A bare `section` cannot hold
 * `field` entries directly (strict rule: fields only live in `fields`).
 */
export function renderShowLayout(
  objectName: string,
  fields: ReadonlyArray<DefaultLayoutField>,
  locale?: Locale,
): LayoutFile {
  const fieldEntries = flatFields(fields).map((f) => ({
    ui_id: f.name,
    type: 'field' as const,
    object: objectName,
    field: f.name,
    // display label resolves from the schema labels, defaulting to the field name
    label: resolveLabel(f.labels, f.name, locale),
  }));
  const column = (uiId: string, children: LayoutField[]) => ({
    ui_id: uiId,
    type: 'column' as const,
    children,
  });
  return {
    viewports: {
      desktop: {
        mode: 'vertical',
        layout: [
          {
            ui_id: 'fields-main',
            type: 'fields',
            label: 'Main',
            children: [
              {
                ui_id: 'fields-main-grid',
                type: 'grid',
                gap: 16,
                rowGap: 12,
                columns: [
                  column('fields-main-c0', fieldEntries.filter((_, i) => i % 2 === 0)),
                  column('fields-main-c1', fieldEntries.filter((_, i) => i % 2 === 1)),
                ],
              },
            ],
          },
        ],
      },
    },
  };
}

/**
 * List default layout (SU-7c): a first-class `list` node with every listable
 * flat field as a column — drives the object's collection page (list.client.js).
 */
export function renderListLayout(objectName: string, fields: ReadonlyArray<DefaultLayoutField>): LayoutFile {
  const list: LayoutList = {
    ui_id: 'list',
    type: 'list',
    object: objectName,
    columns: flatFields(fields).map((f) => f.name),
  };
  return {
    viewports: {
      desktop: {
        mode: 'vertical',
        layout: [list],
      },
    },
  };
}

export interface DefaultLayoutWriteResult {
  /** relative paths written/expected under the project (`pages/<object>/<view>.layout.json`) */
  paths: string[];
  /** true when at least one file was newly written (never overwrites existing files) */
  written: boolean;
}

async function writeIfMissing(dir: string, relPath: string, content: string): Promise<boolean> {
  const path = join(dir, relPath);
  try {
    await access(path);
    return false;
  } catch {
    // missing → generate below
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return true;
}

/**
 * Write the object's default page layouts — `pages/<object>/show.layout.json`
 * (show/detail) and `pages/<object>/list.layout.json` (collection) — mirroring
 * `objects/<name>/`. **Never overwrites** existing files (users may have edited
 * them). Returns the relative paths and whether anything was written.
 */
export async function writeDefaultLayout(
  schemaDir: string,
  objectName: string,
  fields: ReadonlyArray<DefaultLayoutField>,
  locale?: Locale,
): Promise<DefaultLayoutWriteResult> {
  const showPath = join('pages', objectName, 'show.layout.json');
  const listPath = join('pages', objectName, 'list.layout.json');
  const wroteShow = await writeIfMissing(schemaDir, showPath, `${JSON.stringify(renderShowLayout(objectName, fields, locale), null, 2)}\n`);
  const wroteList = await writeIfMissing(schemaDir, listPath, `${JSON.stringify(renderListLayout(objectName, fields), null, 2)}\n`);
  return { paths: [showPath, listPath], written: wroteShow || wroteList };
}

/** backfill missing default page layouts for a set of objects (dev); returns written paths */
export async function backfillDefaultViews(
  schemaDir: string,
  objects: Array<{ name: string; fields: ReadonlyArray<DefaultLayoutField> }>,
  locale?: Locale,
): Promise<string[]> {
  const written: string[] = [];
  for (const object of objects) {
    const result = await writeDefaultLayout(schemaDir, object.name, object.fields, locale);
    if (result.written) written.push(...result.paths);
  }
  return written;
}
