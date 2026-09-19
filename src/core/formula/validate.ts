import type { FieldRefInfo, FormulaExpr, FormulaType } from './ast.js';
import { FormulaError, FormulaOperandError } from './errors.js';
import { FIELD_TYPES } from '../types/values.js';
import {
  AGGREGATE_FNS,
  AST_KINDS,
  FORMULA_BINARY_OPS,
  FORMULA_EXPECTED,
  FORMULA_FUNCTIONS,
  FORMULA_TYPES,
  FORMULA_UNARY_OPS,
} from './values.js';

export interface ExtractedRefs {
  /** plain field references (parent = relation/details field when cross-object) */
  fields: FieldRefInfo[];
  /** details aggregations: SUM/AVG/MIN/MAX(parent.name) or COUNT(parent) */
  aggregates: { parent: string; name: string | null }[];
}

/** collect all field references and details aggregations from an AST */
export function extractRefs(expr: FormulaExpr): ExtractedRefs {
  const fields: FieldRefInfo[] = [];
  const aggregates: { parent: string; name: string | null }[] = [];

  const walk = (node: FormulaExpr): void => {
    switch (node.kind) {
      case AST_KINDS.FIELD:
        fields.push({ parent: node.parent, name: node.name });
        break;
      case AST_KINDS.AGGREGATE:
        aggregates.push({ parent: node.parent, name: node.name });
        break;
      case AST_KINDS.CALL:
        for (const arg of node.args) walk(arg);
        break;
      case AST_KINDS.UNARY:
        walk(node.operand);
        break;
      case AST_KINDS.BINARY:
        walk(node.left);
        walk(node.right);
        break;
      default:
        break;
    }
  };

  walk(expr);
  return { fields, aggregates };
}

export type FieldTypeOf = (name: string) => FormulaType | undefined;

function isNumeric(t: FormulaType | undefined): boolean {
  return t === FORMULA_TYPES.NUMBER || t === FORMULA_TYPES.INTEGER || t === FORMULA_TYPES.ANY;
}

function isStringLike(t: FormulaType | undefined): boolean {
  return t === FORMULA_TYPES.STRING || t === FORMULA_TYPES.ANY;
}

function isBooleanLike(t: FormulaType | undefined): boolean {
  return t === FORMULA_TYPES.BOOLEAN || t === FORMULA_TYPES.ANY;
}

function opTypeOf(node: FormulaExpr, fieldTypeOf: FieldTypeOf): FormulaType {
  switch (node.kind) {
    case AST_KINDS.NUMBER:
      return FORMULA_TYPES.NUMBER;
    case AST_KINDS.STRING:
      return FORMULA_TYPES.STRING;
    case AST_KINDS.BOOL:
      return FORMULA_TYPES.BOOLEAN;
    case AST_KINDS.NULL:
      return FORMULA_TYPES.ANY;
    case AST_KINDS.FIELD:
      return node.parent === null ? (fieldTypeOf(node.name) ?? FORMULA_TYPES.ANY) : FORMULA_TYPES.ANY;
    case AST_KINDS.AGGREGATE:
      return node.fn === AGGREGATE_FNS.COUNT ? FORMULA_TYPES.INTEGER : FORMULA_TYPES.NUMBER;
    case AST_KINDS.CALL: {
      const fn = node.fn.toLowerCase();
      if (fn === FORMULA_FUNCTIONS.ROUND) return FORMULA_TYPES.NUMBER;
      if (fn === FORMULA_FUNCTIONS.NOW) return FORMULA_TYPES.DATETIME;
      if (fn === FORMULA_FUNCTIONS.CONCAT) return FORMULA_TYPES.STRING;
      if (fn === FORMULA_FUNCTIONS.IF) return opTypeOf(node.args[1] ?? { kind: AST_KINDS.NULL }, fieldTypeOf);
      return FORMULA_TYPES.ANY;
    }
    case AST_KINDS.UNARY:
      return node.op === FORMULA_UNARY_OPS.NEG ? FORMULA_TYPES.NUMBER : FORMULA_TYPES.BOOLEAN;
    case AST_KINDS.BINARY: {
      switch (node.op) {
        case FORMULA_BINARY_OPS.ADD:
        case FORMULA_BINARY_OPS.SUB:
        case FORMULA_BINARY_OPS.MUL:
        case FORMULA_BINARY_OPS.DIV:
        case FORMULA_BINARY_OPS.MOD:
          return FORMULA_TYPES.NUMBER;
        case FORMULA_BINARY_OPS.CONCAT:
          return FORMULA_TYPES.STRING;
        case FORMULA_BINARY_OPS.EQ:
        case FORMULA_BINARY_OPS.NE:
        case FORMULA_BINARY_OPS.GT:
        case FORMULA_BINARY_OPS.LT:
        case FORMULA_BINARY_OPS.GE:
        case FORMULA_BINARY_OPS.LE:
        case FORMULA_BINARY_OPS.AND:
        case FORMULA_BINARY_OPS.OR:
          return FORMULA_TYPES.BOOLEAN;
      }
    }
  }
}

