import { FormulaError } from './errors.js';
import { FORMULA_BINARY_OPS, TOKEN_TYPES } from './values.js';
import type { TokenType } from './values.js';

export type { TokenType } from './values.js';

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

/** operators tokenized as two characters: == != >= <= */
const TWO_CHAR_OPS = new Set<string>([
  FORMULA_BINARY_OPS.EQ,
  FORMULA_BINARY_OPS.NE,
  FORMULA_BINARY_OPS.GE,
  FORMULA_BINARY_OPS.LE,
]);

/** operators/delimiters tokenized as one character */
const SINGLE_CHAR_OPS = new Set<string>([
  FORMULA_BINARY_OPS.ADD,
  FORMULA_BINARY_OPS.SUB,
  FORMULA_BINARY_OPS.MUL,
  FORMULA_BINARY_OPS.DIV,
  FORMULA_BINARY_OPS.MOD,
  FORMULA_BINARY_OPS.CONCAT,
  FORMULA_BINARY_OPS.GT,
  FORMULA_BINARY_OPS.LT,
  '(',
  ')',
  '.',
  ',',
]);

/** split a formula source string into tokens; throws FormulaError on invalid input */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };

  while (i < src.length) {
    skipWs();
    if (i >= src.length) break;
    const pos = i;
    const ch = src[i]!;

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      tokens.push({ type: TOKEN_TYPES.NUMBER, value: src.slice(i, j), pos });
      i = j;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < src.length) {
        if (src[j] === '\\' && j + 1 < src.length) {
          value += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        value += src[j];
        j++;
      }
      if (j >= src.length) throw new FormulaError(`unterminated string at position ${pos}`);
      tokens.push({ type: TOKEN_TYPES.STRING, value, pos });
      i = j + 1;
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j]!)) j++;
      tokens.push({ type: TOKEN_TYPES.IDENT, value: src.slice(i, j), pos });
      i = j;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ type: TOKEN_TYPES.OP, value: two, pos });
      i += 2;
      continue;
    }
    if (SINGLE_CHAR_OPS.has(ch)) {
      tokens.push({ type: TOKEN_TYPES.OP, value: ch, pos });
      i += 1;
      continue;
    }

    throw new FormulaError(`unexpected character "${ch}" at position ${pos}`);
  }

  tokens.push({ type: TOKEN_TYPES.EOF, value: '', pos: src.length });
  return tokens;
}
