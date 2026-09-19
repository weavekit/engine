/** base error for formula lexing/parsing/validation failures (English detail text) */
export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

/** structured operand type violation (operator, expected, got) for localized messages */
export class FormulaOperandError extends FormulaError {
  readonly op: string;
  readonly expected: string;
  readonly got: string;

  constructor(op: string, expected: string, got: string) {
    super(`operator ${op} requires ${expected} operands, got ${got}`);
    this.name = 'FormulaOperandError';
    this.op = op;
    this.expected = expected;
    this.got = got;
  }
}
