import type { Locale, MessageKey } from '../i18n/index.js';
import { detectCycle, extractRefs, parseFormula } from '../formula/index.js';
import { SchemaError } from '../types/errors.js';
import type {
  BelongsToEdge,
  HasManyEdge,
  MultiRelationEdge,
  ObjectDefinition,
  RelationEdge,
} from '../types/index.js';
import type { FieldTypeRegistry } from '../types/index.js';
import {
  DETAILS_COLUMNS,
  FIELD_TYPES,
  RELATION_KINDS,
  SCALAR_FIELD_TYPES,
} from '../types/values.js';
import { DEFAULT_FIELD_TYPE_REGISTRY, fieldBase, primaryFieldOf, primaryKeyOf } from '../types/index.js';

const SCALAR_TYPE_VALUES: readonly string[] = Object.values(SCALAR_FIELD_TYPES);

export interface BuildGraphOptions {
  /** message locale; defaults to English */
  locale?: Locale;
  /** effective field-type registry (resolves registered `references` hints) */
  fieldTypes?: FieldTypeRegistry;
}

/**
 * Normalized relation graph across all objects.
 *
 * Contains every relation edge (forward declarations + auto-derived reverse
 * edges, see {@link buildGraph}) and provides per-object lookups consumed by
 * REST expand, MCP relationship traversal, etc.
 */
export class RelationGraph {
  readonly edges: RelationEdge[];

  constructor(edges: RelationEdge[]) {
    this.edges = edges;
  }

  /** edges where `object` holds a FK pointing to `target` */
  belongsToFrom(object: string): BelongsToEdge[] {
    return this.edges.filter(
      (e): e is BelongsToEdge =>
        e.kind === RELATION_KINDS.BELONGS_TO && e.object === object,
    );
  }

  /** edges where `object` has many children of `target` */
  hasManyFrom(object: string): HasManyEdge[] {
    return this.edges.filter(
      (e): e is HasManyEdge => e.kind === RELATION_KINDS.HAS_MANY && e.object === object,
    );
  }

  /** edges where `object` references many records of `target` via an array column */
  multiRelationFrom(object: string): MultiRelationEdge[] {
    return this.edges.filter(
      (e): e is MultiRelationEdge =>
        e.kind === RELATION_KINDS.MULTI_RELATION && e.object === object,
    );
  }
}

/** throw a localized schema error (always returns never) */
function graphError(
  locale: Locale | undefined,
  code: MessageKey,
  params: Record<string, unknown>,
): never {
  throw new SchemaError(code, params, locale);
}

/**
 * Validate a set of object definitions and build the relation graph.
 *
 * Performs cross-object checks (relation/details/multiRelation targets exist,
 * details parent PK is string, reserved columns, cross-object formula refs and
 * formula cycles) and derives edges:
 * - `relation` field  → belongsTo edge + reverse hasMany
 * - `details` field   → hasMany (parent_id) + reverse belongsTo
 * - `multiRelation`   → multiRelation edge + reverse hasMany (array)
 */
