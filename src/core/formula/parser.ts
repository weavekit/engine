import type { FormulaExpr } from './ast.js';
import { FormulaError } from './errors.js';
import { tokenize, type Token } from './lexer.js';
import {
  AGGREGATE_FNS,
  AST_KINDS,
  FORMULA_BINARY_OPS,
  FORMULA_UNARY_OPS,
  TOKEN_TYPES,
} from './values.js';

const AGGREGATE_FN_VALUES: readonly string[] = Object.values(AGGREGATE_FNS);

const COMPARISON_OPS: readonly string[] = [
  FORMULA_BINARY_OPS.EQ,
  FORMULA_BINARY_OPS.NE,
  FORMULA_BINARY_OPS.GT,
  FORMULA_BINARY_OPS.LT,
  FORMULA_BINARY_OPS.GE,
  FORMULA_BINARY_OPS.LE,
];

const MULTIPLICATIVE_OPS: readonly string[] = [
  FORMULA_BINARY_OPS.MUL,
  FORMULA_BINARY_OPS.DIV,
  FORMULA_BINARY_OPS.MOD,
  FORMULA_BINARY_OPS.CONCAT,
];

/** reserved grammar keywords (and/or/not/true/false/null) */
const KEYWORDS = {
  [FORMULA_BINARY_OPS.AND]: true,
  [FORMULA_BINARY_OPS.OR]: true,
  [FORMULA_UNARY_OPS.NOT]: true,
  true: true,
  false: true,
  null: true,
} as const;

/** recursive-descent parser turning formula source into a FormulaExpr AST */
export class FormulaParser {
  private readonly tokens: Token[];
  private idx = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  private peek(): Token {
    return this.tokens[this.idx]!;
  }

  private next(): Token {
    return this.tokens[this.idx++]!;
  }

  private expectOp(op: string): void {
    const t = this.peek();
    if (t.type !== TOKEN_TYPES.OP || t.value !== op) {
      throw new FormulaError(`expected "${op}" at position ${t.pos}`);
    }
    this.next();
  }

  private expectIdent(what: string): string {
    const t = this.peek();
    if (t.type !== TOKEN_TYPES.IDENT) throw new FormulaError(`expected ${what} at position ${t.pos}`);
    this.next();
    return t.value;
  }

  parse(): FormulaExpr {
    const expr = this.parseOr();
    if (this.peek().type !== TOKEN_TYPES.EOF) {
      throw new FormulaError(`unexpected token at position ${this.peek().pos}`);
    }
    return expr;
  }

