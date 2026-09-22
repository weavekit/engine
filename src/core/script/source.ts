import { SCRIPT_HOOKS, type ScriptHook } from './types.js';

/** One named export per match: `export function x` or `export const x`. */
const EXPORT_PATTERN = /export\s+(?:async\s+)?function\s+(\w+)|export\s+(?:const|let|var)\s+(\w+)/g;

/** Named export list: `export { a, b as c }` (optionally `from '…'`, which the sandbox can't import). */
const EXPORT_LIST_PATTERN = /\bexport\s*\{([^}]*)\}(?:\s*from\s*['"][^'"]*['"])?/g;

const HOOK_VALUES: readonly string[] = Object.values(SCRIPT_HOOKS);

/** exported name of one `export { … }` entry (`local as exported` → `exported`). */
function exportedName(entry: string): string {
  const parts = entry.trim().split(/\s+as\s+/);
  return (parts[1] ?? parts[0] ?? '').trim();
}

/** Detect supported server hook exports without executing the source. */
export function detectScriptHooks(source: string): ScriptHook[] {
  const found = new Set<ScriptHook>();
  for (const match of source.matchAll(EXPORT_PATTERN)) {
    const name = match[1] ?? match[2];
    if (name !== undefined && HOOK_VALUES.includes(name)) {
      found.add(name as ScriptHook);
    }
  }
  for (const match of source.matchAll(EXPORT_LIST_PATTERN)) {
    for (const entry of (match[1] ?? '').split(',')) {
      const name = exportedName(entry);
      if (name !== '' && HOOK_VALUES.includes(name)) {
        found.add(name as ScriptHook);
      }
    }
  }
  return [...found];
}

/**
 * Rewrite ESM export syntax to `__exports.*` assignments for evaluation inside
 * the sandbox isolate (which has no module system). Handles declaration exports
 * (`export function/const/…`), `export default …`, and named export lists
 * (`export { a, b as c }`). A list re-exported `from '…'` becomes an assignment
 * to an undefined binding — a fail-closed `ReferenceError`, since the sandbox
 * cannot import modules.
 */
export function transformScriptSource(source: string): string {
  return source
    .replace(EXPORT_LIST_PATTERN, (_match, body: string) =>
      body
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          const [local, exported] = entry.split(/\s+as\s+/).map((s) => s.trim());
          return `;__exports.${exported ?? local} = ${local};`;
        })
        .join(''),
    )
    .replace(/export\s+(async\s+)?function\s+(\w+)/g, '__exports.$2 = $1function $2')
    .replace(/export\s+(const|let|var)\s+(\w+)/g, '__exports.$2 = ')
    .replace(/export\s+default\s+/g, '__exports.default = ');
}

/** Server hooks receive their context through `this` and must declare no arguments. */
export function invalidScriptHookSignatures(source: string): ScriptHook[] {
  const invalid = new Set<ScriptHook>();
  for (const hook of detectScriptHooks(source)) {
    // `export function hook(…)` | `export const hook = function/(…) =>` |
    // `function hook(…)` | `const hook = function/(…) =>` (declaration may be
    // separate from the export in the `export { hook }` list form)
    const declaration =
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${hook}\\s*\\(([^)]*)\\)`).exec(source) ??
      new RegExp(`(?:^|[;{}\\s])function\\s+${hook}\\s*\\(([^)]*)\\)`).exec(source);
    const assignedFunction =
      new RegExp(
        `(?:export\\s+)?(?:const|let|var)\\s+${hook}\\s*=\\s*(?:async\\s+)?function(?:\\s+\\w+)?\\s*\\(([^)]*)\\)`,
      ).exec(source);
    const assignedArrow =
      new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${hook}\\s*=\\s*(?:async\\s+)?\\(([^)]*)\\)\\s*=>`).exec(source);
    const singleParameterArrow = new RegExp(
      `(?:export\\s+)?(?:const|let|var)\\s+${hook}\\s*=\\s*(?:async\\s+)?[A-Za-z_$][\\w$]*\\s*=>`,
    ).test(source);
    const parameters = declaration?.[1] ?? assignedFunction?.[1] ?? assignedArrow?.[1];
    if (parameters === undefined || parameters.trim() !== '' || singleParameterArrow) {
      invalid.add(hook);
    }
  }
  return [...invalid];
}