export function buildGraph(
  defs: ReadonlyMap<string, ObjectDefinition>,
  options?: BuildGraphOptions,
): RelationGraph {
  const locale = options?.locale;
  const names = new Set(defs.keys());
  const edges: RelationEdge[] = [];

  for (const def of defs.values()) {
    for (const field of def.fields) {
      if (field.type === FIELD_TYPES.RELATION || field.type === FIELD_TYPES.PERSON || field.type === FIELD_TYPES.DEPARTMENT) {
        if (!names.has(field.target)) {
          graphError(locale, 'graph.relation.target.missing', {
            object: def.name,
            field: field.name,
            target: field.target,
          });
        }
        edges.push({
          kind: RELATION_KINDS.BELONGS_TO,
          object: def.name,
          target: field.target,
          foreignKey: field.name,
          required: field.required,
          onDelete: field.onDelete,
        });
        edges.push({
          kind: RELATION_KINDS.HAS_MANY,
          object: field.target,
          target: def.name,
          foreignKey: field.name,
        });
      } else if (field.type === FIELD_TYPES.DETAILS) {
        if (field.target === def.name) {
          graphError(locale, 'graph.details.self', {
            object: def.name,
            field: field.name,
          });
        }
        const child = defs.get(field.target);
        if (child === undefined) {
          graphError(locale, 'graph.details.target.missing', {
            object: def.name,
            field: field.name,
            target: field.target,
          });
        }
        const primaryType = childFieldsPrimaryType(def);
        if (primaryType !== undefined && primaryType !== FIELD_TYPES.STRING) {
          graphError(locale, 'graph.details.parentPkString', { object: def.name });
        }
        for (const reserved of Object.values(DETAILS_COLUMNS)) {
          if (child.fields.some((f) => f.name === reserved)) {
            graphError(locale, 'graph.details.reserved', {
              object: child.name,
              column: reserved,
            });
          }
        }
        edges.push({
          kind: RELATION_KINDS.HAS_MANY,
          object: def.name,
          target: field.target,
          foreignKey: DETAILS_COLUMNS.PARENT_ID,
          details: true,
        });
        edges.push({
          kind: RELATION_KINDS.BELONGS_TO,
          object: field.target,
          target: def.name,
          foreignKey: DETAILS_COLUMNS.PARENT_ID,
          details: true,
        });
      } else if (field.type === FIELD_TYPES.MULTI_RELATION) {
        if (field.target === def.name) {
          graphError(locale, 'graph.multiRelation.self', {
            object: def.name,
            field: field.name,
          });
        }
        if (!names.has(field.target)) {
          graphError(locale, 'graph.multiRelation.target.missing', {
            object: def.name,
            field: field.name,
            target: field.target,
          });
        }
        edges.push({
          kind: RELATION_KINDS.MULTI_RELATION,
          object: def.name,
          target: field.target,
          foreignKey: field.name,
          required: field.required,
        });
        edges.push({
          kind: RELATION_KINDS.HAS_MANY,
          object: field.target,
          target: def.name,
          foreignKey: field.name,
          array: true,
        });
      }

      // enum with a data-driven source (`options.from`) must point at a real
      // object + column whose values are strings
      if (field.type === FIELD_TYPES.ENUM && !Array.isArray(field.options)) {
        const { object: refObject, column } = field.options.from;
        const target = defs.get(refObject);
        if (target === undefined) {
          graphError(locale, 'graph.optionsFrom.target.missing', {
            object: def.name,
            field: field.name,
            target: refObject,
          });
        }
        const col = column ?? primaryKeyOf(target)!;
        const targetField = target.fields.find((f) => f.name === col);
        if (targetField === undefined) {
          graphError(locale, 'graph.optionsFrom.column.missing', {
            object: def.name,
            field: field.name,
            target: refObject,
            column: col,
          });
        }
        const refBase = fieldBase(options?.fieldTypes ?? DEFAULT_FIELD_TYPE_REGISTRY, targetField.type);
        if (refBase !== FIELD_TYPES.STRING && refBase !== FIELD_TYPES.TEXT) {
          graphError(locale, 'graph.optionsFrom.type', {
            object: def.name,
            field: field.name,
            target: refObject,
            column: col,
          });
        }
      }

      // registered-type membership (`references`) must point at a real object + column
      const ref = options?.fieldTypes?.get(field.type)?.references;
      if (ref !== undefined) {
        const target = defs.get(ref.object);
        if (target === undefined) {
          graphError(locale, 'graph.references.target.missing', {
            object: def.name,
            field: field.name,
            target: ref.object,
          });
        }
        const column = ref.column ?? primaryKeyOf(target)!;
        if (!target.fields.some((f) => f.name === column)) {
          graphError(locale, 'graph.references.column.missing', {
            object: def.name,
            field: field.name,
            target: ref.object,
            column,
          });
        }
      }
    }
  }

  validateFormulaCrossObject(defs, locale);

  return new RelationGraph(edges);
}

/** look up a field by name within an object definition */
function fieldOf(def: ObjectDefinition, name: string): ObjectDefinition['fields'][number] | undefined {
  return def.fields.find((f) => f.name === name);
}

/**
 * Cross-object formula validation (runs during buildGraph where all objects are known):
 * - resolves relation-target references (`supplier_id.region`) and checks the
 *   referenced field exists and is scalar on the target object
 * - resolves details aggregations (`SUM(lines.qty)`) and checks the child field exists
 * - detects formula cycles spanning multiple objects (formula → formula edges)
 */