  private parseOr(): FormulaExpr {
    let left = this.parseAnd();
    while (this.peek().type === TOKEN_TYPES.IDENT && this.peek().value.toLowerCase() === FORMULA_BINARY_OPS.OR) {
      this.next();
      left = { kind: AST_KINDS.BINARY, op: FORMULA_BINARY_OPS.OR, left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): FormulaExpr {
    let left = this.parseNot();
    while (this.peek().type === TOKEN_TYPES.IDENT && this.peek().value.toLowerCase() === FORMULA_BINARY_OPS.AND) {
      this.next();
      left = { kind: AST_KINDS.BINARY, op: FORMULA_BINARY_OPS.AND, left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): FormulaExpr {
    if (this.peek().type === TOKEN_TYPES.IDENT && this.peek().value.toLowerCase() === FORMULA_UNARY_OPS.NOT) {
      this.next();
      return { kind: AST_KINDS.UNARY, op: FORMULA_UNARY_OPS.NOT, operand: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): FormulaExpr {
    const left = this.parseAdditive();
    const t = this.peek();
    if (
      t.type === TOKEN_TYPES.OP &&
      COMPARISON_OPS.includes(t.value)
    ) {
      this.next();
      return {
        kind: AST_KINDS.BINARY,
        op: t.value as typeof FORMULA_BINARY_OPS[keyof typeof FORMULA_BINARY_OPS],
        left,
        right: this.parseAdditive(),
      };
    }
    return left;
  }

  private parseAdditive(): FormulaExpr {
    let left = this.parseMultiplicative();
    while (
      this.peek().type === TOKEN_TYPES.OP &&
      (this.peek().value === FORMULA_BINARY_OPS.ADD || this.peek().value === FORMULA_BINARY_OPS.SUB)
    ) {
      const op = this.next().value as typeof FORMULA_BINARY_OPS.ADD | typeof FORMULA_BINARY_OPS.SUB;
      left = { kind: AST_KINDS.BINARY, op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): FormulaExpr {
    let left = this.parseUnary();
    while (
      this.peek().type === TOKEN_TYPES.OP &&
      MULTIPLICATIVE_OPS.includes(this.peek().value)
    ) {
      const op = this.next().value as
        | typeof FORMULA_BINARY_OPS.MUL
        | typeof FORMULA_BINARY_OPS.DIV
        | typeof FORMULA_BINARY_OPS.MOD
        | typeof FORMULA_BINARY_OPS.CONCAT;
      left = { kind: AST_KINDS.BINARY, op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): FormulaExpr {
    const t = this.peek();
    if (t.type === TOKEN_TYPES.OP && t.value === FORMULA_BINARY_OPS.SUB) {
      this.next();
      return { kind: AST_KINDS.UNARY, op: FORMULA_UNARY_OPS.NEG, operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FormulaExpr {
    const t = this.peek();

    if (t.type === TOKEN_TYPES.NUMBER) {
      this.next();
      return { kind: AST_KINDS.NUMBER, value: Number(t.value) };
    }
    if (t.type === TOKEN_TYPES.STRING) {
      this.next();
      return { kind: AST_KINDS.STRING, value: t.value };
    }
    if (t.type === TOKEN_TYPES.IDENT) {
      const lower = t.value.toLowerCase();
      if (lower === 'true') {
        this.next();
        return { kind: AST_KINDS.BOOL, value: true };
      }
      if (lower === 'false') {
        this.next();
        return { kind: AST_KINDS.BOOL, value: false };
      }
      if (lower === 'null') {
        this.next();
        return { kind: AST_KINDS.NULL };
      }
      if (lower in KEYWORDS) {
        throw new FormulaError(`unexpected keyword "${t.value}" at position ${t.pos}`);
      }
      return this.parseIdentRef();
    }
    if (t.type === TOKEN_TYPES.OP && t.value === '(') {
      this.next();
      const inner = this.parseOr();
      this.expectOp(')');
      return inner;
    }

    throw new FormulaError(`unexpected token at position ${t.pos}`);
  }

  private parseIdentRef(): FormulaExpr {
    const name = this.expectIdent('identifier');
    const t = this.peek();

    if (t.type === TOKEN_TYPES.OP && t.value === '(') {
      this.next();
      const args: FormulaExpr[] = [];
      if (!(this.peek().type === TOKEN_TYPES.OP && this.peek().value === ')')) {
        args.push(this.parseOr());
        while (this.peek().type === TOKEN_TYPES.OP && this.peek().value === ',') {
          this.next();
          args.push(this.parseOr());
        }
      }
      this.expectOp(')');
      if (AGGREGATE_FN_VALUES.includes(name.toLowerCase())) {
        if (args.length !== 1) throw new FormulaError(`aggregate ${name} requires exactly one reference`);
        const ref = args[0]!;
        if (ref.kind !== AST_KINDS.FIELD) {
          throw new FormulaError(`aggregate ${name} argument must be a field reference`);
        }
        return {
          kind: AST_KINDS.AGGREGATE,
          fn: name.toLowerCase() as typeof AGGREGATE_FNS[keyof typeof AGGREGATE_FNS],
          parent: ref.parent ?? '',
          name: ref.parent === null ? null : ref.name,
        };
      }
      return { kind: AST_KINDS.CALL, fn: name, args };
    }

    if (t.type === TOKEN_TYPES.OP && t.value === '.') {
      this.next();
      const child = this.expectIdent('field name');
      return { kind: AST_KINDS.FIELD, parent: name, name: child };
    }

    return { kind: AST_KINDS.FIELD, parent: null, name };
  }
}

/** parse a formula string into an AST; throws FormulaError on syntax errors */
export function parseFormula(src: string): FormulaExpr {
  return new FormulaParser(src).parse();
}
