import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ATTR_KINDS,
  FIELD_TYPE_NAME_PATTERN,
  buildFieldTypeRegistry,
  type FieldTypeRegistration,
  type FieldTypeRegistry,
} from '../../core/index.js';
import { FIELD_TYPES } from '../../core/index.js';
import { SchemaError } from '../../core/index.js';
import type { Locale } from '../../core/index.js';

/**
 * Field-type registration loader (`fieldTypes.dir`). Dynamic-imports a
 * directory of modules whose default export is a {@link FieldTypeRegistration}
 * or an array of them. Registrations are project-local and committed to Git,
 * so schemas stay reproducible across environments.
 *
 * Validation is structural + fail-closed: the effective name must be namespaced
 * (`<ns>_<name>`), must not collide with a built-in type or another
 * registration, and `base` must be a value primitive (not a structural type).
 */

const FIELD_TYPE_FILE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts'];

/** value primitives a registered type may inherit from */
const ALLOWED_BASES: readonly string[] = [
  FIELD_TYPES.STRING,
  FIELD_TYPES.TEXT,
  FIELD_TYPES.INTEGER,
  FIELD_TYPES.NUMBER,
  FIELD_TYPES.CURRENCY,
  FIELD_TYPES.BOOLEAN,
  FIELD_TYPES.DATETIME,
  FIELD_TYPES.DATE,
  FIELD_TYPES.JSON,
  FIELD_TYPES.RELATION,
];

const NAME_RE = new RegExp(FIELD_TYPE_NAME_PATTERN);
const BUILTIN_NAMES = new Set<string>(Object.values(FIELD_TYPES));

export interface LoadedFieldType {
  /** absolute path of the module that produced the registration */
  path: string;
  /** normalized registration (effective name = `<namespace>_<name>`) */
  registration: FieldTypeRegistration;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const ATTR_NAME_RE = /^[a-z][a-zA-Z0-9_]*$/;
const ATTR_KIND_VALUES: readonly string[] = Object.values(ATTR_KINDS);

function invalid(detail: string, locale?: Locale): SchemaError {
  return new SchemaError('fieldtype.invalid', { detail }, locale);
}

/** validate the declared `attrs` spec map (shape + kinds), fail-closed at load */
function validateAttrSpecs(raw: Record<string, unknown>, name: string, locale?: Locale): void {
  const attrs = raw.attrs;
  if (attrs === undefined) return;
  if (!isPlainObject(attrs)) throw new SchemaError('fieldtype.attr.invalid', { name, attr: '', detail: 'attrs must be an object of AttrSpec' }, locale);
  for (const [attr, spec] of Object.entries(attrs)) {
    if (!ATTR_NAME_RE.test(attr)) {
      throw new SchemaError('fieldtype.attr.invalid', { name, attr, detail: 'attr name must be camel/snake case' }, locale);
    }
    if (!isPlainObject(spec)) {
      throw new SchemaError('fieldtype.attr.invalid', { name, attr, detail: 'spec must be an object' }, locale);
    }
    const kind = spec.type;
    if (typeof kind !== 'string' || !ATTR_KIND_VALUES.includes(kind)) {
      throw new SchemaError('fieldtype.attr.invalid', { name, attr, detail: `unknown type "${String(kind)}"` }, locale);
    }
    if (kind === ATTR_KINDS.ENUM) {
      const values = spec.values;
      if (!Array.isArray(values) || values.length === 0 || !values.every((v) => typeof v === 'string')) {
        throw new SchemaError('fieldtype.attr.invalid', { name, attr, detail: 'enum requires non-empty string `values`' }, locale);
      }
    }
    if (spec.default !== undefined) {
      const valid = ((): boolean => {
        switch (kind) {
          case ATTR_KINDS.STRING:
            return typeof spec.default === 'string';
          case ATTR_KINDS.NUMBER:
            return typeof spec.default === 'number' && !Number.isNaN(spec.default);
          case ATTR_KINDS.INTEGER:
            return typeof spec.default === 'number' && Number.isInteger(spec.default);
          case ATTR_KINDS.BOOLEAN:
            return typeof spec.default === 'boolean';
          case ATTR_KINDS.JSON:
            return true;
          case ATTR_KINDS.ENUM:
            return typeof spec.default === 'string' && (spec.values as string[]).includes(spec.default);
          default:
            return false;
        }
      })();
      if (!valid) {
        throw new SchemaError('fieldtype.attr.invalid', { name, attr, detail: `default is not a valid ${kind}` }, locale);
      }
    }
  }
}

/** validate `storage` / `validate` hooks (non-relation value bases only) */
function validateHooks(raw: Record<string, unknown>, name: string, relationLike: boolean, locale?: Locale): void {
  if (raw.storage !== undefined) {
    if (relationLike) throw invalid(`"${name}" storage is not allowed on relation-like types`, locale);
    if (!isPlainObject(raw.storage) || typeof raw.storage.pgType !== 'function') {
      throw new SchemaError('fieldtype.storage.invalid', { name, detail: 'storage must be { pgType: (field) => string }' }, locale);
    }
  }
  if (raw.validate !== undefined) {
    if (relationLike) throw invalid(`"${name}" validate is not allowed on relation-like types`, locale);
    if (typeof raw.validate !== 'function') {
      throw new SchemaError('fieldtype.validate.invalid', { name, detail: 'validate must be a function' }, locale);
    }
  }
}

/** normalize + validate one raw registration into its effective name */
export function normalizeFieldTypeRegistration(raw: unknown, locale?: Locale): FieldTypeRegistration {
  if (!isPlainObject(raw)) throw invalid('a field-type registration must be a plain object', locale);

  const { namespace, name, base } = raw;
  if (typeof name !== 'string' || name.length === 0) {
    throw new SchemaError('fieldtype.name.invalid', { name: String(name ?? '') }, locale);
  }
  if (typeof base !== 'string' || !ALLOWED_BASES.includes(base)) {
    throw new SchemaError('fieldtype.base.invalid', { name, base: String(base ?? ''), allowed: ALLOWED_BASES.join('/') }, locale);
  }

  // auto-apply the namespace prefix (idempotent if the author already prefixed)
  let effective = name;
  let ns: string | undefined;
  if (namespace !== undefined) {
    if (typeof namespace !== 'string' || namespace.length === 0) {
      throw invalid(`"${name}" namespace must be a non-empty string`, locale);
    }
    ns = namespace;
    effective = name.startsWith(`${namespace}_`) ? name : `${namespace}_${name}`;
  }

  if (!NAME_RE.test(effective)) {
    throw new SchemaError('fieldtype.name.invalid', { name: effective }, locale);
  }
  if (BUILTIN_NAMES.has(effective)) {
    throw new SchemaError('fieldtype.name.reserved', { name: effective }, locale);
  }

  // reverse hint (introspect): non-empty pgType, only on non-relation value bases
  const reverse = raw.reverse;
  if (reverse !== undefined) {
    if (!isPlainObject(reverse) || typeof reverse.pgType !== 'string' || reverse.pgType.length === 0) {
      throw invalid(`"${effective}" reverse must be { pgType: string, precision?, scale? }`, locale);
    }
    if (base === FIELD_TYPES.RELATION || raw.relationLike === true) {
      throw invalid(`"${effective}" reverse is not allowed on relation-like types`, locale);
    }
  }

  const relationLike = base === FIELD_TYPES.RELATION || raw.relationLike === true;
  validateAttrSpecs(raw, effective, locale);
  validateHooks(raw, effective, relationLike, locale);

  const registration: FieldTypeRegistration = { ...(raw as object), name: effective } as FieldTypeRegistration;
  if (ns !== undefined) registration.namespace = ns;
  return registration;
}

async function collectFieldTypeFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (FIELD_TYPE_FILE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(join(dir, entry.name));
  }
}