/** statically infer the output type of a formula expression */
export function inferType(expr: FormulaExpr, fieldTypeOf: FieldTypeOf): FormulaType {
  return opTypeOf(expr, fieldTypeOf);
}

/**
 * Walk the AST and verify operator operand types (arithmetic needs numbers,
 * AND/OR need booleans, comparisons need matching types, function arity).
 * Throws FormulaOperandError / FormulaError on violations.
 */
export function checkOperands(expr: FormulaExpr, fieldTypeOf: FieldTypeOf): void {
  const walk = (node: FormulaExpr): void => {
    switch (node.kind) {
      case AST_KINDS.UNARY:
        if (node.op === FORMULA_UNARY_OPS.NEG) {
          if (!isNumeric(opTypeOf(node.operand, fieldTypeOf))) {
            throw new FormulaOperandError(
              FORMULA_UNARY_OPS.NEG,
              FORMULA_EXPECTED.NUMERIC,
              String(opTypeOf(node.operand, fieldTypeOf)),
            );
          }
        } else if (!isBooleanLike(opTypeOf(node.operand, fieldTypeOf))) {
          throw new FormulaOperandError(
            FORMULA_UNARY_OPS.NOT,
            FORMULA_EXPECTED.BOOLEAN,
            String(opTypeOf(node.operand, fieldTypeOf)),
          );
        }
        walk(node.operand);
        break;
      case AST_KINDS.BINARY: {
        const lt = opTypeOf(node.left, fieldTypeOf);
        const rt = opTypeOf(node.right, fieldTypeOf);
        switch (node.op) {
          case FORMULA_BINARY_OPS.ADD:
          case FORMULA_BINARY_OPS.SUB:
          case FORMULA_BINARY_OPS.MUL:
          case FORMULA_BINARY_OPS.DIV:
          case FORMULA_BINARY_OPS.MOD:
            if (!isNumeric(lt) || !isNumeric(rt)) {
              throw new FormulaOperandError(node.op, FORMULA_EXPECTED.NUMERIC, `${lt}/${rt}`);
            }
            break;
          case FORMULA_BINARY_OPS.CONCAT:
            break;
          case FORMULA_BINARY_OPS.GT:
          case FORMULA_BINARY_OPS.LT:
          case FORMULA_BINARY_OPS.GE:
          case FORMULA_BINARY_OPS.LE:
            if (!(isNumeric(lt) && isNumeric(rt)) && !(isStringLike(lt) && isStringLike(rt))) {
              throw new FormulaOperandError(node.op, FORMULA_EXPECTED.NUMERIC_OR_STRING, `${lt}/${rt}`);
            }
            break;
          case FORMULA_BINARY_OPS.AND:
          case FORMULA_BINARY_OPS.OR:
            if (!isBooleanLike(lt) || !isBooleanLike(rt)) {
              throw new FormulaOperandError(node.op, FORMULA_EXPECTED.BOOLEAN, `${lt}/${rt}`);
            }
            break;
          case FORMULA_BINARY_OPS.EQ:
          case FORMULA_BINARY_OPS.NE:
            break;
        }
        walk(node.left);
        walk(node.right);
        break;
      }
      case AST_KINDS.CALL: {
        const fn = node.fn.toLowerCase();
        if (fn === FORMULA_FUNCTIONS.IF) {
          if (node.args.length !== 3) throw new FormulaError('IF requires exactly 3 arguments');
          if (!isBooleanLike(opTypeOf(node.args[0]!, fieldTypeOf))) {
            throw new FormulaOperandError(
              FORMULA_FUNCTIONS.IF,
              FORMULA_EXPECTED.BOOLEAN_CONDITION,
              String(opTypeOf(node.args[0]!, fieldTypeOf)),
            );
          }
        } else if (fn === FORMULA_FUNCTIONS.ROUND) {
          if (node.args.length < 1 || node.args.length > 2) throw new FormulaError('ROUND requires 1 or 2 arguments');
          if (!isNumeric(opTypeOf(node.args[0]!, fieldTypeOf))) {
            throw new FormulaOperandError(
              FORMULA_FUNCTIONS.ROUND,
              FORMULA_EXPECTED.NUMERIC,
              String(opTypeOf(node.args[0]!, fieldTypeOf)),
            );
          }
        } else if (fn === FORMULA_FUNCTIONS.CONCAT || fn === FORMULA_FUNCTIONS.NOW) {
          // no static operand constraints
        } else {
          throw new FormulaError(`unknown function "${node.fn}"`);
        }
        for (const arg of node.args) walk(arg);
        break;
      }
      case AST_KINDS.FIELD:
      case AST_KINDS.AGGREGATE:
      case AST_KINDS.NUMBER:
      case AST_KINDS.STRING:
      case AST_KINDS.BOOL:
      case AST_KINDS.NULL:
        break;
    }
  };

  walk(expr);
}