function validateFormulaCrossObject(
  defs: ReadonlyMap<string, ObjectDefinition>,
  locale: Locale | undefined,
): void {
  const nodes: string[] = [];
  const edges: [string, string][] = [];
  const formulaKey = (obj: string, field: string) => `${obj}.${field}`;

  for (const def of defs.values()) {
    for (const field of def.fields) {
      if ((field as { formula?: string }).formula === undefined) continue;
      nodes.push(formulaKey(def.name, field.name));
    }
  }

  for (const def of defs.values()) {
    for (const field of def.fields) {
      const formula = (field as { formula?: string }).formula;
      if (formula === undefined) continue;

      let ast;
      try {
        ast = parseFormula(formula);
      } catch (error) {
        // defensive: when buildGraph runs without object validation (registry
        // register bypassed, e.g. tooling/direct calls) never silently skip a
        // broken formula
        graphError(locale, 'formula.syntax', { object: def.name, detail: (error as Error).message });
      }
      const { fields: refs, aggregates } = extractRefs(ast);
      const selfKey = formulaKey(def.name, field.name);

      for (const ref of refs) {
        if (ref.parent === null) continue;
        const parentField = fieldOf(def, ref.parent);
        if (parentField === undefined) continue;
        // defensive fail-closed: a cross-object reference whose parent is not a
        // relation/details field is invalid — do not silently drop the edge
        if (parentField.type !== FIELD_TYPES.RELATION && parentField.type !== FIELD_TYPES.PERSON && parentField.type !== FIELD_TYPES.DEPARTMENT && parentField.type !== FIELD_TYPES.DETAILS) {
          graphError(locale, 'formula.refType', { object: def.name, type: parentField.type, field: ref.parent });
        }
        if (parentField.type === FIELD_TYPES.RELATION || parentField.type === FIELD_TYPES.PERSON || parentField.type === FIELD_TYPES.DEPARTMENT) {
          const targetDef = defs.get(parentField.target);
          const targetField = targetDef === undefined ? undefined : fieldOf(targetDef, ref.name);
          if (targetField === undefined) {
            graphError(locale, 'formula.refMissing', { object: def.name, field: `${ref.parent}.${ref.name}` });
          }
          if (targetField !== undefined && !SCALAR_TYPE_VALUES.includes(targetField.type)) {
            graphError(locale, 'formula.refType', { object: def.name, type: targetField.type, field: `${ref.parent}.${ref.name}` });
          }
          if (targetField !== undefined && targetField.type !== FIELD_TYPES.RELATION && targetField.type !== FIELD_TYPES.DETAILS && targetField.type !== FIELD_TYPES.MULTI_RELATION && targetField.type !== FIELD_TYPES.SEQ_NO) {
            const targetFormula = (targetField as { formula?: string }).formula;
            if (targetFormula !== undefined && targetDef !== undefined) {
              edges.push([selfKey, formulaKey(targetDef.name, ref.name)]);
            }
          }
        } else if (parentField.type === FIELD_TYPES.DETAILS) {
          const childDef = defs.get(parentField.target);
          const childField = childDef === undefined ? undefined : fieldOf(childDef, ref.name);
          if (childField === undefined) {
            graphError(locale, 'formula.aggregateMissing', { object: def.name, field: ref.name, child: parentField.target });
          }
          if (childField !== undefined && (childField as { formula?: string }).formula !== undefined && childDef !== undefined) {
            edges.push([selfKey, formulaKey(childDef.name, ref.name)]);
          }
        }
      }

      for (const agg of aggregates) {
        const parentField = fieldOf(def, agg.parent);
        if (parentField === undefined) continue;
        // defensive fail-closed: aggregation parent must be a details field
        if (parentField.type !== FIELD_TYPES.DETAILS) {
          graphError(locale, 'formula.refType', { object: def.name, type: parentField.type, field: agg.parent });
        }
        const childDef = defs.get(parentField.target);
        if (agg.name === null) continue; // COUNT(lines)
        const childField = childDef === undefined ? undefined : fieldOf(childDef, agg.name);
        if (childField === undefined) {
          graphError(locale, 'formula.aggregateMissing', { object: def.name, field: agg.name, child: parentField.target });
        }
        if (childField !== undefined && (childField as { formula?: string }).formula !== undefined && childDef !== undefined) {
          edges.push([selfKey, formulaKey(childDef.name, agg.name)]);
        }
      }
    }
  }

  const cycle = detectCycle(nodes, edges);
  if (cycle) {
    graphError(locale, 'formula.cycle', { chain: cycle.join(' -> ') });
  }
}

function childFieldsPrimaryType(def: ObjectDefinition): string | undefined {
  return primaryFieldOf(def)?.type;
}
