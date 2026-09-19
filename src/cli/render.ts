import Table from 'cli-table3';
import kleur from 'kleur';

/**
 * CLI output contract. `createPrinter` emits key/value, an aligned table, or
 * raw JSON (`--json`). Tables/keys use `cli-table3`/`kleur`; inline coloring in
 * commands goes through `kleur` directly (JSON mode never reaches the colored
 * `log()`). The engine's own errors stay i18n'd; CLI messages are plain English.
 */
export interface CliPrinter {
  /** whether `--json` was requested (machine-readable output) */
  readonly json: boolean;
  /** key/value block for each row; blank line between rows */
  kv(rows: Record<string, string | number | undefined | boolean>[]): void;
  /** aligned table (first row = header) */
  table(rows: string[][]): void;
  /** emit a raw structured payload in JSON mode (no-op otherwise) */
  data(payload: unknown): void;
  /** plain log line (suppressed in JSON mode) */
  log(message: string): void;
  /** log to stderr (shown in both modes) */
  error(message: string): void;
}

/**
 * Build a CLI printer — key/value, aligned table, or raw JSON (`--json`).
 */
export function createPrinter(options: { json: boolean }): CliPrinter {
  if (options.json) {
    return {
      json: true,
      kv() {},
      table() {},
      data(payload) {
        console.log(JSON.stringify(payload, null, 2));
      },
      log() {},
      error(message) {
        console.error(message);
      },
    };
  }

  return {
    json: false,
    kv(rows) {
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
          if (value !== undefined) console.log(`${kleur.dim(key)}: ${value}`);
        }
        console.log('');
      }
    },
    table(rows) {
      if (rows.length === 0) return;
      const [head, ...body] = rows;
      const table = new Table({
        head: (head ?? []).map((cell) => kleur.cyan(cell)),
        // disable cli-table3's own styling; kleur handles the head color
        style: { head: [], border: [] },
      });
      for (const row of body) table.push(row);
      console.log(table.toString());
    },
    data() {},
    log(message) {
      console.log(message);
    },
    error(message) {
      console.error(message);
    },
  };
}