/** load + validate every registration module under a directory (missing dir → error) */
export async function loadFieldTypesDir(
  dir: string,
  options: { locale?: Locale } = {},
): Promise<LoadedFieldType[]> {
  let isDir = false;
  try {
    isDir = (await stat(dir)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new SchemaError('fieldtype.dir.missing', { dir }, options.locale);
  }

  const files: string[] = [];
  await collectFieldTypeFiles(dir, files);

  const loaded: LoadedFieldType[] = [];
  const seen = new Set<string>();
  for (const file of files.sort()) {
    const mod = await import(pathToFileURL(file).href);
    const raw = (mod as { default?: unknown }).default;
    if (raw === undefined) throw invalid(`"${file}" has no default export`, options.locale);
    const entries = Array.isArray(raw) ? raw : [raw];
    for (const entry of entries) {
      const registration = normalizeFieldTypeRegistration(entry, options.locale);
      if (seen.has(registration.name) || BUILTIN_NAMES.has(registration.name)) {
        throw new SchemaError('fieldtype.name.reserved', { name: registration.name }, options.locale);
      }
      seen.add(registration.name);
      loaded.push({ path: file, registration });
    }
  }
  return loaded;
}

/** load a `field-types/` dir (if present) + inline entries into an effective registry */
export async function resolveFieldTypeRegistry(options: {
  dir?: string;
  entries?: readonly FieldTypeRegistration[];
  locale?: Locale;
}): Promise<FieldTypeRegistry> {
  const extra: FieldTypeRegistration[] = [];
  if (options.dir !== undefined) {
    const loaded = await loadFieldTypesDir(options.dir, { locale: options.locale });
    extra.push(...loaded.map((l) => l.registration));
  }
  for (const entry of options.entries ?? []) {
    extra.push(normalizeFieldTypeRegistration(entry, options.locale));
  }
  return buildFieldTypeRegistry(extra);
}
