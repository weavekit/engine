import type { FormulaExpr } from './ast.js';
import {
  AGGREGATE_FNS,
  AST_KINDS,
  FORMULA_BINARY_OPS,
  FORMULA_FUNCTIONS,
  FORMULA_UNARY_OPS,
} from './values.js';

export interface FormulaEvalContext {
  /** same-object record values: field name -> value */
  record: Record<string, unknown>;
  /** resolve a cross reference (parent relation/details field, child field) -> value or null */
  resolveRef(parent: string, name: string): unknown;
  /** resolve aggregation values for a details child (name = sub-field or null for COUNT) */
  resolveAggregate(parent: string, name: string | null): unknown[];
  /** current timestamp for NOW() */
  now(): Date;
}

/** true for finite numbers (used to filter non-numeric values in aggregates) */
function isNumeric(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** apply an aggregate function over raw values; empty/null-safe per spec */
function applyAggregate(fn: string, values: unknown[]): unknown {
  switch (fn) {
    case AGGREGATE_FNS.COUNT:
      return values.length;
    case AGGREGATE_FNS.SUM: {
      const sum = values.reduce<number>((acc, v) => acc + (isNumeric(v) ? v : 0), 0);
      return values.length === 0 ? null : sum;
    }
    case AGGREGATE_FNS.AVG: {
      const nums = values.filter(isNumeric);
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    case AGGREGATE_FNS.MIN: {
      const nums = values.filter(isNumeric);
      return nums.length === 0 ? null : Math.min(...nums);
    }
    case AGGREGATE_FNS.MAX: {
      const nums = values.filter(isNumeric);
      return nums.length === 0 ? null : Math.max(...nums);
    }
    default:
      return null;
  }
}

/**
 * Evaluate a formula AST against a record via the provided context.
 *
 * The evaluator is data-source-agnostic: same-object values come from
 * `ctx.record`, cross references and aggregations are fetched through the
 * `ctx` callbacks, so the same AST works over any backing store (the
 * write path plugs PG lookups in). Follows the null semantics from Schema spec v0.7.
 */
export function evaluate(expr: FormulaExpr, ctx: FormulaEvalContext): unknown {
  switch (expr.kind) {
    case AST_KINDS.NUMBER:
    case AST_KINDS.STRING:
    case AST_KINDS.BOOL:
      return expr.value;
    case AST_KINDS.NULL:
      return null;
    case AST_KINDS.FIELD: {
      if (expr.parent === null) {
        const v = ctx.record[expr.name];
        return v === undefined ? null : v;
      }
      return ctx.resolveRef(expr.parent, expr.name);
    }
    case AST_KINDS.AGGREGATE: {
      const values = ctx.resolveAggregate(expr.parent, expr.name);
      return applyAggregate(expr.fn, values);
    }
    case AST_KINDS.CALL: {
      const fn = expr.fn.toLowerCase();
      if (fn === FORMULA_FUNCTIONS.IF) {
        const cond = evaluate(expr.args[0]!, ctx);
        return cond ? evaluate(expr.args[1]!, ctx) : evaluate(expr.args[2]!, ctx);
      }
      if (fn === FORMULA_FUNCTIONS.ROUND) {
        const v = evaluate(expr.args[0]!, ctx);
        const digits = expr.args[1] === undefined ? 0 : (evaluate(expr.args[1], ctx) as number);
        if (!isNumeric(v)) return null;
        const factor = 10 ** digits;
        return Math.round(v * factor) / factor;
      }
      if (fn === FORMULA_FUNCTIONS.NOW) return ctx.now();
      if (fn === FORMULA_FUNCTIONS.CONCAT) {
        return expr.args.map((a) => {
          const v = evaluate(a, ctx);
          return v === null || v === undefined ? '' : String(v);
        }).join('');
      }
      return null;
    }
    case AST_KINDS.UNARY: {
      if (expr.op === FORMULA_UNARY_OPS.NEG) {
        const v = evaluate(expr.operand, ctx);
        return isNumeric(v) ? -v : null;
      }
      return Boolean(evaluate(expr.operand, ctx));
    }
    case AST_KINDS.BINARY: {
      const left = evaluate(expr.left, ctx);
      const right = evaluate(expr.right, ctx);

      switch (expr.op) {
        case FORMULA_BINARY_OPS.CONCAT:
          return `${left === null || left === undefined ? '' : String(left)}${right === null || right === undefined ? '' : String(right)}`;
        case FORMULA_BINARY_OPS.AND:
          return Boolean(left) && Boolean(right);
        case FORMULA_BINARY_OPS.OR:
          return Boolean(left) || Boolean(right);
        case FORMULA_BINARY_OPS.ADD:
        case FORMULA_BINARY_OPS.SUB:
        case FORMULA_BINARY_OPS.MUL:
        case FORMULA_BINARY_OPS.DIV:
        case FORMULA_BINARY_OPS.MOD: {
          if (!isNumeric(left) || !isNumeric(right)) return null;
          switch (expr.op) {
            case FORMULA_BINARY_OPS.ADD:
              return left + right;
            case FORMULA_BINARY_OPS.SUB:
              return left - right;
            case FORMULA_BINARY_OPS.MUL:
              return left * right;
            case FORMULA_BINARY_OPS.DIV:
              return right === 0 ? null : left / right;
            case FORMULA_BINARY_OPS.MOD:
              return right === 0 ? null : left % right;
          }
          return null;
        }
        case FORMULA_BINARY_OPS.EQ:
          return left === null || right === null ? false : left === right;
        case FORMULA_BINARY_OPS.NE:
          return left === null || right === null ? false : left !== right;
        case FORMULA_BINARY_OPS.GT:
        case FORMULA_BINARY_OPS.LT:
        case FORMULA_BINARY_OPS.GE:
        case FORMULA_BINARY_OPS.LE: {
          if (left === null || right === null) return false;
          if (isNumeric(left) && isNumeric(right)) {
            switch (expr.op) {
              case FORMULA_BINARY_OPS.GT:
                return left > right;
              case FORMULA_BINARY_OPS.LT:
                return left < right;
              case FORMULA_BINARY_OPS.GE:
                return left >= right;
              case FORMULA_BINARY_OPS.LE:
                return left <= right;
            }
          }
          const ls = String(left);
          const rs = String(right);
          switch (expr.op) {
            case FORMULA_BINARY_OPS.GT:
              return ls > rs;
            case FORMULA_BINARY_OPS.LT:
              return ls < rs;
            case FORMULA_BINARY_OPS.GE:
              return ls >= rs;
            case FORMULA_BINARY_OPS.LE:
              return ls <= rs;
          }
          return false;
        }
      }
    }
  }
}