/** whether a formula's inferred output type fits the declaring field type */
export function typeCompatible(fieldType: string, exprType: FormulaType): boolean {
  switch (fieldType) {
    case FIELD_TYPES.STRING:
    case FIELD_TYPES.TEXT:
      return exprType === FORMULA_TYPES.STRING;
    case FIELD_TYPES.BOOLEAN:
      return exprType === FORMULA_TYPES.BOOLEAN;
    case FIELD_TYPES.INTEGER:
    case FIELD_TYPES.NUMBER:
    case FIELD_TYPES.CURRENCY:
      return exprType === FORMULA_TYPES.NUMBER || exprType === FORMULA_TYPES.INTEGER;
    default:
      return false;
  }
}

/**
 * Detect a cycle in a directed graph (DFS). Returns the cycle chain as node ids,
 * or null if the graph is acyclic. Used for formula dependency cycles.
 */
export function detectCycle(nodes: readonly string[], edges: readonly [string, string][]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const [from, to] of edges) {
    const list = adj.get(from);
    if (list) list.push(to);
  }

  const state = new Map<string, 0 | 1 | 2>(); // 0=visiting 1=visited 2=done
  const stack: string[] = [];

  const dfs = (node: string): string[] | null => {
    const s = state.get(node) ?? 0;
    if (s === 1) {
      const idx = stack.indexOf(node);
      return stack.slice(idx);
    }
    if (s === 2) return null;
    state.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const cycle = dfs(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };

  for (const n of nodes) {
    if ((state.get(n) ?? 0) === 0) {
      const cycle = dfs(n);
      if (cycle) return cycle;
    }
  }
  return null;
}
