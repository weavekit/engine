import { describe, it, expect } from '../helpers/test.js';
import kleur from 'kleur';
import { createPrinter } from '../../src/cli/render.js';

// deterministic output: disable ANSI colors for these assertions
kleur.enabled = false;

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => {
    lines.push(String(message));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('createPrinter — human-readable mode', () => {
  it('kv outputs key-value block', () => {
    const printer = createPrinter({ json: false });
    const lines = capture(() => printer.kv([{ objects: 2 }, { 'dry-run': 'true' }]));
    expect(lines).toContain('objects: 2');
    expect(lines).toContain('dry-run: true');
  });

  it('kv skips undefined values', () => {
    const printer = createPrinter({ json: false });
    const lines = capture(() => printer.kv([{ a: 'x', b: undefined }]));
    expect(lines).toContain('a: x');
    expect(lines).not.toContain('b:');
  });

  it('table renders as cli-table3 aligned table', () => {
    const printer = createPrinter({ json: false });
    const lines = capture(() => printer.table([['object', 'status'], ['lead', 'applied'], ['customer', 'in-sync']]));
    const out = lines.join('\n');
    // header + rows present
    for (const cell of ['object', 'status', 'lead', 'applied', 'customer', 'in-sync']) {
      expect(out).toContain(cell);
    }
    // bordered box (cli-table3 layout)
    expect(out).toContain('┌');
    expect(out).toContain('│');
  });

  it('data is a no-op in human mode', () => {
    const printer = createPrinter({ json: false });
    const lines = capture(() => printer.data({ a: 1 }));
    expect(lines).toHaveLength(0);
  });
});

describe('createPrinter — JSON mode', () => {
  it('data outputs structured JSON', () => {
    const printer = createPrinter({ json: true });
    const lines = capture(() => printer.data({ objects: ['lead'], applied: [] }));
    expect(lines.join('\n')).toContain('"objects": [');
  });

  it('kv/table/log suppressed in JSON mode', () => {
    const printer = createPrinter({ json: true });
    const lines = capture(() => {
      printer.kv([{ a: '1' }]);
      printer.table([['a'], ['1']]);
      printer.log('hello');
    });
    expect(lines).toHaveLength(0);
  });
});
