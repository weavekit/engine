/**
 * Single source of truth for formula/expression language constants.
 *
 * All values are `as const` and drive their union types via
 * `typeof X[keyof typeof X]`, so the expression vocabulary (operators,
 * aggregate functions, built-in functions, AST kinds, token types, inferred
 * output types) lives in exactly one place.
 */

/** details aggregation functions: SUM(parent.name) / COUNT(parent) */
export const AGGREGATE_FNS = {
  SUM: 'sum',
  COUNT: 'count',
  AVG: 'avg',
  MIN: 'min',
  MAX: 'max',
} as const;
export type AggregateFn = typeof AGGREGATE_FNS[keyof typeof AGGREGATE_FNS];

/** binary operators in the expression language */
export const FORMULA_BINARY_OPS = {
  ADD: '+',
  SUB: '-',
  MUL: '*',
  DIV: '/',
  MOD: '%',
  EQ: '==',
  NE: '!=',
  GT: '>',
  LT: '<',
  GE: '>=',
  LE: '<=',
  CONCAT: '&',
  AND: 'and',
  OR: 'or',
} as const;
export type FormulaBinaryOp = typeof FORMULA_BINARY_OPS[keyof typeof FORMULA_BINARY_OPS];

/** unary operators */
export const FORMULA_UNARY_OPS = {
  NEG: 'neg',
  NOT: 'not',
} as const;
export type FormulaUnaryOp = typeof FORMULA_UNARY_OPS[keyof typeof FORMULA_UNARY_OPS];

/** built-in function names (user functions are unknown to the engine) */
export const FORMULA_FUNCTIONS = {
  IF: 'if',
  ROUND: 'round',
  NOW: 'now',
  CONCAT: 'concat',
} as const;
export type FormulaFunction = typeof FORMULA_FUNCTIONS[keyof typeof FORMULA_FUNCTIONS];

/** statically inferred output type of a formula */
export const FORMULA_TYPES = {
  NUMBER: 'number',
  INTEGER: 'integer',
  STRING: 'string',
  BOOLEAN: 'boolean',
  DATETIME: 'datetime',
  ANY: 'any',
} as const;
export type FormulaType = typeof FORMULA_TYPES[keyof typeof FORMULA_TYPES];

/** AST node kinds (discriminant of FormulaExpr) */
export const AST_KINDS = {
  NUMBER: 'number',
  STRING: 'string',
  BOOL: 'bool',
  NULL: 'null',
  FIELD: 'field',
  AGGREGATE: 'aggregate',
  CALL: 'call',
  UNARY: 'unary',
  BINARY: 'binary',
} as const;
export type AstKind = typeof AST_KINDS[keyof typeof AST_KINDS];

/** lexer token types */
export const TOKEN_TYPES = {
  NUMBER: 'number',
  STRING: 'string',
  IDENT: 'ident',
  OP: 'op',
  EOF: 'eof',
} as const;
export type TokenType = typeof TOKEN_TYPES[keyof typeof TOKEN_TYPES];

/** expected-operand labels embedded in operand-type error messages */
export const FORMULA_EXPECTED = {
  NUMERIC: 'numeric',
  BOOLEAN: 'boolean',
  NUMERIC_OR_STRING: 'numeric or string',
  BOOLEAN_CONDITION: 'boolean condition',
} as const;
export type FormulaExpected = typeof FORMULA_EXPECTED[keyof typeof FORMULA_EXPECTED];

/** field attributes a formula field must not carry (schema spec: formula excludes required/unique/default/constraints) */
export const FORMULA_EXCLUDED_ATTRS = {
  REQUIRED: 'required',
  UNIQUE: 'unique',
  DEFAULT: 'default',
  MIN: 'min',
  MAX: 'max',
  PRECISION: 'precision',
  MIN_LENGTH: 'minLength',
  MAX_LENGTH: 'maxLength',
  REGEX: 'regex',
} as const;
export type FormulaExcludedAttr = typeof FORMULA_EXCLUDED_ATTRS[keyof typeof FORMULA_EXCLUDED_ATTRS];
