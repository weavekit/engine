import { SCRIPT_HOOKS, type ScriptHook } from './types.js';

/** One named export per match: `export function x` or `export const x`. */
const EXPORT_PATTERN = /export\s+(?:async\s+)?function\s+(\w+)|export\s+(?:const|let|var)\s+(\w+)/g;

const HOOK_VALUES: readonly string[] = Object.values(SCRIPT_HOOKS);

/** Detect supported server hook exports without executing the source. */
export function detectScriptHooks(source: string): ScriptHook[] {
  const found = new Set<ScriptHook>();
  for (const match of source.matchAll(EXPORT_PATTERN)) {
    const name = match[1] ?? match[2];
    if (name !== undefined && HOOK_VALUES.includes(name)) {
      found.add(name as ScriptHook);
    }
  }
  return [...found];
}

/** Server hooks receive their context through `this` and must declare no arguments. */
export function invalidScriptHookSignatures(source: string): ScriptHook[] {
  const invalid = new Set<ScriptHook>();
  for (const hook of detectScriptHooks(source)) {
    const declaration = new RegExp(`export\\s+(?:async\\s+)?function\\s+${hook}\\s*\\(([^)]*)\\)`).exec(source);
    const assignedFunction = new RegExp(
      `export\\s+(?:const|let|var)\\s+${hook}\\s*=\\s*(?:async\\s+)?function(?:\\s+\\w+)?\\s*\\(([^)]*)\\)`,
    ).exec(source);
    const assignedArrow = new RegExp(
      `export\\s+(?:const|let|var)\\s+${hook}\\s*=\\s*(?:async\\s+)?\\(([^)]*)\\)\\s*=>`,
    ).exec(source);
    const singleParameterArrow = new RegExp(
      `export\\s+(?:const|let|var)\\s+${hook}\\s*=\\s*(?:async\\s+)?[A-Za-z_$][\\w$]*\\s*=>`,
    ).test(source);
    const parameters = declaration?.[1] ?? assignedFunction?.[1] ?? assignedArrow?.[1];
    if (parameters === undefined || parameters.trim() !== '' || singleParameterArrow) {
      invalid.add(hook);
    }
  }
  return [...invalid];
}