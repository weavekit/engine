/**
 * Built-in prompt names — single source of truth (`as const`, see AGENTS.md).
 *
 * The engine's built-in prompts are **schema-derived and identity-filtered**
 * (see `catalog.ts`); they teach an agent to use the engine's own tool surface.
 * A host provider must not reuse these names (`isBuiltinPromptName`).
 */
export const BUILTIN_PROMPTS = {
  /** meta guide: list_objects → describe_object → search_records */
  EXPLORE: 'explore_data',
  /** embed one object's descriptor + tool guidance */
  OBJECT_GUIDE: 'object_guide',
  /** how to build a `search_records` filter for one object */
  BUILD_FILTER: 'build_filter',
  /** how to fire a workflow transition on one object */
  RUN_WORKFLOW: 'run_workflow',
} as const;
export type BuiltinPrompt = typeof BUILTIN_PROMPTS[keyof typeof BUILTIN_PROMPTS];

const builtinNames: readonly string[] = Object.values(BUILTIN_PROMPTS);

/** true when a name is a reserved built-in prompt (a provider may not override it) */
export function isBuiltinPromptName(name: string): boolean {
  return builtinNames.includes(name);
}
