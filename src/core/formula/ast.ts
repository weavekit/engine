import type { AST_KINDS } from './values.js';
import type { AggregateFn, FormulaBinaryOp, FormulaUnaryOp } from './values.js';

export type { AggregateFn, FormulaBinaryOp, FormulaType, FormulaUnaryOp } from './values.js';

/** union of every formula AST node kind */
export type FormulaExpr =
  | { kind: typeof AST_KINDS.NUMBER; value: number }
  | { kind: typeof AST_KINDS.STRING; value: string }
  | { kind: typeof AST_KINDS.BOOL; value: boolean }
  | { kind: typeof AST_KINDS.NULL }
  /** field reference. parent = relation/details field name (cross ref); null = same-object field */
  | { kind: typeof AST_KINDS.FIELD; parent: string | null; name: string }
  /** details aggregation: SUM/AVG/MIN/MAX(parent.name) or COUNT(parent) */
  | { kind: typeof AST_KINDS.AGGREGATE; fn: AggregateFn; parent: string; name: string | null }
  /** function call: IF/ROUND/NOW/CONCAT */
  | { kind: typeof AST_KINDS.CALL; fn: string; args: FormulaExpr[] }
  /** unary minus / logical NOT */
  | { kind: typeof AST_KINDS.UNARY; op: FormulaUnaryOp; operand: FormulaExpr }
  /** binary operation with two operands */
  | { kind: typeof AST_KINDS.BINARY; op: FormulaBinaryOp; left: FormulaExpr; right: FormulaExpr };

/** a field reference inside a formula: (parent relation/details field, field name) */
export interface FieldRefInfo {
  parent: string | null;
  name: string;
}
