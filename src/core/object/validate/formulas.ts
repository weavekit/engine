import {
  FORMULA_EXCLUDED_ATTRS,
  FORMULA_TYPES,
  FormulaOperandError,
  checkOperands,
  detectCycle,
  extractRefs,
  inferType,
  parseFormula,
  typeCompatible,
} from '../../formula/index.js';
import type { FormulaType } from '../../formula/index.js';
import type { FieldDefinition } from '../../types/index.js';
import { FIELD_TYPES } from '../../types/values.js';
import { fail, type Vc } from './primitives.js';

/**
 * Same-object formula validation: exclusions, reference existence, operand/type
 * checks and local formula-formula cycle detection.
 */
export function validateFormulas(fields: FieldDefinition[], vc: Vc): void {
  const formulaFields = fields.filter((f) => (f as { formula?: string }).formula !== undefined);
  if (formulaFields.length === 0) return;

  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const fieldTypeOf = (name: string): FormulaType | undefined => {
    const f = fieldByName.get(name);
    if (f === undefined) return undefined;
    switch (f.type) {
      case FIELD_TYPES.STRING:
      case FIELD_TYPES.TEXT:
      case FIELD_TYPES.UUID:
        return FORMULA_TYPES.STRING;
      case FIELD_TYPES.INTEGER:
      case FIELD_TYPES.NUMBER:
      case FIELD_TYPES.CURRENCY:
        return FORMULA_TYPES.NUMBER;
      case FIELD_TYPES.BOOLEAN:
        return FORMULA_TYPES.BOOLEAN;
      default:
        return undefined;
    }
  };

  for (const field of formulaFields) {
    const formula = (field as { formula: string }).formula;
    const fieldType = field.type;

    for (const attr of Object.values(FORMULA_EXCLUDED_ATTRS)) {
      if ((field as unknown as Record<string, unknown>)[attr] !== undefined) {
        fail(vc, 'formula.excludedAttr', { attr });
      }
    }

    let ast;
    try {
      ast = parseFormula(formula);
    } catch (err) {
      fail(vc, 'formula.syntax', { detail: (err as Error).message });
    }
    const { fields: refs, aggregates } = extractRefs(ast);

    for (const ref of refs) {
      const target = fieldByName.get(ref.parent ?? ref.name);
      if (target === undefined) {
        fail(vc, 'formula.refMissing', { field: ref.parent ?? ref.name });
      }
      const referenced = ref.parent === null ? target : fieldByName.get(ref.parent);
      if (referenced !== undefined && ref.parent === null) {
        if (
          referenced.type === FIELD_TYPES.RELATION ||
          referenced.type === FIELD_TYPES.DETAILS ||
          referenced.type === FIELD_TYPES.MULTI_RELATION ||
          referenced.type === FIELD_TYPES.SEQ_NO
        ) {
          fail(vc, 'formula.refType', { type: referenced.type, field: ref.name });
        }
      } else if (referenced !== undefined && ref.parent !== null) {
        if (referenced.type !== FIELD_TYPES.RELATION && referenced.type !== FIELD_TYPES.DETAILS) {
          fail(vc, 'formula.refType', { type: referenced.type, field: ref.parent });
        }
      }
    }

    for (const agg of aggregates) {
      const parent = fieldByName.get(agg.parent);
      if (parent === undefined) {
        fail(vc, 'formula.refMissing', { field: agg.parent });
      } else if (parent.type !== FIELD_TYPES.DETAILS) {
        fail(vc, 'formula.refType', { type: parent.type, field: agg.parent });
      }
    }

    try {
      checkOperands(ast, fieldTypeOf);
    } catch (err) {
      if (err instanceof FormulaOperandError) {
        fail(vc, 'formula.operandType', { op: err.op, expected: err.expected, got: err.got });
      }
      fail(vc, 'formula.syntax', { detail: (err as Error).message });
    }

    const exprType = inferType(ast, fieldTypeOf);
    if (exprType !== 'any' && !typeCompatible(fieldType, exprType)) {
      fail(vc, 'formula.typeMismatch', { got: exprType, expected: fieldType });
    }
  }

  const nodes = formulaFields.map((f) => f.name);
  const edges: [string, string][] = [];
  for (const field of formulaFields) {
    const formula = (field as { formula: string }).formula;
    let ast;
    try {
      ast = parseFormula(formula);
    } catch {
      continue;
    }
    const { fields: refs } = extractRefs(ast);
    for (const ref of refs) {
      if (ref.parent === null && nodes.includes(ref.name)) {
        edges.push([field.name, ref.name]);
      }
    }
  }
  const cycle = detectCycle(nodes, edges);
  if (cycle) fail(vc, 'formula.cycle', { chain: cycle.join(' -> ') });
}
